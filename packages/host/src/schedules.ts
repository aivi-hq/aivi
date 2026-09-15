import { randomUUID } from 'node:crypto';
import type { Job, LoadedConfig, Report, Schedule, ScheduleItem, ScheduleRequest, ScheduleResponse } from '@aivi/core';
import { nextOccurrences, parseDue, scheduleSchema, taskSchema } from '@aivi/core';
import type { Destinations } from './destinations.ts';
import { SESSION_DESTINATION } from './destinations.ts';
import type { OpenCodeClient } from './opencode.ts';
import type { ScheduleEntry, Store } from './store.ts';

/** A request the host will not carry out; the message is meant for the agent to relay. */
export class ScheduleRefused extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface ScheduleHandlerDeps {
  store: Store;
  loaded: LoadedConfig;
  destinations: Destinations;
  opencode: () => Promise<OpenCodeClient>;
  /** Called after the queue changed so the host loop dispatches without waiting. */
  wake?: () => void;
  now?: () => number;
}
export type ScheduleHandler = (request: ScheduleRequest) => Promise<ScheduleResponse>;

const hostTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const when = (at: number, timezone: string) =>
  new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: timezone }).format(at);

/**
 * `aivi_schedule` on the host side. Agent jobs default to the calling agent in
 * the calling directory; the caller's session decides whether it may schedule
 * at all (a job's own session may not, unless a conversation adopted it).
 */
export function createScheduleHandler(deps: ScheduleHandlerDeps): ScheduleHandler {
  const { store, loaded, destinations } = deps;
  const now = deps.now ?? Date.now;
  const wake = deps.wake ?? (() => {});
  const settings = loaded.config.scheduler.agentSchedules;

  return async request => {
    if (!settings)
      throw new ScheduleRefused(
        'Agent-created schedules are disabled by the operator (scheduler.agentSchedules is false).',
        403,
      );
    switch (request.action) {
      case 'create':
        return create(request);
      case 'list':
        return { summary: describeList(items()), items: items() };
      case 'pause':
      case 'resume': {
        const enabled = request.action === 'resume';
        const entry = withRefusal(() => store.setScheduleEnabled(request.id, enabled, now()));
        wake();
        const item = scheduleItem(entry);
        return {
          summary: `${enabled ? 'Resumed' : 'Paused'} ${item.title} (${item.id}).${enabled ? ` Next: ${item.next[0]}.` : ''}`,
          items: [item],
        };
      }
      case 'remove': {
        const oneOff = store.agentOneOffs().find(j => j.id === request.id);
        if (oneOff) {
          store.cancelQueued(oneOff.id, now());
          return { summary: `Removed the one-off ${titleOf(oneOff.task)} (${oneOff.id}).`, items: [] };
        }
        const entry = withRefusal(() => store.schedule(request.id));
        withRefusal(() => store.removeSchedule(request.id, now()));
        return { summary: `Removed ${entry.spec.title ?? titleOf(entry.spec.task)} (${request.id}).`, items: [] };
      }
      case 'run': {
        const job = withRefusal(() => store.runSchedule(request.id, now()));
        wake();
        return {
          summary: `Queued one run of ${request.id} now (job ${job.id.slice(0, 8)}). Its outcome is reported like a scheduled one.`,
          items: [scheduleItem(store.schedule(request.id))],
        };
      }
    }
  };

  async function create(input: Extract<ScheduleRequest, { action: 'create' }>): Promise<ScheduleResponse> {
    if (!settings) throw new Error('unreachable');
    if ((input.prompt === undefined) === (input.command === undefined))
      throw new ScheduleRefused('Give exactly one of prompt (an agent job) or command (a script job).');
    if ((input.at === undefined) === (input.cron === undefined))
      throw new ScheduleRefused('Give exactly one of at (one-off) or cron (recurring).');
    if (input.report === 'channel' && !input.channel)
      throw new ScheduleRefused('report "channel" needs the channel id.');

    const client = await deps.opencode().catch(error => {
      throw new ScheduleRefused(
        `OpenCode is not reachable: ${error instanceof Error ? error.message : String(error)}`,
        503,
      );
    });
    const session = await client.session.get({ sessionID: input.sessionId }).catch(() => {
      throw new ScheduleRefused(`Unknown session ${input.sessionId}.`, 404);
    });
    const origin = (session.metadata as { aivi?: { origin?: string } } | undefined)?.aivi?.origin;
    if ((origin === 'job' || origin === 'dreaming') && !destinations.ownsSession(input.sessionId))
      throw new ScheduleRefused('Jobs do not create jobs. Ask a person in a conversation to schedule this.', 403);

    const directory = input.directory ?? session.location.directory;
    const agent = input.agent ?? session.agent;
    let task: Schedule['task'];
    if (input.prompt !== undefined) {
      if (!agent) throw new ScheduleRefused('This session has no agent; pass agent explicitly.');
      // Verified against OpenCode 2.0.3: `agent.list` with a location sees agents defined under that
      // directory's .opencode/, where `agent.get` does not.
      const agents = await client.agent.list({ location: { directory } }).catch(() => ({ data: [] }));
      if (!agents.data.some(a => a.id === agent))
        throw new ScheduleRefused(`No agent "${agent}" exists in ${directory}.`);
      task = taskSchema.parse({
        kind: 'opencode.prompt',
        agent,
        directory,
        prompt: input.prompt,
        ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
      });
    } else {
      task = taskSchema.parse({
        kind: 'shell',
        command: input.command,
        cwd: input.cwd ?? directory,
        ...(input.env ? { env: input.env } : {}),
        ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
      });
    }

    let report: Report | null = null;
    if (input.report === 'channel') {
      // A conversation asking for a post defaults to its own platform; a native session must say which.
      const module = input.module ?? destinations.ownerOf(input.sessionId);
      if (!module)
        throw new ScheduleRefused('report "channel" needs the module (for example "discord") from a native session.');
      report = { to: 'channel', module, channel: input.channel!, on: input.on };
    } else if (input.report === 'session') report = { to: SESSION_DESTINATION, session: input.sessionId, on: input.on };
    if (report) {
      const refusal = destinations.refuse(report);
      if (refusal) throw new ScheduleRefused(`${refusal}. Use report "none" or a channel aivi may post to.`);
    }

    const existing = store.schedules().filter(s => s.source === 'agent').length + store.agentOneOffs().length;
    if (existing >= settings.max)
      throw new ScheduleRefused(
        `The limit of ${settings.max} agent-created schedules is reached; remove one first.`,
        409,
      );

    const at = now();
    const timezone = input.timezone ?? hostTimezone();
    if (input.at !== undefined) {
      const due = parseDueOrRefuse(input.at, at);
      const job = store.enqueue(
        task,
        settings.resource,
        `agent:${input.sessionId}:${input.messageId ?? randomUUID()}`,
        at,
        report,
        {
          due,
          reason: `agent:${input.sessionId}`,
        },
      );
      wake();
      const item = oneOffItem(job, timezone);
      return {
        summary: `Created a one-off ${item.title} (${item.id}) for ${item.next[0]}. ${reportText(report)}`,
        items: [item],
      };
    }
    const parsed = scheduleSchema.safeParse({
      id: `agent-${randomUUID().slice(0, 8)}`,
      ...(input.title ? { title: input.title } : {}),
      cron: input.cron,
      timezone,
      resource: settings.resource,
      task,
      ...(report ? { report } : {}),
    });
    if (!parsed.success)
      throw new ScheduleRefused(`Invalid cron expression or timezone: "${input.cron}" in ${timezone}.`);
    const entry = store.addSchedule(parsed.data, at);
    wake();
    const item = scheduleItem(entry);
    return {
      summary: `Created ${item.title} (${item.id}): cron ${parsed.data.cron} in ${timezone}. Next: ${item.next.join(', ')}. ${reportText(report)}`,
      items: [item],
    };
  }

  function items(): ScheduleItem[] {
    return [
      ...store
        .schedules()
        .filter(s => s.source === 'agent')
        .map(scheduleItem),
      ...store.agentOneOffs().map(j => oneOffItem(j, hostTimezone())),
    ];
  }

  function scheduleItem(entry: ScheduleEntry): ScheduleItem {
    const { spec } = entry;
    const last = store.lastRun(spec.id);
    return {
      id: spec.id,
      kind: 'schedule',
      task: spec.task.kind === 'shell' ? 'script' : 'agent',
      title: spec.title ?? titleOf(spec.task),
      when: `cron ${spec.cron} (${spec.timezone})`,
      enabled: entry.enabled,
      next: entry.enabled ? nextOccurrences(spec.cron, spec.timezone, now(), 3).map(t => when(t, spec.timezone)) : [],
      lastRun: last
        ? {
            state: last.state,
            at: new Date(last.finishedAt ?? last.startedAt ?? last.createdAt).toISOString(),
            error: last.error,
          }
        : null,
      report: reportText(spec.report ?? null),
    };
  }

  function oneOffItem(job: Job, timezone: string): ScheduleItem {
    return {
      id: job.id,
      kind: 'one-off',
      task: job.task.kind === 'shell' ? 'script' : 'agent',
      title: titleOf(job.task),
      when: new Date(job.scheduledFor).toISOString(),
      enabled: job.state === 'queued',
      next: [when(job.scheduledFor, timezone)],
      lastRun: null,
      report: reportText(job.report),
    };
  }
}

function parseDueOrRefuse(at: string, now: number): number {
  try {
    return parseDue(at, now);
  } catch (error) {
    throw new ScheduleRefused(error instanceof Error ? error.message : String(error));
  }
}

function withRefusal<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    throw new ScheduleRefused(error instanceof Error ? error.message : String(error), 404);
  }
}

function titleOf(task: Schedule['task']): string {
  if (task.kind === 'opencode.prompt') {
    const line = task.prompt.split('\n').find(l => l.trim()) ?? task.prompt;
    return `"${line.length > 60 ? `${line.slice(0, 59)}…` : line}"`;
  }
  if (task.kind === 'shell') return `\`${task.command.join(' ').slice(0, 60)}\``;
  return task.kind;
}

function reportText(report: Report | null): string {
  if (!report) return 'Results are not reported anywhere; `aivi jobs show` has them.';
  const when = report.on === 'failure' ? 'Only failures are' : 'Results are';
  if (report.to === SESSION_DESTINATION) return `${when} brought back into this conversation.`;
  return `${when} posted to ${report.module} ${report.channel}.`;
}

function describeList(items: ScheduleItem[]): string {
  if (!items.length) return 'No agent-created schedules or one-offs exist.';
  return items
    .map(
      i =>
        `${i.id}: ${i.title}, ${i.when}${i.enabled ? '' : ' (paused)'}${i.next.length ? `, next ${i.next[0]}` : ''}${i.lastRun ? `, last run ${i.lastRun.state}` : ''}`,
    )
    .join('\n');
}

import { randomUUID } from 'node:crypto';
import type { Job, JobItem, JobRequest, JobResponse, LoadedConfig, Report } from '@aivi/core';
import { formatInstant, jobSchema, nextOccurrences, parseDue, userTaskSchema } from '@aivi/core';
import type { Channels } from './channel/router.ts';
import type { OpenCodeClient } from './opencode.ts';
import { SESSION_DESTINATION } from './reports.ts';
import type { JobEntry, Store } from './store.ts';

/** A request the host will not carry out; the message is meant for the agent to relay. */
export class JobRefused extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.status = status;
  }
}

export interface JobHandlerDeps {
  store: Store;
  loaded: LoadedConfig;
  channels: Channels;
  opencode: () => Promise<OpenCodeClient>;
  /** Called after the queue changed so the host loop dispatches without waiting. */
  wake?: () => void;
  now?: () => number;
}
export type JobHandler = (request: JobRequest) => Promise<JobResponse>;

const hostTimezone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;

/**
 * `aivi_jobs` on the host side. Agent jobs default to the calling agent in
 * the calling directory; the caller's session decides whether it may schedule
 * at all (a job's own session may not, unless a conversation adopted it).
 */
export function createJobHandler(deps: JobHandlerDeps): JobHandler {
  const { store, loaded, channels } = deps;
  const now = deps.now ?? Date.now;
  const wake = deps.wake ?? (() => {});
  const settings = loaded.config.scheduler.agentSchedules;

  return async request => {
    if (!settings)
      throw new JobRefused('Agent-created jobs are disabled by the operator (scheduler.agentSchedules is false).', 403);
    switch (request.action) {
      case 'create':
        return create(request);
      case 'list':
        return { summary: describeList(items()), items: items() };
      case 'pause':
      case 'resume': {
        const enabled = request.action === 'resume';
        const entry = withRefusal(() => store.setJobEnabled(request.id, enabled, now()));
        wake();
        const item = jobItem(entry);
        return {
          summary: `${enabled ? 'Resumed' : 'Paused'} ${item.title} (${item.id}).${enabled && item.next.length ? ` Next: ${item.next[0]}.` : ''}`,
          items: [item],
        };
      }
      case 'remove': {
        const entry = withRefusal(() => store.job(request.id));
        withRefusal(() => store.removeJob(request.id, now()));
        return { summary: `Removed ${entry.spec.title ?? titleOf(entry.spec.task)} (${request.id}).`, items: [] };
      }
      case 'run': {
        const run = withRefusal(() => store.runJob(request.id, now()));
        wake();
        return {
          summary: `Queued one run of ${request.id} now (run ${run.id.slice(0, 8)}). Its outcome is reported like a scheduled one.`,
          items: [jobItem(store.job(request.id))],
        };
      }
    }
  };

  type CreateInput = Extract<JobRequest, { action: 'create' }>;

  /** The prompt or shell task the input asks for; the prompt case is verified against OpenCode. */
  async function taskFor(
    input: CreateInput,
    client: OpenCodeClient,
    agent: string | undefined,
    directory: string,
  ): Promise<Job['task']> {
    if (input.command !== undefined)
      return userTaskSchema.parse({
        kind: 'shell',
        command: input.command,
        cwd: input.cwd ?? directory,
        ...(input.env ? { env: input.env } : {}),
        ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
      });
    if (!agent) throw new JobRefused('This session has no agent; pass agent explicitly.');
    // Verified against OpenCode 2.0.3: `agent.list` with a location sees agents defined under that
    // directory's .opencode/, where `agent.get` does not.
    const agents = await client.agent.list({ location: { directory } }).catch(() => ({ data: [] }));
    if (!agents.data.some(a => a.id === agent)) throw new JobRefused(`No agent "${agent}" exists in ${directory}.`);
    return userTaskSchema.parse({
      kind: 'prompt',
      agent,
      directory,
      prompt: input.prompt,
      ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
    });
  }

  /** A report nobody may carry is refused at creation, not at delivery time. */
  function refuseReport(report: Report): Report {
    const refusal = channels.refuse(report);
    if (refusal) throw new JobRefused(`${refusal}. Use report "none" or a channel aivi may post to.`);
    return report;
  }

  /** The report the input asks for, with "this channel" resolved through the router. */
  async function reportFor(input: CreateInput): Promise<Report | null> {
    if (input.report === 'channel' && !input.channel) {
      // "Post it to this channel": the channel the asking conversation lives in.
      const here = await channels.channelOf(input.sessionId);
      if (!here)
        throw new JobRefused(
          'report "channel" needs the channel id when the asking session is not a chat conversation.',
        );
      return refuseReport({ to: 'channel', module: input.module ?? here.module, channel: here.channel, on: input.on });
    }
    if (input.report === 'channel') {
      // A conversation asking for a post defaults to its own platform; a native session must say which.
      const module = input.module ?? channels.ownerOf(input.sessionId);
      if (!module)
        throw new JobRefused('report "channel" needs the module (for example "discord") from a native session.');
      return refuseReport({ to: 'channel', module, channel: input.channel!, on: input.on });
    }
    if (input.report === 'session')
      return refuseReport({ to: SESSION_DESTINATION, session: input.sessionId, on: input.on });
    return null;
  }

  /** The fields every new agent job carries; the schedule belongs to the branch that adds it. */
  interface JobDraft {
    id: string;
    title?: string;
    timezone: string;
    resource: string;
    task: Job['task'];
    report?: Report;
  }
  function draft(input: CreateInput, task: Job['task'], report: Report | null, resource: string): JobDraft {
    return {
      id: `agent-${randomUUID().slice(0, 8)}`,
      ...(input.title ? { title: input.title } : {}),
      timezone: input.timezone ?? hostTimezone(),
      resource,
      task,
      ...(report ? { report } : {}),
    };
  }

  function addOneOff(input: CreateInput, base: JobDraft, at: number, dedupeKey: string): JobResponse {
    const due = parseDueOrRefuse(input.at!, at);
    const entry = store.addJob(jobSchema.parse({ ...base, at: new Date(due).toISOString() }), 'agent', at, {
      dedupeKey,
      reason: `agent:${input.sessionId}`,
    });
    wake();
    const item = jobItem(entry);
    return {
      summary: `Created a one-off ${item.title} (${item.id}) for ${formatInstant(due, base.timezone)}. ${reportText(base.report ?? null)}`,
      items: [item],
    };
  }

  function addRecurring(input: CreateInput, base: JobDraft, at: number): JobResponse {
    const parsed = jobSchema.safeParse({ ...base, cron: input.cron });
    if (!parsed.success)
      throw new JobRefused(`Invalid cron expression or timezone: "${input.cron}" in ${base.timezone}.`);
    const entry = store.addJob(parsed.data, 'agent', at);
    wake();
    const item = jobItem(entry);
    return {
      summary: `Created ${item.title} (${item.id}): cron ${parsed.data.cron} in ${base.timezone}. Next: ${item.next.join(', ')}. ${reportText(base.report ?? null)}`,
      items: [item],
    };
  }

  async function create(input: CreateInput): Promise<JobResponse> {
    if (!settings) throw new Error('unreachable');
    if ((input.prompt === undefined) === (input.command === undefined))
      throw new JobRefused('Give exactly one of prompt (an agent job) or command (a script job).');
    if ((input.at === undefined) === (input.cron === undefined))
      throw new JobRefused('Give exactly one of at (one-off) or cron (recurring).');

    const client = await deps.opencode().catch(error => {
      throw new JobRefused(`OpenCode is not reachable: ${error instanceof Error ? error.message : String(error)}`, 503);
    });
    const session = await client.session.get({ sessionID: input.sessionId }).catch(() => {
      throw new JobRefused(`Unknown session ${input.sessionId}.`, 404);
    });
    const origin = (session.metadata as { aivi?: { origin?: string } } | undefined)?.aivi?.origin;
    if ((origin === 'job' || origin === 'dreaming') && !channels.ownsSession(input.sessionId))
      throw new JobRefused('Jobs do not create jobs. Ask a person in a conversation to schedule this.', 403);

    const task = await taskFor(
      input,
      client,
      input.agent ?? session.agent,
      input.directory ?? session.location.directory,
    );
    const report = await reportFor(input);

    // A retried tool call carries the same message id and lands on the job it already made.
    const dedupeKey = `agent:${input.sessionId}:${input.messageId ?? randomUUID()}`;
    const agents = agentJobs();
    const existing = agents.filter(j => j.state === 'active' || j.state === 'paused').length;
    if (existing >= settings.max && !agents.some(j => j.dedupeKey === dedupeKey))
      throw new JobRefused(`The limit of ${settings.max} agent-created jobs is reached; remove one first.`, 409);

    const at = now();
    const base = draft(input, task, report, settings.resource);
    return input.at !== undefined ? addOneOff(input, base, at, dedupeKey) : addRecurring(input, base, at);
  }

  function agentJobs(): JobEntry[] {
    return store.jobs().filter(j => j.source === 'agent');
  }
  function items(): JobItem[] {
    return agentJobs().map(jobItem);
  }

  function jobItem(entry: JobEntry): JobItem {
    const { spec } = entry;
    const last = store.lastRun(spec.id);
    const next =
      entry.state !== 'active'
        ? []
        : spec.at !== undefined
          ? entry.nextAt === null
            ? []
            : [entry.nextAt]
          : nextOccurrences(spec.cron!, spec.timezone, now(), 3);
    return {
      id: spec.id,
      kind: spec.at !== undefined ? 'one-off' : 'recurring',
      task: spec.task.kind === 'shell' ? 'script' : 'agent',
      title: spec.title ?? titleOf(spec.task),
      when:
        spec.at !== undefined
          ? `at ${formatInstant(Date.parse(spec.at), spec.timezone)} (${spec.timezone})`
          : `cron ${spec.cron} (${spec.timezone})`,
      state: entry.state,
      next: next.map(t => formatInstant(t, spec.timezone)),
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
}

function parseDueOrRefuse(at: string, now: number): number {
  try {
    return parseDue(at, now);
  } catch (error) {
    throw new JobRefused(error instanceof Error ? error.message : String(error));
  }
}

function withRefusal<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    throw new JobRefused(error instanceof Error ? error.message : String(error), 404);
  }
}

function titleOf(task: Job['task']): string {
  if (task.kind === 'prompt') {
    const line = task.prompt.split('\n').find(l => l.trim()) ?? task.prompt;
    return `"${line.length > 60 ? `${line.slice(0, 59)}…` : line}"`;
  }
  if (task.kind === 'shell') return `\`${task.command.join(' ').slice(0, 60)}\``;
  return task.name;
}

function reportText(report: Report | null): string {
  if (!report) return 'Results are not reported anywhere; `aivi runs show` has them.';
  const when = report.on === 'failure' ? 'Only failures are' : 'Results are';
  if (report.to === SESSION_DESTINATION) return `${when} brought back into this conversation.`;
  return `${when} posted to ${report.module} ${report.channel}.`;
}

function describeList(items: JobItem[]): string {
  if (!items.length) return 'No agent-created jobs exist.';
  return items
    .map(
      i =>
        `${i.id}: ${i.title}, ${i.when}${i.state === 'active' ? '' : ` (${i.state})`}${i.next.length ? `, next ${i.next[0]}` : ''}${i.lastRun ? `, last run ${i.lastRun.state}` : ''}`,
    )
    .join('\n');
}

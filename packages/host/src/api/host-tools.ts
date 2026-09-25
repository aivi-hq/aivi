import type { KnowledgeService, LoadedConfig, Logger, ModuleHealth } from '@aivi/core';
import {
  jobRequestSchema,
  knowledgeKindHelp,
  knowledgeKindNames,
  projectSummaries,
  searchSchema,
  selectSources,
  sourceSelectionSchema,
} from '@aivi/core';
import type { JobHandler } from '../jobs.ts';
import { JobRefused } from '../jobs.ts';
import type { Store } from '../store.ts';
import { ToolError, type ToolRegistry } from '../tools.ts';
import { status } from './status.ts';

/** Flat object schemas for the model-facing tool inputs; the host validates the exact wire shape with zod. */
const selectionProperties = {
  projects: {
    type: 'array',
    items: { type: 'string' },
    description:
      'Project IDs. Omit for all projects; [] for core only. Project knowledge is only relevant to that project unless the question compares projects.',
  },
  includeCore: { type: 'boolean', description: 'Include company-wide core sources (default true).' },
  kinds: {
    type: 'array',
    items: { type: 'string', enum: knowledgeKindNames },
    description: `Restrict to kinds of material. ${knowledgeKindHelp}`,
  },
} as const;

const jobsInput = {
  type: 'object',
  required: ['action'],
  additionalProperties: false,
  properties: {
    action: { type: 'string', enum: ['create', 'list', 'pause', 'resume', 'remove', 'run'] },
    id: { type: 'string', description: 'Job id, for pause/resume/remove/run (from list or create).' },
    title: { type: 'string', maxLength: 80, description: 'create: short label the person would recognise.' },
    prompt: {
      type: 'string',
      maxLength: 20000,
      description:
        'create, agent job: a self-contained instruction for a fresh session of the agent. It cannot ask questions; include everything it needs.',
    },
    command: {
      type: 'array',
      items: { type: 'string' },
      description: 'create, script job: argv (no shell). Exactly one of prompt or command.',
    },
    cwd: { type: 'string', description: 'Script working directory; default the calling session’s directory.' },
    env: { type: 'object', additionalProperties: { type: 'string' }, description: 'Extra environment for the script.' },
    timeoutMs: { type: 'integer', minimum: 10000, description: 'Default 30 min for agent jobs, 10 min for scripts.' },
    agent: { type: 'string', description: 'Agent job override; default the calling agent.' },
    directory: { type: 'string', description: 'Agent job override; default the calling session’s directory.' },
    at: {
      type: 'string',
      description:
        'One-off: ISO 8601 instant (2026-09-16T09:00:00+02:00) or a duration (30m, 2h, 1d). Exactly one of at or cron.',
    },
    cron: { type: 'string', description: 'Recurring: 5-field cron, e.g. "0 9 * * 1-5" for weekdays at 09:00.' },
    timezone: { type: 'string', description: 'IANA timezone for cron; default the host’s.' },
    report: {
      type: 'string',
      enum: ['session', 'channel', 'none'],
      description:
        'Where results go. session (default): back into this conversation, you will read and relay them. channel: posted as a new thread in a chat channel, by default the channel this conversation is in ("post it here/to this channel"), or the one named in `channel`. none: nowhere.',
    },
    module: {
      type: 'string',
      description:
        'Chat platform for report channel (discord, slack). Default: the platform this conversation is on; required from a native session.',
    },
    channel: {
      type: 'string',
      description: 'Platform channel id when report is channel; omit for the current channel.',
    },
    on: {
      type: 'string',
      enum: ['always', 'failure'],
      description: 'Report every outcome (default) or only failures.',
    },
  },
} as const;

export interface HostToolDeps {
  store: Store;
  loaded: LoadedConfig;
  knowledge?: KnowledgeService | undefined;
  jobs?: JobHandler | undefined;
  health?: (() => ModuleHealth[]) | undefined;
  context?: ((sessionID: string, signal: AbortSignal) => Promise<string>) | undefined;
  log: Logger;
}

/**
 * The tool surface the OpenCode plugin builds itself from, claimed under
 * `host` with the ids agent-file permission rules already match. A
 * capability that does not exist claims nothing, so its tool is absent
 * from the plugin rather than present and failing.
 */
export function claimHostTools(tools: ToolRegistry, deps: HostToolDeps): void {
  const { store, loaded, knowledge, jobs, health, context, log } = deps;
  const claim = tools.claim.bind(tools, 'host');
  claim(
    {
      namespace: 'aivi',
      name: 'status',
      description: 'Inspect aivi job counts and capabilities. This does not start work.',
      input: { type: 'object', properties: {}, additionalProperties: false },
    },
    async () => status(store, loaded, Date.now(), health?.() ?? []),
  );
  claim(
    {
      namespace: 'aivi',
      name: 'sources',
      description: 'List configured knowledge sources and their paths. Omit projects for all; [] for core only.',
      input: { type: 'object', properties: selectionProperties, additionalProperties: false },
      timeoutMs: 10_000,
    },
    async call => {
      const parsed = sourceSelectionSchema.safeParse(call.input);
      if (!parsed.success) throw new ToolError(400, 'Invalid source selection');
      try {
        return selectSources(loaded, parsed.data.projects, parsed.data.includeCore, parsed.data.kinds);
      } catch (error) {
        throw new ToolError(400, (error as Error).message);
      }
    },
  );
  claim(
    {
      namespace: 'knowledge',
      name: 'projects',
      description:
        'List the projects the team works on, with the source kinds each can be searched by. A project marked removed no longer has a checkout; only what was remembered about it is left, and it can still be asked about.',
      input: { type: 'object', properties: {}, additionalProperties: false },
    },
    async () => projectSummaries(loaded),
  );
  if (knowledge)
    claim(
      {
        namespace: 'knowledge',
        name: 'search',
        description:
          'Keyword search over configured knowledge with source paths and excerpts. Omit projects for all; [] selects core only; includeCore defaults true.',
        input: {
          type: 'object',
          required: ['query'],
          additionalProperties: false,
          properties: {
            query: { type: 'string', minLength: 1, maxLength: 2000 },
            limit: { type: 'integer', minimum: 1, maximum: 20 },
            ...selectionProperties,
          },
        },
      },
      async call => {
        const parsed = searchSchema.safeParse(call.input);
        if (!parsed.success) throw new ToolError(400, 'Invalid search request');
        try {
          selectSources(loaded, parsed.data.projects, parsed.data.includeCore, parsed.data.kinds);
        } catch (error) {
          throw new ToolError(400, (error as Error).message);
        }
        const { query, limit, projects, includeCore, kinds } = parsed.data;
        try {
          return await knowledge.search({
            query,
            limit,
            ...(projects ? { projects } : {}),
            ...(includeCore !== undefined ? { includeCore } : {}),
            ...(kinds ? { kinds } : {}),
          });
        } catch (error) {
          log.warn('knowledge.search.failed', { error });
          throw new ToolError(503, 'Knowledge search is unavailable');
        }
      },
    );
  if (context)
    claim(
      {
        namespace: 'aivi',
        name: 'context',
        description:
          'Describe this conversation’s context: the window in use against the model’s limit, compactions, token and cost totals for the session, and the knowledge in scope. Use when someone asks about context, tokens, cost or which model is answering. Relay the returned markdown as it is; every number comes from OpenCode.',
        input: { type: 'object', properties: {}, additionalProperties: false },
        timeoutMs: 20_000,
      },
      async call => {
        try {
          return { text: await context(call.sessionId, AbortSignal.timeout(15_000)) };
        } catch (error) {
          log.warn('context.failed', { session: call.sessionId, error });
          throw new ToolError(502, 'Could not read that session from OpenCode');
        }
      },
    );
  if (jobs)
    claim(
      {
        namespace: 'aivi',
        name: 'jobs',
        description:
          'Create, list, pause, resume, remove or run jobs: a one-off (`at`) or recurring (`cron`) agent job (`prompt`, runs your agent in a fresh session) or script job (`command`). Translate what the person said into cron/ISO/duration yourself; the reply names the next occurrences, relay them so the person can confirm. Results default to coming back into this conversation for you to relay. Only create when a person asked; never from inside a job. If the tool fails, relay its error message word for word: it says what to fix.',
        input: jobsInput,
        timeoutMs: 30_000,
      },
      async call => {
        // The envelope's ids win over anything in the model's input: they
        // come from the native tool context, and authority follows them.
        const parsed = jobRequestSchema.safeParse({
          ...call.input,
          sessionId: call.sessionId,
          ...(call.messageId ? { messageId: call.messageId } : {}),
        });
        if (!parsed.success)
          throw new ToolError(
            400,
            `Invalid job request: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
          );
        try {
          return await jobs(parsed.data);
        } catch (error) {
          if (error instanceof JobRefused) throw new ToolError(error.status, error.message);
          log.warn('jobs.failed', { action: parsed.data.action, error });
          throw new ToolError(500, 'The job operation failed on the host; check its log.');
        }
      },
    );
}

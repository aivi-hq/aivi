import { type FSWatcher, readFileSync, watch } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { BrowserRequest, JobRequest } from '@aivi/core';
import type { KnowledgeKind } from '@aivi/core/kinds';
import { knowledgeKindHelp, knowledgeKindNames } from '@aivi/core/kinds';
import { createHostClient } from '@aivi/host/client';
import { Plugin } from '@opencode/plugin';

const DEFAULT_HOST_URL = 'http://127.0.0.1:4100';

/**
 * The aivi home, which holds `<home>/soul.md` and `<home>/aivi.json`. The aivi
 * home is the OpenCode location, so the default needs no configuration;
 * `AIVI_HOME`, or the plugin's `soul` option (a file: its directory is the
 * home), say otherwise.
 */
function aiviHome(options: Record<string, unknown>, location: { directory?: string } | undefined): string | undefined {
  if (typeof options.soul === 'string' && options.soul) return dirname(resolve(options.soul));
  if (process.env.AIVI_HOME) return resolve(process.env.AIVI_HOME);
  return location?.directory;
}

/**
 * The persona name, read straight out of `<home>/aivi.json` rather than through
 * the host: the plugin is a guest in someone else's process and must state who
 * aivi is even while the operator is mid-edit on a config the host would
 * refuse. `''` when there is nothing to say.
 */
function personaName(home: string): string {
  let identity: { name?: unknown } | undefined;
  try {
    identity = (JSON.parse(readFileSync(join(home, 'aivi.json'), 'utf8')) as { identity?: typeof identity }).identity;
  } catch {
    return '';
  }
  return typeof identity?.name === 'string' ? identity.name.trim() : '';
}

/**
 * Flat object schema for the browser tool. Provider tool APIs require a root
 * `object`; the host validates the exact per-action shape (`browserRequestSchema`).
 */
const browserInput = {
  type: 'object',
  required: ['action'],
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['tabs', 'open', 'navigate', 'snapshot', 'click', 'fill', 'press', 'dialog', 'focus', 'close'],
    },
    tabId: {
      type: 'string',
      description: 'Tab owned by this session (from open/tabs). Required for every action except tabs/open.',
    },
    url: { type: 'string', description: 'HTTP(S) URL for open/navigate.' },
    uid: { type: 'string', description: 'The `id` of a node in the latest snapshot, for click/fill.' },
    value: { type: 'string', maxLength: 10000, description: 'Text for fill.' },
    key: { type: 'string', description: 'Key name for press.' },
    response: { type: 'string', enum: ['accept', 'dismiss'], description: 'Dialog response.' },
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

export default Plugin.define({
  id: 'aivi',
  async setup(ctx) {
    const baseUrl = typeof ctx.options.url === 'string' ? ctx.options.url : DEFAULT_HOST_URL;
    // A missing token must not prevent the plugin from loading: the host may run with
    // auth mode "none", and a clear per-call error beats silently losing every tool.
    const client = createHostClient(baseUrl, { token: process.env.AIVI_TOKEN });
    // Text only: OpenCode 2.0.3 rejects a structured `output` unless the tool declares an output schema
    // ("Tool result declared output without an output schema"); Code Mode parses the JSON text.
    const json = (value: unknown) => ({ content: JSON.stringify(value) });

    const registration = await ctx.tool.transform(editor => {
      editor.namespace({ name: 'aivi', description: 'aivi installation status and configured knowledge sources' });
      editor.namespace({ name: 'knowledge', description: 'Search authoritative company and project documents' });

      editor.add({
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
        options: { namespace: 'knowledge', codemode: true },
        execute: async input =>
          json(
            await client.search(
              input as {
                query: string;
                projects?: string[];
                includeCore?: boolean;
                limit?: number;
                kinds?: KnowledgeKind[];
              },
            ),
          ),
      });
      editor.add({
        name: 'status',
        description: 'Inspect aivi job counts and capabilities. This does not start work.',
        input: { type: 'object', properties: {}, additionalProperties: false },
        options: { namespace: 'aivi', codemode: true },
        execute: async () => json(await client.status()),
      });
      editor.add({
        name: 'sources',
        description: 'List configured knowledge sources and their paths. Omit projects for all; [] for core only.',
        input: { type: 'object', properties: selectionProperties, additionalProperties: false },
        options: { namespace: 'aivi', codemode: true },
        execute: async input =>
          json(await client.sources(input as { projects?: string[]; includeCore?: boolean; kinds?: KnowledgeKind[] })),
      });
      editor.add({
        name: 'projects',
        description:
          'List the projects the team works on, with the source kinds each can be searched by. A project marked removed no longer has a checkout; only what was remembered about it is left, and it can still be asked about.',
        input: { type: 'object', properties: {}, additionalProperties: false },
        options: { namespace: 'knowledge', codemode: true },
        execute: async () => json(await client.projects()),
      });
      editor.add({
        name: 'context',
        description:
          'Describe this conversation’s context: the window in use against the model’s limit, compactions, token and cost totals for the session, and the knowledge in scope. Use when someone asks about context, tokens, cost or which model is answering. Relay the returned markdown as it is; every number comes from OpenCode.',
        input: { type: 'object', properties: {}, additionalProperties: false },
        options: { namespace: 'aivi', codemode: true },
        execute: async (_input, context) => json(await client.context(context.sessionID)),
      });
      editor.add({
        name: 'jobs',
        description:
          'Create, list, pause, resume, remove or run jobs: a one-off (`at`) or recurring (`cron`) agent job (`prompt`, runs your agent in a fresh session) or script job (`command`). Translate what the person said into cron/ISO/duration yourself; the reply names the next occurrences, relay them so the person can confirm. Results default to coming back into this conversation for you to relay. Only create when a person asked; never from inside a job. If the tool fails, relay its error message word for word: it says what to fix.',
        input: jobsInput,
        options: { namespace: 'aivi', codemode: true },
        execute: async (input, context) =>
          json(
            await client.jobs({
              ...(input as Omit<JobRequest, 'sessionId' | 'messageId'>),
              sessionId: context.sessionID,
              messageId: context.messageID,
            } as JobRequest),
          ),
      });
      editor.add({
        // Under `aivi`, not `browser`: OpenCode 2.0.3 has its own `browser.*` desktop tools and the model
        // conflated the two. The permission action is the tool id, `aivi_browser`, like the other aivi tools.
        name: 'browser',
        description:
          'Control this session’s tabs in aivi’s own Chrome (not the OpenCode desktop browser). Start with open or tabs; snapshot returns nodes whose `id` is the uid for click/fill. Refresh snapshot after navigation. The shared profile retains logins; use focus for manual login. Never put passwords or secrets in fill. No automatic retries after uncertain actions.',
        input: browserInput,
        options: { namespace: 'aivi', codemode: true },
        execute: async (input, context) => json(await client.browser(context.sessionID, input as BrowserRequest)),
      });
    });

    // The soul: who aivi is, appended to **every** agent's prompt (aivi runs on
    // a dedicated machine, so every agent there is an aivi agent). The
    // registry replays this transform on every rebuild — reading soul.md and
    // the persona name fresh each time — so an agent-file edit can never wipe
    // it and no soul text is copied into agent files. Neither file sits inside
    // the `.opencode` roots OpenCode watches, so the plugin watches them here
    // and invalidates the registry on change; sessions continue, history is in
    // the store.
    const disposers: (() => unknown)[] = [() => registration.dispose()];
    const home = aiviHome(ctx.options as Record<string, unknown>, ctx.location as { directory?: string } | undefined);
    if (home && typeof ctx.agent?.transform === 'function') {
      const soul = join(home, 'soul.md');
      const agentTransform = await ctx.agent.transform(editor => {
        let text: string;
        try {
          text = readFileSync(soul, 'utf8').trim();
        } catch {
          return; // no soul yet: nothing to say
        }
        // The name is config, so it is said from config and never repeated in
        // soul.md: one place to change what every agent is called.
        const who = personaName(home);
        text = [who ? `Your name is ${who}.` : '', text].filter(Boolean).join('\n\n');
        if (!text) return;
        for (const agent of editor.list()) {
          editor.update(agent.id as unknown as string, a => {
            a.system = a.system ? `${a.system}\n\n${text}` : text;
          });
        }
      });
      disposers.push(() => agentTransform.dispose());
      let timer: ReturnType<typeof setTimeout> | undefined;
      let watcher: FSWatcher | undefined;
      try {
        watcher = watch(home, (_event, filename) => {
          if (filename && filename !== 'soul.md' && filename !== 'aivi.json') return;
          clearTimeout(timer);
          timer = setTimeout(() => void ctx.agent.reload(), 100);
        });
        disposers.push(() => {
          clearTimeout(timer);
          watcher?.close();
        });
      } catch {
        // No directory to watch: the soul is simply absent until it exists.
      }
    }

    return () => {
      for (const off of disposers) void off();
    };
  },
});

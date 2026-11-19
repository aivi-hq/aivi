/** What `startDiscord` reaches, as fakes. Discord is the SDK's client and REST
 *  (a test file replaces `discord.js` with `discordExports`, so the module
 *  builds these); OpenCode is the little the turn runner and the commands ask
 *  of it; the host's services are the ones a module is handed. The host's own
 *  machinery runs for real over them: the conversation store on an in-memory
 *  database, the channel engine, the channel registry. Nothing here opens a
 *  socket or a file.
 *
 *  This file must not import `../src/module.ts`: the test file replaces
 *  `discord.js` first and loads the module after, and a module loaded earlier
 *  keeps the real SDK. The test hands the loaded module to `world`. */
import { EventEmitter } from 'node:events';
import { mock, type TestContext } from 'node:test';
import { configSchema, type Run } from '@aivi/core';
import { Channels, Store } from '@aivi/host';
import type { AiviServices, RunningModule } from '@aivi/plugin';
import type { ChannelModule } from '@aivi/plugin/channel';
import {
  ChannelType,
  Events,
  GatewayIntentBits,
  InteractionContextType,
  MessageFlags,
  Options,
  Partials,
  Routes,
  SlashCommandBuilder,
} from 'discord.js';
import { recorder, TestCapacity } from '../../host/test/support.ts';
import { boundary } from '../../voice/test/boundary.ts';
import { type DiscordConfig, discordConfigSchema } from '../src/config.ts';

type Unit = Pick<typeof import('../src/module.ts'), 'createDiscordModule' | 'openDiscordStore'>;

export const APP = '10000000000000001';
export const BOT = '10000000000000099';
export const ME = '10000000000000002';
export const STRANGER = '10000000000000003';
export const GUILD = '10000000000000050';
export const HOME = '10000000000000004';
export const TEAM = '10000000000000006';
export const REPORTS = '10000000000000010';
export const DM = '10000000000000020';
export const DIRECTORY = '/assistant';
export const TOKEN = 'bot-token';
/** What every message the module sends carries: nobody is pinged and no link unfurls. */
export const SAFE = { allowedMentions: { parse: [], repliedUser: false }, flags: MessageFlags.SuppressEmbeds };
/** A message that addresses the bot. */
export const MENTIONS_BOT = { users: { has: (user: string) => user === BOT } };

/** The block as the host hands it over: ids and the directory are already resolved. `progress` is silent so a
 *  test sees the answers alone; the placeholder has its own tests. */
const configOf = (over: Record<string, unknown> = {}): DiscordConfig =>
  discordConfigSchema.parse({
    applicationId: APP,
    directory: DIRECTORY,
    messageContent: true,
    progress: 'silent',
    reportChannels: [REPORTS],
    access: { channels: [{ id: HOME }, { id: TEAM, trigger: 'any', sessions: 'channel' }] },
    ...over,
  });

/** One turn of the event loop: every promise chain the fakes started has run to its end (they resolve at once). */
export const settle = () => new Promise<void>(resolve => setImmediate(resolve));

/** Discord, as the test scripts it. `world` puts every answer back to a healthy gateway. */
export const discord = {
  clients: [] as FakeClient[],
  rests: [] as FakeREST[],
  /** The tokens the module logged in with. */
  tokens: [] as string[],
  applicationId: APP,
  login: async (_client: FakeClient, _token: string): Promise<string> => '',
  fetch: mock.fn(async (_id: string): Promise<unknown> => null),
  put: mock.fn(async (..._request: unknown[]): Promise<unknown> => []),
  destroy: mock.fn(async (_client: FakeClient): Promise<void> => {}),
};

/** `discord.js`'s `Client`, as far as the module uses it. */
class FakeClient extends EventEmitter {
  readonly options: Record<string, unknown>;
  user: { id: string } | null = null;
  application: { id: string } | null = null;
  ready = false;
  readonly channels = { fetch: (id: string) => discord.fetch(id) };

  constructor(options: Record<string, unknown>) {
    super();
    this.options = options;
    discord.clients.push(this);
  }

  isReady() {
    return this.ready;
  }

  login(token: string) {
    discord.tokens.push(token);
    return discord.login(this, token);
  }

  destroy() {
    return discord.destroy(this);
  }
}

/** `discord.js`'s `REST`: what the module sets up and puts. */
class FakeREST {
  readonly options: Record<string, unknown>;
  token: string | undefined;

  constructor(options: Record<string, unknown>) {
    this.options = options;
    discord.rests.push(this);
  }

  setToken(token: string) {
    this.token = token;
    return this;
  }

  put(route: string, request: unknown) {
    return discord.put(route, request);
  }
}

/** The real constants and builders of `discord.js`, with its two classes replaced. The package is CommonJS: a
 *  mock names the exports the module imports, and spreading the real namespace fails. */
export const discordExports = {
  ChannelType,
  Client: FakeClient,
  Events,
  GatewayIntentBits,
  InteractionContextType,
  MessageFlags,
  Options,
  Partials,
  REST: FakeREST,
  Routes,
  SlashCommandBuilder,
};

/** A gateway that accepts the token: the client knows its application and itself, and says ready. */
const becomeReady = async (client: FakeClient, token: string) => {
  client.application = { id: discord.applicationId };
  client.user = { id: BOT };
  client.ready = true;
  client.emit(Events.ClientReady, client);
  return token;
};

/** A message a channel's `send` answers with: it can open a thread, and the thread can be written to. `refusal` makes
 *  the opening fail. */
const opener = (id: string, refusal: { thread?: Error }) => {
  const thread = { id: `${id}:thread`, send: mock.fn(async (_payload: unknown) => ({ id: `${id}:thread:1` })) };
  return {
    id,
    thread,
    startThread: mock.fn(async (_options: unknown) => {
      if (refusal.thread) throw refusal.thread;
      return thread;
    }),
  };
};

/** The pieces of a channel's wire, as the module calls them. `openers` are the messages it sent, in order. */
const wire = (id: string) => {
  const openers: ReturnType<typeof opener>[] = [];
  const refusal: { thread?: Error } = {};
  return {
    id,
    guildId: GUILD as string | null,
    parentId: null as string | null,
    type: ChannelType.GuildText as ChannelType,
    openers,
    /** Set `thread` and no message of this channel can open a thread. */
    refusal,
    isSendable: () => true,
    isTextBased: () => true,
    isThread: () => false,
    isDMBased: () => false,
    isThreadOnly: () => false,
    send: mock.fn(async (_payload: unknown) => {
      const sent = opener(`${id}:${openers.length + 1}`, refusal);
      openers.push(sent);
      return sent;
    }),
    sendTyping: mock.fn(async () => {}),
    messages: {
      fetch: mock.fn(async (_id: string): Promise<unknown> => null),
      edit: mock.fn(async (..._edit: unknown[]) => {}),
      delete: mock.fn(async (..._removal: unknown[]) => {}),
    },
  };
};

/** A channel as discord.js shapes it: a guild text channel carries `threads`; a thread and a DM do not (the module
 *  asks `'threads' in channel`). */
export type FakeChannel = ReturnType<typeof wire> & { threads?: object };

export const textChannel = (id: string): FakeChannel => ({ ...wire(id), threads: {} });
export const forumChannel = (id: string): FakeChannel => ({ ...textChannel(id), isThreadOnly: () => true });
export const dmChannel = (id: string): FakeChannel => ({
  ...wire(id),
  guildId: null,
  type: ChannelType.DM,
  isDMBased: () => true,
});
export const threadChannel = (id: string, parentId: string): FakeChannel => ({
  ...wire(id),
  parentId,
  type: ChannelType.PublicThread,
  isThread: () => true,
});

let counter = 0;

/** A message of a person in `channel`, as discord.js hands it over. */
export function messageIn(channel: FakeChannel, over: Record<string, unknown> = {}) {
  const id = `message-${++counter}`;
  return {
    id,
    channelId: channel.id,
    guildId: channel.guildId,
    channel,
    content: 'hello',
    author: { id: ME, bot: false, displayName: 'Me' },
    member: null as { displayName: string } | null,
    webhookId: null as string | null,
    system: false,
    attachments: { size: 0 },
    mentions: { users: { has: (_user: string) => false } },
    react: mock.fn(async (..._reaction: unknown[]) => {}),
    reply: mock.fn(async (..._reply: unknown[]) => {}),
    startThread: mock.fn(async (_options: unknown) => ({ id: `${id}:thread` })),
    ...over,
  };
}

/** A slash command (or an autocomplete request) in `channel`. `values` answers `options.getString`. */
export function commandIn(
  channel: FakeChannel,
  commandName: string,
  values: Record<string, string> = {},
  over: Record<string, unknown> = {},
) {
  const interaction = {
    commandName,
    channel: channel as FakeChannel | null,
    channelId: channel.id,
    guildId: channel.guildId,
    user: { id: ME, displayName: 'Me' },
    member: null as object | null,
    deferred: false,
    isChatInputCommand: () => true,
    isAutocomplete: () => false,
    options: { getString: (name: string) => values[name] ?? null, getFocused: () => values.focused ?? '' },
    reply: mock.fn(async (..._reply: unknown[]) => {}),
    deferReply: mock.fn(async (..._defer: unknown[]) => {
      interaction.deferred = true;
    }),
    editReply: mock.fn(async (..._edit: unknown[]) => {}),
    respond: mock.fn(async (..._choices: unknown[]) => {}),
    ...over,
  };
  return interaction;
}

/** A model OpenCode offers, with one variant. */
const MODEL = {
  providerID: 'github-copilot',
  modelID: 'gpt-5.2',
  name: 'GPT 5.2',
  enabled: true,
  variants: [{ id: 'high' }],
};

/** The run of a job whose outcome is posted: an agent's, which has a session. */
export const runOf = (over: Partial<Run> = {}): Run => ({
  id: 'run-1',
  jobId: 'job-1',
  task: { kind: 'prompt', agent: 'assistant', directory: DIRECTORY, prompt: 'p', timeoutMs: 1, onPermission: 'reject' },
  resource: 'default',
  state: 'succeeded',
  createdAt: 0,
  scheduledFor: 0,
  startedAt: null,
  finishedAt: null,
  sessionId: 'ses_aivi_job1',
  owner: null,
  result: null,
  error: null,
  report: null,
  ...over,
});

/** OpenCode as a turn and the commands see it. A turn is answered `Answer`; `hold()` parks every turn at its wait
 *  until `release()` (or until the turn is aborted, as a real request would end). */
function openCodeFake() {
  const refuse: { steer?: Error } = {};
  const gate = { open: true, waiting: [] as (() => void)[] };
  let messageId = '';
  const client = {
    agent: { list: mock.fn(async (..._query: unknown[]) => ({ data: [] as unknown[] })) },
    model: {
      list: mock.fn(async (..._query: unknown[]) => ({ data: [MODEL] })),
      default: mock.fn(async (..._query: unknown[]) => ({ data: null as unknown })),
    },
    message: { list: mock.fn(async (..._query: unknown[]) => ({ data: [] as unknown[] })) },
    permission: { list: mock.fn(async (..._query: unknown[]) => [] as unknown[]) },
    session: {
      get: mock.fn(async (..._query: unknown[]) => ({ agent: 'assistant', location: { directory: DIRECTORY } })),
      update: mock.fn(async (..._update: unknown[]) => {}),
      prompt: mock.fn(async (input: { id?: string; delivery?: string }, ..._request: unknown[]) => {
        if (input.delivery === 'steer' && refuse.steer) throw refuse.steer;
        messageId = input.id ?? messageId;
      }),
      wait: mock.fn(
        (_query: unknown, request: { signal: AbortSignal }) =>
          new Promise<void>((resolve, reject) => {
            if (gate.open) return resolve();
            gate.waiting.push(resolve);
            request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
          }),
      ),
      context: mock.fn(async (..._query: unknown[]) => [
        { type: 'user', id: messageId },
        {
          type: 'assistant',
          agent: 'assistant',
          finish: 'stop',
          time: { created: 1, completed: 2 },
          content: [{ type: 'text', text: 'Answer' }],
        },
        { type: 'idle', outcome: 'succeeded', time: { created: 3 } },
      ]),
      interrupt: mock.fn(async (..._query: unknown[]) => {}),
    },
  };
  return {
    client,
    /** Set `steer` and a message steered into a running turn is refused with it. */
    refuse,
    hold: () => {
      gate.open = false;
    },
    release: () => {
      gate.open = true;
      for (const resolve of gate.waiting.splice(0)) resolve();
    },
  };
}

/** The module's world: a config, the services a module is handed, and the Discord that answers it. */
export function world(
  t: TestContext,
  unit: Unit,
  options: { config?: Record<string, unknown>; env?: Record<string, string>; capacity?: number } = {},
) {
  discord.clients.length = 0;
  discord.rests.length = 0;
  discord.tokens.length = 0;
  discord.applicationId = APP;
  discord.login = becomeReady;
  discord.put = mock.fn(async (..._request: unknown[]): Promise<unknown> => []);
  discord.destroy = mock.fn(async (client: FakeClient): Promise<void> => {
    client.ready = false;
  });
  const places = new Map<string, unknown>();
  const reports = textChannel(REPORTS);
  places.set(REPORTS, reports);
  discord.fetch = mock.fn(async (id: string): Promise<unknown> => {
    const place = places.get(id);
    if (place instanceof Error) throw place;
    return place ?? null;
  });
  t.mock.property(process, 'env', options.env ?? { DISCORD_BOT_TOKEN: TOKEN });

  const lines = recorder();
  const store = new Store(':memory:');
  const controller = new AbortController();
  const channels = new Channels();
  const registered: ChannelModule[] = [];
  const register = channels.register.bind(channels);
  channels.register = module => {
    registered.push(module);
    return register(module);
  };
  const dispatcher = new TestCapacity(options.capacity);
  const opencode = openCodeFake();
  const turns = boundary();
  const woken: (() => void)[] = [];
  const unwatch = mock.fn();
  const services = {
    loaded: { config: configSchema.parse({ version: 1 }), path: '/home/config.json', projects: [], sources: [] },
    store,
    knowledge: { search: mock.fn(async (..._query: unknown[]) => [] as unknown[]) },
    opencode: mock.fn(async () => opencode.client),
    events: {
      watch: mock.fn((..._watch: unknown[]) => () => {}),
    },
    signal: controller.signal,
    log: lines.log,
    channels,
    dispatcher,
    voice: { room: mock.fn((..._room: unknown[]) => ({})) },
    wake: mock.fn(() => turns.reach()),
    onWake: mock.fn((listener: () => void) => {
      woken.push(listener);
      return unwatch;
    }),
    fail: mock.fn(),
  };
  const config = configOf(options.config);
  let running: RunningModule | undefined;
  let stopping: Promise<void> | undefined;
  /** Stop the started module once, however many times a test and its cleanup ask. */
  const stop = () => {
    stopping ??= running!.stop();
    return stopping;
  };
  t.after(async () => {
    await Promise.allSettled(running ? [stop()] : []);
    store.close();
  });
  return {
    config,
    services,
    store,
    inbox: unit.openDiscordStore(store, config),
    channels,
    /** What the module registered with the host's channel registry, to call its members directly. */
    entry: () => registered[0]!,
    dispatcher,
    opencode,
    places,
    /** The one report channel the config names. */
    reports,
    unwatch,
    /** The host fires its wake listeners. */
    wake: () => {
      for (const listener of woken) listener();
    },
    /** Resolves when the next turn has ended and the engine told the host (the next one still unread). */
    turnEnded: () => turns.next(),
    /** Let the turns parked at OpenCode go on, and wait until the next one has ended. */
    async finishTurn() {
      const ended = turns.next();
      opencode.release();
      await ended;
    },
    abort: (reason?: unknown) => controller.abort(reason),
    /** OpenCode is not running: every call for its client fails with the error handed back. */
    opencodeDown: () => {
      const failure = new Error('No running OpenCode service');
      services.opencode.mock.mockImplementation(async () => Promise.reject(failure));
      return failure;
    },
    /** A person, and the Discord account that proved it is theirs by redeeming a link code. */
    link: (user = ME, name = 'Ada') => {
      const person = store.createPerson({ name });
      store.redeemLinkCode(store.mintLinkCode(person.id).code, 'discord', user);
      return person;
    },
    /** A channel Discord knows by id. */
    know: <C extends { id: string }>(channel: C): C => {
      places.set(channel.id, channel);
      return channel;
    },
    get client() {
      return discord.clients.at(-1)!;
    },
    async start() {
      running = await unit.createDiscordModule(config).start(services as unknown as AiviServices);
      return running;
    },
    stop,
    said: (level: string) => lines.said(level).map(({ level: _level, ...fields }) => fields),
  };
}

export type World = ReturnType<typeof world>;

/** A started module with one linked person (the account ME is Ada), a DM channel Discord knows, and the gateway
 *  ready. */
export async function startedInDm(t: TestContext, unit: Unit, options?: Parameters<typeof world>[2]) {
  const w = world(t, unit, options);
  const dm = w.know(dmChannel(DM));
  const ada = w.link();
  await w.start();
  await settle();
  return { w, dm, ada };
}

/** A started module with one linked person and the HOME channel, where a mention starts a conversation in a thread. */
export async function startedInHome(t: TestContext, unit: Unit, options?: Parameters<typeof world>[2]) {
  const w = world(t, unit, options);
  const home = w.know(textChannel(HOME));
  const ada = w.link();
  await w.start();
  await settle();
  return { w, home, ada };
}

/** A started module whose DM has a turn running: the message `first` was taken and is parked at OpenCode until
 *  `finishTurn`. */
export async function startedWithRunningTurn(t: TestContext, unit: Unit, options?: Parameters<typeof world>[2]) {
  const started = await startedInDm(t, unit, options);
  started.w.opencode.hold();
  started.w.client.emit(Events.MessageCreate, messageIn(started.dm, { id: 'first', content: 'take your time' }));
  await settle();
  return started;
}

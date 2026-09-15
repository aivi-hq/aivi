import { once } from 'node:events';
import { setTimeout } from 'node:timers/promises';
import { accessEntry, errorMessage } from '@aivi/core';
import type { ChannelPlatform, HostModule, HostServices, Store, Turn } from '@aivi/host';
import {
  ChannelEngine,
  ConfigurationError,
  ConversationStore,
  createTurnRunner,
  describeConversation,
  splitReply,
  status,
} from '@aivi/host';
import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  InteractionContextType,
  type Message,
  MessageFlags,
  Options,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
} from 'discord.js';
import type { DiscordConfig, Route } from './config.ts';
import { authorized } from './config.ts';

const safeSend = {
  allowedMentions: { parse: [] as never[], repliedUser: false },
  flags: MessageFlags.SuppressEmbeds as const,
};
const COMMANDS = ['new', 'status', 'context', 'search'] as const;
/** Discord's message limit is 2000 UTF-16 units; stay below it with room for formatting. */
export const DISCORD: ChannelPlatform = { id: 'discord', label: 'Discord', replyLimit: 1900 };

export function bindingFor(config: DiscordConfig): string {
  return JSON.stringify({ application: config.applicationId, agent: config.agent, directory: config.directory });
}
/** The Discord inbox in the host database; the CLI and the module open the same one. */
export function openDiscordStore(store: Store, config: DiscordConfig): ConversationStore {
  return new ConversationStore(store, DISCORD, bindingFor(config));
}

/**
 * Tell Discord which slash commands exist. One bulk overwrite, so it is idempotent
 * and removes commands aivi no longer has. Runs at every module start (after the
 * gateway is ready) and on demand through `aivi discord register`; global commands
 * can take up to an hour to show up in clients.
 */
export async function registerDiscordCommands(config: DiscordConfig): Promise<void> {
  const token = requireToken();
  const rest = new REST({ version: '10', timeout: 15000, retries: 0 }).setToken(token);
  const commands = [
    new SlashCommandBuilder().setName('new').setDescription('Start a fresh conversation'),
    new SlashCommandBuilder().setName('status').setDescription('Show this conversation status'),
    new SlashCommandBuilder()
      .setName('context')
      .setDescription('What this conversation’s session knows: agent, model, messages, tokens, knowledge in scope'),
    new SlashCommandBuilder()
      .setName('search')
      .setDescription('Search team knowledge')
      .addStringOption(o => o.setName('query').setDescription('Search terms').setRequired(true))
      .addStringOption(o => o.setName('project').setDescription('Optional project ID; includes core knowledge')),
  ];
  for (const command of commands)
    if (!(COMMANDS as readonly string[]).includes(command.name))
      throw new Error(`Registered Discord command ${command.name} has no handler`);
  await rest.put(Routes.applicationCommands(config.applicationId), {
    body: commands.map(c => c.setContexts(InteractionContextType.Guild, InteractionContextType.BotDM).toJSON()),
  });
}

export function createDiscordModule(config: DiscordConfig): HostModule {
  return { id: 'discord', start: services => startDiscord(config, services) };
}

/** Discord thread names are capped at 100 characters; use the opening words of the message. */
function threadName(text: string): string {
  const line = text.split('\n').find(l => l.trim()) ?? 'aivi';
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

function requireToken(): string {
  const token = process.env.DISCORD_BOT_TOKEN ?? process.env.DISCORD_TOKEN;
  if (!token)
    throw new ConfigurationError('DISCORD_BOT_TOKEN is required (a .env next to aivi.json is loaded automatically)');
  return token;
}

async function startDiscord(config: DiscordConfig, services: HostServices) {
  const log = services.log.child({ component: 'discord' });
  const token = requireToken();
  const store = openDiscordStore(services.store, config);
  if (store.rebound)
    log.warn('binding.changed', { hint: 'Every conversation starts a fresh session on its next message.' });
  const interrupted = store.recover();
  if (interrupted.length) log.warn('turns.interrupted', { discarded: interrupted.length });

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      ...(config.messageContent ? [GatewayIntentBits.MessageContent] : []),
    ],
    partials: [Partials.Channel],
    allowedMentions: safeSend.allowedMentions,
    makeCache: Options.cacheWithLimits({ MessageManager: 0 }),
    rest: { timeout: 15000, retries: 0 },
  });

  const abort = new AbortController();
  let engine: ChannelEngine | undefined;
  const stop = () => {
    abort.abort();
    engine?.stop();
  };
  services.signal.addEventListener('abort', stop, { once: true });
  const teardown = async () => {
    stop();
    try {
      await engine?.shutdown();
    } finally {
      await client.destroy();
      services.signal.removeEventListener('abort', stop);
    }
  };

  try {
    const ask = await createTurnRunner(
      DISCORD,
      config,
      services.loaded,
      services.opencode,
      services.events,
      services.log,
    );
    // Discord's typing indicator lasts ~10 s; keep it alive while the agent works so people know it is alive.
    const typing = async (channelId: string, signal: AbortSignal) => {
      const channel = await client.channels.fetch(channelId).catch(() => null);
      if (!channel?.isSendable()) return;
      while (!signal.aborted) {
        await channel.sendTyping().catch(() => {});
        await setTimeout(8000, undefined, { signal }).catch(() => {});
      }
    };
    // A message that has to wait gets a ⏳ so the wait is not silence; a reply where the bot may not react.
    const WAITING = '⏳';
    const acknowledgeQueued = async (message: Message) => {
      try {
        await message.react(WAITING);
      } catch {
        await message.reply({ content: 'Queued; I will answer in turn.', ...safeSend }).catch(() => {});
      }
    };
    const clearQueued = async (turn: Turn) => {
      if (turn.kind !== 'message') return;
      const channel = await client.channels.fetch(turn.channel).catch(() => null);
      if (!channel?.isTextBased()) return;
      const message = await channel.messages.fetch(turn.id).catch(() => null);
      await message?.reactions
        .resolve(WAITING)
        ?.users.remove(client.user!.id)
        .catch(() => {});
    };
    const askWithTyping: typeof ask = async (turn, signal, ready) => {
      void clearQueued(turn);
      const done = new AbortController();
      void typing(turn.channel, AbortSignal.any([signal, done.signal]));
      try {
        return await ask(turn, signal, ready);
      } finally {
        done.abort();
      }
    };
    engine = new ChannelEngine(
      store,
      config,
      services.loaded.config.scheduler,
      askWithTyping,
      {
        async send(channelId, content) {
          const channel = await client.channels.fetch(channelId);
          if (!channel?.isSendable()) throw new Error('Discord channel is not sendable');
          return (await channel.send({ content, ...safeSend })).id;
        },
        async edit(channelId, messageId, content) {
          const channel = await client.channels.fetch(channelId);
          if (!channel?.isTextBased()) throw new Error('Discord channel is not text based');
          await channel.messages.edit(messageId, { content, ...safeSend });
        },
        async delete(channelId, messageId) {
          const channel = await client.channels.fetch(channelId);
          if (!channel?.isTextBased()) throw new Error('Discord channel is not text based');
          await channel.messages.delete(messageId);
        },
      },
      {
        log: services.log,
        onRelease: services.wake,
        onFailure: services.fail,
        progress: { mode: config.progress, events: services.events },
      },
    );

    // Gateway errors are transient and discord.js reconnects on its own. An optional
    // adapter must never take the knowledge server and scheduler down with it.
    client.on(Events.Error, error => log.warn('gateway.error', { error }));
    client.on(Events.Warn, message => log.warn('gateway.warn', { message }));
    client.on(Events.ShardDisconnect, () => log.warn('gateway.disconnected'));
    client.on(Events.ShardResume, () => log.info('gateway.resumed'));

    client.on(Events.MessageCreate, message => {
      void (async () => {
        if (abort.signal.aborted || client.application?.id !== config.applicationId) return;
        if (message.author.bot || message.webhookId || message.system) return;
        const route: Route = {
          channelId: message.channelId,
          userId: message.author.id,
          guildId: message.guildId,
          parentId: message.channel.isThread() ? message.channel.parentId : null,
          isDM: message.channel.type === ChannelType.DM,
          mentioned: message.mentions.users.has(client.user!.id),
          knownConversation: store.has(message.channelId),
        };
        if (!authorized(config, route)) return;
        if (message.attachments.size || !message.content.trim()) {
          await message.reply({ content: 'Text messages only for now; paste the relevant text.', ...safeSend });
          return;
        }
        const text = message.content.replace(new RegExp(`<@!?${client.user!.id}>`, 'g'), '').trim() || message.content;
        // In thread mode a top-level message opens the thread that becomes the conversation.
        let conversation = message.channelId;
        if (!route.isDM && !message.channel.isThread() && accessEntry(config.access, route)?.sessions === 'threads') {
          if (!message.channel.isThreadOnly() && 'threads' in message.channel) {
            try {
              const thread = await message.startThread({
                name: threadName(text),
                autoArchiveDuration: 1440,
                reason: 'aivi conversation',
              });
              conversation = thread.id;
            } catch (error) {
              log.warn('thread.create.failed', { channel: message.channelId, error });
              await message.reply({ content: 'I need permission to create threads in this channel.', ...safeSend });
              return;
            }
          }
        }
        try {
          store.enqueue(
            {
              id: message.id,
              channel: conversation,
              user: message.author.id,
              name: message.member?.displayName ?? message.author.displayName,
              text,
            },
            config.maxPending,
          );
          engine?.tick(); // pick it up now; the poll loop is only the fallback
          if (store.state(message.id) === 'queued') await acknowledgeQueued(message);
        } catch (error) {
          log.warn('enqueue.rejected', { channel: message.channelId, error });
          await message.reply({
            content: 'I could not queue this message. The queue may be full; check /status.',
            ...safeSend,
          });
        }
      })().catch(error => log.error('message.failed', { error }));
    });

    client.on(Events.InteractionCreate, interaction => {
      void (async () => {
        if (abort.signal.aborted || client.application?.id !== config.applicationId) return;
        if (!interaction.isChatInputCommand() || !(COMMANDS as readonly string[]).includes(interaction.commandName))
          return;
        const channel = interaction.channel;
        const route: Route = {
          channelId: interaction.channelId,
          userId: interaction.user.id,
          guildId: interaction.guildId,
          parentId: channel?.isThread() ? channel.parentId : null,
          isDM: interaction.guildId === null,
          mentioned: true, // a slash command is an explicit address
          knownConversation: store.has(interaction.channelId),
        };
        if (!authorized(config, route)) {
          await interaction.reply({
            content: 'This user or conversation is not enabled for aivi.',
            flags: MessageFlags.Ephemeral,
          });
          return;
        }
        if (interaction.commandName === 'search') {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          try {
            const project = interaction.options.getString('project');
            const hits = await services.knowledge.search({
              query: interaction.options.getString('query', true),
              limit: 3,
              ...(project ? { projects: [project] } : {}),
            });
            const content = hits.length
              ? splitReply(
                  hits.map(h => `${h.title} — ${h.path}:${h.line}\n${h.excerpt}`).join('\n\n'),
                  DISCORD.replyLimit,
                )[0]!
              : 'No matching documents.';
            await interaction.editReply({
              content,
              allowedMentions: safeSend.allowedMentions,
              flags: MessageFlags.SuppressEmbeds,
            });
          } catch (error) {
            log.warn('search.failed', { error });
            await interaction.editReply('Search is unavailable or the project is unknown.');
          }
          return;
        }
        let content: string;
        // In thread mode the channel itself is never a conversation; /new, /status and /context belong in a thread.
        if (!route.isDM && route.parentId === null && accessEntry(config.access, route)?.sessions === 'threads') {
          content = 'Run this inside a thread. In this channel every conversation is its own thread.';
        } else if (interaction.commandName === 'context') {
          await interaction.deferReply({ flags: MessageFlags.Ephemeral });
          try {
            content = await describeConversation(
              store,
              interaction.channelId,
              config,
              services.loaded,
              services.opencode,
            );
          } catch (error) {
            log.warn('context.failed', { error });
            content = 'I could not read this session from OpenCode just now.';
          }
          await interaction.editReply({ content, allowedMentions: safeSend.allowedMentions });
          return;
        } else if (interaction.commandName === 'new') {
          try {
            store.reset(interaction.channelId);
            content = 'The next message starts a fresh session. Previous sessions remain in OpenCode.';
          } catch {
            content = 'This conversation has queued or unresolved work. Finish or resolve it before starting fresh.';
          }
        } else {
          const pending = store.list(interaction.channelId).filter(t => !['sent', 'discarded'].includes(t.state));
          const host = status(services.store, services.loaded);
          const upcoming = host.upcoming
            .map(u => `${u.id} at ${new Date(u.nextAt).toISOString().slice(0, 16).replace('T', ' ')} UTC`)
            .join(', ');
          const tally = new Map<string, number>();
          for (const r of host.recent) tally.set(r.state, (tally.get(r.state) ?? 0) + 1);
          const recent = [...tally].map(([state, n]) => `${n} ${state}`).join(', ');
          content = [
            pending.length
              ? `${pending.length} pending turn(s): ${[...new Set(pending.map(t => t.state))].join(', ')}. Blocked turns require operator inspection.`
              : 'Ready for your next message.',
            upcoming ? `Next jobs: ${upcoming}.` : 'No jobs are due.',
            recent ? `Runs in the last 24 h: ${recent}.` : 'No runs finished in the last 24 h.',
          ].join('\n');
        }
        await interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: safeSend.allowedMentions });
      })().catch(error => log.error('command.failed', { error }));
    });

    try {
      await Promise.all([
        once(client, Events.ClientReady, { signal: AbortSignal.any([abort.signal, AbortSignal.timeout(30000)]) }),
        client.login(token),
      ]);
    } catch (error) {
      // discord.js names a rejected token; everything else (gateway 5xx, DNS) is worth another try.
      if ((error as { code?: unknown }).code === 'TokenInvalid') throw new ConfigurationError(errorMessage(error));
      throw error;
    }
    if (client.application?.id !== config.applicationId)
      throw new ConfigurationError('Discord token does not match configured application');
    log.info('ready', {
      application: config.applicationId,
      agent: config.agent,
      reportChannels: config.reportChannels.length,
    });
    // Commands follow the code: register at every start so a new command needs no manual step.
    // Best effort; Discord's API being slow is no reason to keep the conversations waiting.
    registerDiscordCommands(config).then(
      () => log.info('commands.registered', { commands: COMMANDS }),
      error => log.warn('commands.register_failed', { error }),
    );

    // Nobody waits in silence: each conversation with an interrupted turn hears about it once.
    for (const channel of new Set(interrupted.map(t => t.channel))) {
      const partial = interrupted.some(t => t.channel === channel && t.state === 'replying');
      void (async () => {
        const c = await client.channels.fetch(channel);
        if (!c?.isSendable()) return;
        await c.send({
          content: partial
            ? 'I was restarted while replying, so my last answer may be incomplete. Ask again if you need it.'
            : 'I was restarted while working on your last message. Please send it again.',
          ...safeSend,
        });
      })().catch(error => log.warn('notify.failed', { channel, error }));
    }

    // Proactive posts only go where the operator said they may. A post opens a thread that is a
    // conversation: replying continues the job's own session (agent jobs) or a fresh one seeded with
    // the output (script jobs), so "what is this about?" never happens. A job's outcome for a session
    // this module owns comes back into its thread as a turn, in order with everything said there.
    const unregister = services.channels.register({
      id: DISCORD.id,
      accepts: channelId => config.reportChannels.includes(channelId),
      ownsSession: session => store.channelOf(session) !== null,
      async channelOf(session) {
        // A thread's reports go to its parent channel; a channel-mode conversation or a DM is its own.
        const conversation = store.channelOf(session);
        if (!conversation) return undefined;
        const channel = await client.channels.fetch(conversation).catch(() => null);
        return channel?.isThread() ? (channel.parentId ?? undefined) : conversation;
      },
      async reenter(session, text, context) {
        store.enqueueJobResult(context.run.id, session, text, config.maxPending);
        engine?.tick();
      },
      async post(channelId, text, context) {
        if (!config.reportChannels.includes(channelId))
          throw new Error(`Discord channel ${channelId} is not in reportChannels`);
        const channel = await client.channels.fetch(channelId);
        if (!channel?.isSendable()) throw new Error('Discord channel is not sendable');
        const [first, ...rest] = splitReply(text, DISCORD.replyLimit);
        const opener = await channel.send({ content: first!, ...safeSend });
        let target = channel;
        if (!channel.isThread() && !channel.isDMBased() && 'threads' in channel && !channel.isThreadOnly()) {
          try {
            const { run } = context;
            let title: string | undefined;
            try {
              title = services.store.job(run.jobId).spec.title;
            } catch {
              // The job was removed after its run finished; the text names it.
            }
            const thread = await opener.startThread({
              name: title ?? threadName(text),
              autoArchiveDuration: 1440,
              reason: `aivi run ${run.id}`,
            });
            target = thread;
            store.adopt(
              thread.id,
              run.task.kind === 'opencode.prompt' && run.sessionId
                ? { session: run.sessionId, agent: run.task.agent, directory: run.task.directory }
                : { seed: text },
            );
          } catch (error) {
            log.warn('report.thread.failed', { channel: channelId, error });
          }
        }
        for (const chunk of rest) await target.send({ content: chunk, ...safeSend });
      },
    });

    // Turns are picked up when they arrive, when capacity frees inside this module, and when the
    // host says capacity moved elsewhere (a job finished). Nothing polls.
    const unsubscribeWake = services.onWake(() => {
      if (client.isReady()) engine!.tick();
    });

    return {
      async stop() {
        unregister();
        unsubscribeWake();
        await teardown();
      },
    };
  } catch (error) {
    await teardown();
    throw error;
  }
}

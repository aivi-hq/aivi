import type { AccessRoute } from '@aivi/core';
import { accessEntry } from '@aivi/core';
import type { ChannelDelivery, ChannelPlatform, HostModule, HostServices, Store, Turn } from '@aivi/host';
import {
  announce,
  CHAT_COMMANDS,
  ChannelEngine,
  ConversationStore,
  createTurnRunner,
  describeConversation,
  describeJobs,
  describeModel,
  helpText,
  isChatCommand,
  OFFLINE_NOTICE,
  ONLINE_NOTICE,
  splitReply,
  status,
  steerTurn,
  stopTurn,
  switchModel,
  usageHint,
} from '@aivi/host';
import type { SlackConfig } from './config.ts';
import { authorized, isDMChannelId } from './config.ts';
import type { SlackCommand, SlackConnection, SlackEvent } from './connection.ts';
import { createSocketModeConnection, requireSlackTokens } from './connection.ts';

/** Slack's limit is 4000 characters (`chat.postMessage` truncates at 40 000; the UI collapses above 4000). */
export const SLACK: ChannelPlatform = { id: 'slack', label: 'Slack', replyLimit: 3900 };
const WAITING = 'hourglass_flowing_sand';
/** Slack has no typing indicator for bots; 👀 on the message says the agent is on it. */
const WORKING = 'eyes';

export function bindingFor(config: SlackConfig): string {
  return JSON.stringify({ agent: config.agent, directory: config.directory });
}
/** The Slack inbox in the host database; the CLI and the module open the same one. */
export function openSlackStore(store: Store, config: SlackConfig): ConversationStore {
  return new ConversationStore(store, SLACK, bindingFor(config));
}

/**
 * The `slash_commands` block of the app manifest, from the shared command table. Slack has
 * no API for slash commands, so docs/slack.md carries this text and a test keeps it current.
 */
export function slackManifestCommands(prefix = '{prefix}'): string {
  // A plain YAML scalar cannot start with an indicator (`[model]`) or contain `: `, `#` or quotes.
  const scalar = (text: string) => (/^[[\]{}&*!|>'"%@`]|[:#"]/.test(text) ? JSON.stringify(text) : text);
  return CHAT_COMMANDS.map(command => {
    const usage = usageHint(command);
    return [
      `    - command: /${prefix}-${command.name}`,
      `      description: ${scalar(command.description)}`,
      ...(usage ? [`      usage_hint: ${scalar(usage)}`] : []),
      '      should_escape: false',
    ].join('\n');
  }).join('\n');
}

/** A conversation is a DM channel, a whole channel, or a thread as `channel:thread_ts`. */
export const conversationParts = (conversation: string): { channel: string; threadTs?: string } => {
  const [channel, threadTs] = conversation.split(':');
  return threadTs ? { channel: channel!, threadTs } : { channel: channel! };
};

export interface Routed {
  route: AccessRoute;
  /** Where the turn lives and replies go; a top-level message in thread mode opens a thread on itself. */
  conversation: string;
  text: string;
}

/**
 * Map a Slack message onto the shared access route. Mentions are `app_mention`
 * events or `<@bot>` in the text; Slack sends both for one message, so callers
 * dedupe on `channel:ts` before this. Returns null for messages aivi ignores
 * outright (its own, other bots, edits, joins, and other subtypes).
 */
export function routeMessage(
  config: SlackConfig,
  botUserId: string,
  event: SlackEvent,
  known: (conversation: string) => boolean,
): Routed | null {
  if (event.bot_id || event.subtype || !event.user || event.user === botUserId) return null;
  const mention = `<@${botUserId}>`;
  const raw = event.text ?? '';
  const text = raw.replaceAll(mention, '').trim() || raw.trim();
  const isDM = event.channel_type === 'im' || (!event.channel_type && isDMChannelId(event.channel));
  const inThread = !isDM && event.thread_ts !== undefined && event.thread_ts !== event.ts;
  const conversation = isDM ? event.channel : inThread ? `${event.channel}:${event.thread_ts}` : event.channel;
  const route: AccessRoute = {
    channelId: conversation,
    parentId: inThread ? event.channel : null,
    userId: event.user,
    isDM,
    mentioned: event.type === 'app_mention' || raw.includes(mention),
    knownConversation: known(conversation),
  };
  if (!authorized(config, route)) return null;
  const opensThread = !isDM && !inThread && accessEntry(config.access, route)?.sessions === 'threads';
  return { route, conversation: opensThread ? `${event.channel}:${event.ts}` : conversation, text };
}

export function createSlackModule(config: SlackConfig, connection?: SlackConnection): HostModule {
  return { id: SLACK.id, start: services => startSlack(config, services, connection) };
}

async function startSlack(config: SlackConfig, services: HostServices, given?: SlackConnection) {
  const log = services.log.getChild('slack');
  const slack = given ?? createSocketModeConnection(requireSlackTokens(), log);
  const store = openSlackStore(services.store, config);
  if (store.rebound)
    log.warn('binding.changed', { hint: 'Every conversation starts a fresh session on its next message.' });
  const interrupted = store.recover();
  if (interrupted.length) log.warn('turns.interrupted', { discarded: interrupted.length });

  const abort = new AbortController();
  let engine: ChannelEngine | undefined;
  const stop = () => {
    abort.abort();
    engine?.stop();
  };
  services.signal.addEventListener('abort', stop, { once: true });
  let ready = false;
  const teardown = async () => {
    stop();
    try {
      if (ready) await announce(config.reportChannels, (c, t) => slack.post(c, t), OFFLINE_NOTICE, log);
      await engine?.shutdown();
    } finally {
      await slack.disconnect().catch(error => log.warn('disconnect.failed', { error }));
      services.signal.removeEventListener('abort', stop);
    }
  };

  const send = async (conversation: string, text: string) => {
    const { channel, threadTs } = conversationParts(conversation);
    return (await slack.post(channel, text, threadTs)).ts;
  };
  const delivery: ChannelDelivery = {
    send,
    edit: (conversation, ts, text) => slack.update(conversationParts(conversation).channel, ts, text),
    delete: (conversation, ts) => slack.remove(conversationParts(conversation).channel, ts),
  };

  try {
    const { userId: botUserId } = await slack.identify();
    const ask = await createTurnRunner(
      SLACK,
      config,
      services.loaded,
      services.opencode,
      services.events,
      services.log,
    );
    const names = new Map<string, Promise<string>>();
    const nameOf = (user: string) => {
      let name = names.get(user);
      if (!name) {
        name = slack.userName(user);
        names.set(user, name);
      }
      return name;
    };
    // The ⏳ reaction marks a message waiting behind other work; 👀 replaces it while the agent works
    // and goes when the answer is ready to post. Job turns have no message to react to.
    const messageOf = (turn: Turn): [string, string] | null => {
      if (turn.kind !== 'message') return null;
      const [channel, ts] = turn.id.split(':');
      return channel && ts ? [channel, ts] : null;
    };
    const working = async (turn: Turn) => {
      const at = messageOf(turn);
      if (!at) return;
      await slack.unreact(at[0], at[1], WAITING).catch(() => {});
      await slack.react(at[0], at[1], WORKING).catch(() => {});
    };
    const done = async (turn: Turn) => {
      const at = messageOf(turn);
      if (at) await slack.unreact(at[0], at[1], WORKING).catch(() => {});
    };
    engine = new ChannelEngine(
      store,
      config,
      services.loaded.config.scheduler,
      async (turn, signal, ready) => {
        void working(turn);
        try {
          return await ask(turn, signal, ready);
        } finally {
          void done(turn);
        }
      },
      delivery,
      {
        log: services.log,
        onRelease: services.wake,
        onFailure: services.fail,
        progress: { mode: config.progress, events: services.events },
      },
    );

    // Slack delivers a mention twice (`app_mention` and `message`); the first one wins.
    const seen = new Set<string>();
    const first = (id: string) => {
      if (seen.has(id)) return false;
      seen.add(id);
      if (seen.size > 1000) seen.delete(seen.values().next().value!);
      return true;
    };
    const onEvent = async (event: SlackEvent) => {
      if (abort.signal.aborted) return;
      const id = `${event.channel}:${event.ts}`;
      const routed = routeMessage(config, botUserId, event, c => store.has(c));
      if (!routed || !first(id)) return;
      const replyTo = routed.route.isDM ? event.channel : routed.conversation;
      if (event.files?.length || !routed.text) {
        await send(replyTo, 'Text messages only for now; paste the relevant text.');
        return;
      }
      try {
        store.enqueue(
          { id, channel: routed.conversation, user: event.user!, name: await nameOf(event.user!), text: routed.text },
          config.maxPending,
        );
        engine?.tick(); // pick it up now; the poll loop is only the fallback
        if (store.state(id) === 'queued') await slack.react(event.channel, event.ts, WAITING).catch(() => {});
      } catch (error) {
        log.warn('enqueue.rejected', { channel: event.channel, error });
        await send(
          replyTo,
          `I could not queue this message. The queue may be full; check /${config.commandPrefix}-status.`,
        );
      }
    };

    const onCommand = async (command: SlackCommand) => {
      if (abort.signal.aborted) return;
      const name = command.command.replace(/^\//, '').slice(config.commandPrefix.length + 1);
      if (!command.command.startsWith(`/${config.commandPrefix}-`) || !isChatCommand(name)) return;
      const channel = command.channel_id;
      const route: AccessRoute = {
        channelId: channel,
        parentId: null,
        userId: command.user_id,
        isDM: isDMChannelId(channel),
        mentioned: true, // a slash command is an explicit address
        knownConversation: store.has(channel),
      };
      const reply = (text: string) => slack.ephemeral(command.response_url, text);
      const spell = (n: string) => `/${config.commandPrefix}-${n}`;
      if (!authorized(config, route)) return reply('This user or conversation is not enabled for aivi.');
      if (name === 'help') return reply(helpText(spell));
      if (name === 'jobs') return reply(describeJobs(services.store));
      if (name === 'search') {
        // `QUERY [project]`: the last word is a project only when it names a configured one.
        const words = command.text.trim().split(/\s+/).filter(Boolean);
        const last = words.at(-1);
        const project = words.length > 1 && services.loaded.projects.some(p => p.id === last) ? words.pop() : undefined;
        const query = words.join(' ');
        if (!query) return reply(`Usage: ${spell('search')} QUERY [project]`);
        try {
          const hits = await services.knowledge.search({
            query,
            limit: 3,
            ...(project ? { projects: [project] } : {}),
          });
          return reply(
            hits.length
              ? splitReply(
                  hits.map(h => `${h.title} — ${h.path}:${h.line}\n${h.excerpt}`).join('\n\n'),
                  SLACK.replyLimit,
                )[0]!
              : 'No matching documents.',
          );
        } catch (error) {
          log.warn('search.failed', { error });
          return reply('Search is unavailable or the project is unknown.');
        }
      }
      // Slash commands carry no thread, so in thread mode they speak for the channel: every new
      // top-level message is already a fresh conversation, and status covers all its threads.
      // Anything that acts on one conversation cannot tell which thread is meant.
      const threads = !route.isDM && accessEntry(config.access, route)?.sessions === 'threads';
      if (threads && ['context', 'model', 'stop', 'steer'].includes(name))
        return reply(
          'In this channel every thread is its own conversation; slash commands cannot tell which one you mean.',
        );
      if (name === 'context') {
        try {
          return reply(await describeConversation(store, channel, config, services.loaded, services.opencode));
        } catch (error) {
          log.warn('context.failed', { error });
          return reply('I could not read this session from OpenCode just now.');
        }
      }
      if (name === 'model') {
        const wanted = command.text.trim();
        try {
          return reply(
            wanted
              ? await switchModel(store, channel, config, services.opencode, wanted)
              : await describeModel(store, channel, config, services.opencode),
          );
        } catch (error) {
          log.warn('model.failed', { error });
          return reply('I could not read the model catalogue from OpenCode just now.');
        }
      }
      if (name === 'stop') {
        const result = await stopTurn(engine!, services.opencode, channel);
        if (result.error) log.warn('stop.interrupt_failed', { error: result.error });
        return reply(result.text);
      }
      if (name === 'steer') {
        const text = command.text.trim();
        if (!text) return reply(`Usage: ${spell('steer')} TEXT`);
        const speaker = { name: await nameOf(command.user_id), user: command.user_id };
        const result = await steerTurn(store, SLACK, services.opencode, channel, speaker, text);
        if (result.error) log.warn('steer.failed', { error: result.error });
        return reply(result.text);
      }
      if (name === 'new') {
        if (threads)
          return reply('In this channel every thread is its own conversation; a new message starts a fresh one.');
        try {
          store.reset(channel);
          return reply('The next message starts a fresh session. Previous sessions remain in OpenCode.');
        } catch {
          return reply('This conversation has queued or unresolved work. Finish or resolve it before starting fresh.');
        }
      }
      const pending = store
        .list()
        .filter(t => (threads ? t.channel.startsWith(`${channel}:`) : t.channel === channel))
        .filter(t => !['sent', 'discarded'].includes(t.state));
      const host = status(services.store, services.loaded);
      const upcoming = host.upcoming
        .map(u => `${u.id} at ${new Date(u.nextAt).toISOString().slice(0, 16).replace('T', ' ')} UTC`)
        .join(', ');
      const tally = new Map<string, number>();
      for (const r of host.recent) tally.set(r.state, (tally.get(r.state) ?? 0) + 1);
      const recent = [...tally].map(([state, n]) => `${n} ${state}`).join(', ');
      return reply(
        [
          pending.length
            ? `${pending.length} pending turn(s): ${[...new Set(pending.map(t => t.state))].join(', ')}. Blocked turns require operator inspection.`
            : 'Ready for your next message.',
          upcoming ? `Next jobs: ${upcoming}.` : 'No jobs are due.',
          recent ? `Runs in the last 24 h: ${recent}.` : 'No runs finished in the last 24 h.',
        ].join('\n'),
      );
    };

    await slack.connect({ event: onEvent, command: onCommand });
    log.info('ready', { bot: botUserId, agent: config.agent, reportChannels: config.reportChannels.length });
    ready = true;
    void announce(config.reportChannels, (c, t) => slack.post(c, t), ONLINE_NOTICE, log);

    // Nobody waits in silence: each conversation with an interrupted turn hears about it once.
    for (const channel of new Set(interrupted.map(t => t.channel))) {
      const partial = interrupted.some(t => t.channel === channel && t.state === 'replying');
      void send(
        channel,
        partial
          ? 'I was restarted while replying, so my last answer may be incomplete. Ask again if you need it.'
          : 'I was restarted while working on your last message. Please send it again.',
      ).catch(error => log.warn('notify.failed', { channel, error }));
    }

    // Proactive posts only go where the operator said they may. The post's thread is a conversation:
    // replying continues the job's own session (agent jobs) or a fresh one seeded with the output
    // (script jobs). A job's outcome for a session this module owns comes back into its thread as a turn.
    const unregister = services.channels.register({
      id: SLACK.id,
      accepts: channel => config.reportChannels.includes(channel),
      ownsSession: session => store.channelOf(session) !== null,
      async channelOf(session) {
        const conversation = store.channelOf(session);
        return conversation ? conversationParts(conversation).channel : undefined;
      },
      async reenter(session, text, context) {
        store.enqueueJobResult(context.run.id, session, text, config.maxPending);
        engine?.tick();
      },
      async post(channel, text, context) {
        if (!config.reportChannels.includes(channel))
          throw new Error(`Slack channel ${channel} is not in reportChannels`);
        const [first, ...rest] = splitReply(text, SLACK.replyLimit);
        const { ts } = await slack.post(channel, first!);
        const thread = `${channel}:${ts}`;
        const { run } = context;
        try {
          store.adopt(
            thread,
            run && run.task.kind === 'prompt' && run.sessionId
              ? { session: run.sessionId, agent: run.task.agent, directory: run.task.directory }
              : { seed: text },
          );
        } catch (error) {
          log.warn('report.adopt.failed', { channel, error });
        }
        for (const chunk of rest) await slack.post(channel, chunk, ts);
      },
    });

    // Turns are picked up when they arrive, when capacity frees inside this module, and when the
    // host says capacity moved elsewhere (a job finished). Nothing polls.
    const unsubscribeWake = services.onWake(() => {
      engine!.tick();
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

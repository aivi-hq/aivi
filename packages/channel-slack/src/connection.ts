import type { Logger } from '@aivi/core';
import { ConfigurationError } from '@aivi/host';
import { SocketModeClient } from '@slack/socket-mode';
import { WebClient } from '@slack/web-api';

/** The parts of a Slack `message`/`app_mention` event the module reads. Untrusted input. */
export interface SlackEvent {
  type: 'message' | 'app_mention';
  channel: string;
  channel_type?: string;
  user?: string;
  ts: string;
  thread_ts?: string;
  text?: string;
  subtype?: string;
  bot_id?: string;
  files?: unknown[];
}
/** A slash command payload. */
export interface SlackCommand {
  command: string;
  text: string;
  user_id: string;
  channel_id: string;
  response_url: string;
}
export interface SlackHandlers {
  event(event: SlackEvent): Promise<void>;
  command(command: SlackCommand): Promise<void>;
}

/**
 * Everything the module needs from Slack, small enough to fake in tests. The
 * real one runs Socket Mode (no public URL) and the Web API; events are
 * acknowledged before they are handled, so a slow turn never makes Slack retry.
 */
export interface SlackConnection {
  /** The bot's own user id (`auth.test`), needed to recognise mentions and ignore own messages. */
  identify(): Promise<{ userId: string }>;
  connect(handlers: SlackHandlers): Promise<void>;
  disconnect(): Promise<void>;
  post(channel: string, text: string, threadTs?: string): Promise<{ ts: string }>;
  /** Ephemeral reply to a slash command through its `response_url`. */
  ephemeral(responseUrl: string, text: string): Promise<void>;
  react(channel: string, ts: string, name: string): Promise<void>;
  unreact(channel: string, ts: string, name: string): Promise<void>;
  /** Display name for a user id; the id itself when it cannot be read. */
  userName(userId: string): Promise<string>;
}

export function requireSlackTokens(env: NodeJS.ProcessEnv = process.env): { bot: string; app: string } {
  const bot = env.SLACK_BOT_TOKEN;
  const app = env.SLACK_APP_TOKEN;
  if (!bot || !app)
    throw new ConfigurationError(
      'SLACK_BOT_TOKEN (xoxb-…) and SLACK_APP_TOKEN (xapp-…) are required (a .env next to aivi.json is loaded automatically)',
    );
  return { bot, app };
}

export function createSocketModeConnection(tokens: { bot: string; app: string }, log: Logger): SlackConnection {
  const web = new WebClient(tokens.bot, { retryConfig: { retries: 0 }, timeout: 15000 });
  const socket = new SocketModeClient({ appToken: tokens.app, clientOptions: { retryConfig: { retries: 0 } } });
  const guard = (promise: Promise<unknown>, event: string) => promise.catch(error => log.error(event, { error }));
  return {
    async identify() {
      let auth: Awaited<ReturnType<typeof web.auth.test>>;
      try {
        auth = await web.auth.test();
      } catch (error) {
        // Slack names a bad token (`invalid_auth`, `account_inactive`); anything else may pass next time.
        const code = (error as { data?: { error?: string } }).data?.error;
        if (code === 'invalid_auth' || code === 'account_inactive' || code === 'token_revoked')
          throw new ConfigurationError(`Slack rejected SLACK_BOT_TOKEN: ${code}`);
        throw error;
      }
      if (!auth.user_id) throw new Error('Slack auth.test returned no user id');
      return { userId: auth.user_id };
    },
    async connect(handlers) {
      // Socket Mode disconnects are routine; the client reconnects on its own. An optional adapter
      // must never take the knowledge server and scheduler down with it.
      socket.on('error', error => log.warn('gateway.error', { error }));
      socket.on('disconnected', () => log.warn('gateway.disconnected'));
      socket.on('reconnecting', () => log.info('gateway.reconnecting'));
      for (const type of ['message', 'app_mention'] as const) {
        socket.on(type, async ({ ack, event }: { ack: () => Promise<void>; event: SlackEvent }) => {
          await ack();
          void guard(handlers.event({ ...event, type }), 'event.failed');
        });
      }
      socket.on('slash_commands', async ({ ack, body }: { ack: () => Promise<void>; body: SlackCommand }) => {
        await ack();
        void guard(handlers.command(body), 'command.failed');
      });
      await socket.start();
    },
    async disconnect() {
      await socket.disconnect();
    },
    async post(channel, text, threadTs) {
      const result = await web.chat.postMessage({
        channel,
        text,
        ...(threadTs ? { thread_ts: threadTs } : {}),
        unfurl_links: false,
        unfurl_media: false,
      });
      if (!result.ts) throw new Error('Slack did not return a message timestamp');
      return { ts: result.ts };
    },
    async ephemeral(responseUrl, text) {
      const response = await fetch(responseUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ response_type: 'ephemeral', text }),
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) throw new Error(`Slack response_url answered ${response.status}`);
    },
    async react(channel, ts, name) {
      await web.reactions.add({ channel, timestamp: ts, name });
    },
    async unreact(channel, ts, name) {
      await web.reactions.remove({ channel, timestamp: ts, name });
    },
    async userName(userId) {
      try {
        const { user } = await web.users.info({ user: userId });
        return user?.profile?.display_name || user?.real_name || user?.name || userId;
      } catch {
        return userId;
      }
    },
  };
}

import type { OpenCodeClient } from '../opencode.ts';
import type { Store } from '../store.ts';
import type { ChannelPlatform } from './contract.ts';
import type { ChannelEngine } from './engine.ts';
import { formatDuration } from './progress.ts';
import type { ConversationStore } from './store.ts';
import { messageIdFor, speakerLine } from './turns.ts';

export interface ChatCommandArgument {
  name: string;
  description: string;
  required: boolean;
  /** Discord offers choices for this argument from the named catalogue. */
  autocomplete?: 'model';
}
/** One chat command, the same on every platform; the adapters translate names and arguments. */
export interface ChatCommand {
  name: string;
  /** Under 100 characters: Discord's limit for a command description. */
  description: string;
  /** Acts on one conversation: refused where a slash command cannot name one (a threads-mode channel). */
  conversation: boolean;
  arguments: ChatCommandArgument[];
}

/**
 * The one list of chat commands. Discord registers it, Slack checks it against
 * its manifest, and `/help` reads it, so the platforms cannot drift apart.
 */
export const CHAT_COMMANDS = [
  { name: 'new', description: 'Start a fresh conversation', conversation: true, arguments: [] },
  { name: 'status', description: 'Show this conversation status', conversation: true, arguments: [] },
  {
    name: 'context',
    description: 'What this conversation’s session knows: model, window, tokens, knowledge in scope',
    conversation: true,
    arguments: [],
  },
  {
    name: 'search',
    description: 'Search team knowledge',
    conversation: false,
    arguments: [
      { name: 'query', description: 'Search terms', required: true },
      { name: 'project', description: 'Optional project ID; includes core knowledge', required: false },
    ],
  },
  {
    name: 'model',
    description: 'Show or switch this conversation’s model (until /new)',
    conversation: true,
    arguments: [
      {
        name: 'model',
        description: 'provider/model or provider/model@variant; "default" unpins; empty shows',
        required: false,
        autocomplete: 'model',
      },
    ],
  },
  { name: 'stop', description: 'Stop the turn running in this conversation', conversation: true, arguments: [] },
  {
    name: 'steer',
    description: 'Tell the agent something while it works on this conversation',
    conversation: true,
    arguments: [{ name: 'text', description: 'What to say', required: true }],
  },
  { name: 'jobs', description: 'Upcoming job occurrences and recent runs', conversation: false, arguments: [] },
  { name: 'help', description: 'List aivi’s commands', conversation: false, arguments: [] },
] as const satisfies readonly ChatCommand[];
export type ChatCommandName = (typeof CHAT_COMMANDS)[number]['name'];

export const isChatCommand = (name: string): name is ChatCommandName => CHAT_COMMANDS.some(c => c.name === name);
export const chatCommand = (name: ChatCommandName): ChatCommand => CHAT_COMMANDS.find(c => c.name === name)!;

/** `QUERY [project]`: the argument line Slack's manifest and `/help` show. */
export const usageHint = (command: ChatCommand) =>
  command.arguments.map(a => (a.required ? a.name.toUpperCase() : `[${a.name}]`)).join(' ');

/** `/help`: one line per command, named as the platform spells it (`/new`, `/aivi-new`). */
export function helpText(render: (name: string) => string): string {
  return CHAT_COMMANDS.map(c => {
    const usage = usageHint(c);
    return `\`${render(c.name)}${usage ? ` ${usage}` : ''}\` — ${c.description}`;
  }).join('\n');
}

const when = (at: number) => `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const ICON: Record<string, string> = {
  succeeded: '✅',
  failed: '❌',
  blocked: '⏸',
  cancelled: '🚫',
  missed: '⏭',
};

/** `/jobs`: the next occurrences and the last runs, as markdown both platforms render. */
export function describeJobs(store: Store, now = Date.now()): string {
  const jobs = store.jobs();
  const titles = new Map(jobs.map(j => [j.spec.id, j.spec.title]));
  const named = (id: string) => `\`${id}\`${titles.get(id) ? ` — ${titles.get(id)}` : ''}`;
  const upcoming = jobs
    .filter(j => j.state === 'active' && j.nextAt !== null)
    .slice(0, 5)
    .map(j => {
      const due = j.nextAt! <= now ? 'due now' : `in ${formatDuration(j.nextAt! - now)}`;
      return `- ${named(j.spec.id)} · ${due} (${when(j.nextAt!)})`;
    });
  const recent = store
    .recent(0, 10)
    .map(r => `- ${ICON[r.state] ?? '❔'} ${named(r.jobId)} ${r.state} · ${when(r.finishedAt ?? now)}`);
  return [
    '**Next occurrences**',
    ...(upcoming.length ? upcoming : ['No jobs are due.']),
    '',
    '**Last runs**',
    ...(recent.length ? recent : ['No runs have finished yet.']),
  ].join('\n');
}

const NOTHING_RUNNING = 'Nothing is running in this conversation.';

/**
 * `/stop`: end the turn the agent is working on in this conversation. The engine's
 * abort comes first so the turn is discarded as a stop and not as a failure once
 * OpenCode reports the interruption; then the native session is interrupted so
 * the agent stops spending. Queued messages stay queued and follow.
 */
export async function stopTurn(
  engine: ChannelEngine,
  opencode: () => Promise<OpenCodeClient>,
  channel: string,
  signal: AbortSignal = AbortSignal.timeout(10_000),
): Promise<{ text: string; stopped: boolean; error?: unknown }> {
  const turn = engine.stopTurn(channel);
  if (!turn) return { text: NOTHING_RUNNING, stopped: false };
  if (!turn.ready) return { text: 'Stopped.', stopped: true }; // the session was still being created; no prompt to interrupt
  try {
    const client = await opencode();
    await client.session.interrupt({ sessionID: turn.session }, { signal });
    return { text: 'Stopped.', stopped: true };
  } catch (error) {
    return {
      text: 'Stopped here, but I could not tell OpenCode to interrupt the agent; it may finish on its own in the background.',
      stopped: true,
      error,
    };
  }
}

/**
 * `/steer`: put words into the running turn instead of behind it (`delivery: "steer"`).
 * The message carries `metadata.aivi.steer = <running turn's native message id>` so the
 * turn's verification counts it as part of that turn. Nothing is queued when no turn runs.
 */
export async function steerTurn(
  store: ConversationStore,
  platform: ChannelPlatform,
  opencode: () => Promise<OpenCodeClient>,
  channel: string,
  speaker: { name: string; user: string },
  text: string,
  signal: AbortSignal = AbortSignal.timeout(10_000),
): Promise<{ text: string; steered: boolean; error?: unknown }> {
  const turn = store.running(channel);
  if (!turn?.ready) return { text: `${NOTHING_RUNNING} Send it as a message instead.`, steered: false };
  try {
    const client = await opencode();
    await client.session.prompt(
      {
        sessionID: turn.session,
        text: `${speakerLine(platform, speaker)}\n${text}`,
        delivery: 'steer',
        metadata: {
          aivi: { origin: platform.id, channel, user: speaker.user, steer: messageIdFor(platform, turn.id) },
        },
      },
      { signal },
    );
    return { text: 'Passed on to the agent mid-turn.', steered: true };
  } catch (error) {
    return { text: 'I could not reach the running turn; send it as a message instead.', steered: false, error };
  }
}

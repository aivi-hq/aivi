import { realpath, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { LoadedConfig, Logger, Person } from '@aivi/core';
import type { ChannelPlatform, Turn } from '@aivi/plugin/channel';
import type { Dispatcher } from '@aivi/plugin/dispatcher';
import type { OpenCodeClient, SessionEvents, Store } from '@aivi/plugin/module';
import { reentryPrompt } from '../reports.ts';
import { connectForTurn, runTurn, TurnNotStarted } from '../session.ts';
import type { Ask } from './engine.ts';

/** Native message id for a turn; only `[A-Za-z0-9_]` survive so any platform id fits. */
export const messageIdFor = (platform: ChannelPlatform, turnId: string) =>
  `msg_${platform.id}_${turnId.replaceAll(/[^A-Za-z0-9_]/g, '_')}`;

/** How a person's words are introduced to the agent; the platform may override the default line. */
export const speakerLine = (platform: ChannelPlatform, speaker: { name: string; user: string }) =>
  platform.describeSpeaker
    ? platform.describeSpeaker(speaker)
    : `[${platform.label} message from ${speaker.name} (user ${speaker.user})]`;

/** The prompt: who said it. A job's outcome re-enters as its own prompt, and a thread seeded with one (a script's output
 *  posted before any session existed) carries it ahead of the first turn. */
function promptText(platform: ChannelPlatform, turn: Turn, who: Person | null): string {
  const said = `${speakerLine(platform, { name: who?.name ?? turn.name, user: turn.user })}\n${turn.text}`;
  if (turn.kind === 'job') return reentryPrompt(turn.text);
  if (!turn.ready && turn.seed)
    return `[Earlier in this thread aivi posted this outcome of a scheduled job:]\n${turn.seed}\n\n${said}`;
  return said;
}

/**
 * What the lease's provide births the conversation's session from: the id the store pre-allocated is kept, the pool
 * decides the model unless a `/model` pin names one, and the origin that dreaming reviews is stamped where the
 * session is born.
 */
function sessionWork(platform: ChannelPlatform, turn: Turn, who: Person | null, agent: string, directory: string) {
  return {
    agent,
    directory,
    sessionId: turn.session,
    create: !turn.ready,
    title: `${platform.label} ${turn.channel}`,
    metadata: { aivi: { origin: platform.id, channel: turn.channel, ...(who ? { person: who.id } : {}) } },
    ...(turn.model
      ? {
          model: {
            providerID: turn.model.providerID,
            id: turn.model.modelID,
            ...(turn.model.variant ? { variant: turn.model.variant } : {}),
          },
        }
      : {}),
  };
}

/** Where the prompt came from, for the memories and outcomes that must know. */
function messageMetadata(platform: ChannelPlatform, turn: Turn, who: Person | null) {
  return {
    aivi:
      turn.kind === 'job'
        ? { origin: 'job-result', channel: turn.channel, run: turn.id.slice('run:'.length) }
        : {
            origin: platform.id,
            channel: turn.channel,
            user: turn.user,
            sourceMessage: turn.id,
            ...(who ? { person: who.id } : {}),
          },
  };
}

/**
 * One conversation turn = one verified turn of the configured agent's native session.
 * The agent file is the whole boundary: aivi adds nothing but `external_directory`
 * allows for the configured knowledge sources, which the agent file cannot know.
 * Permission prompts are auto-rejected because nobody sits at the server.
 */
export async function createTurnRunner(
  platform: ChannelPlatform,
  config: { agent: string; directory: string },
  loaded: LoadedConfig,
  opencode: () => Promise<OpenCodeClient>,
  events: SessionEvents,
  store: Store,
  dispatcher: Dispatcher,
  log?: Logger,
): Promise<Ask> {
  const permissions: { action: string; resource: string; effect: 'allow' }[] = [];
  // Sources may be files or directories. Match native canonical external-directory boundaries.
  // A repository without the conventional directory is normal (knowledge.md): a missing
  // source is a vacuous allow, already warned once as `knowledge.missing` by the index.
  for (const source of loaded.sources) {
    const path = await realpath(source.path).catch(() => null);
    if (!path) continue;
    const directory = (await stat(path)).isDirectory() ? path : dirname(path);
    if (/[?*]/.test(directory)) throw new Error('Knowledge directory contains native permission wildcard characters');
    permissions.push({
      action: 'external_directory',
      resource: `${directory.replaceAll('\\', '/')}/**`,
      effect: 'allow',
    });
  }
  return async (turn, signal, ready, lease) => {
    const client = await connectForTurn(opencode);
    // A conversation that adopted a job's session keeps that session's agent and directory.
    const agent = turn.agent ?? config.agent;
    const directory = turn.directory ?? config.directory;
    // A linked channel account speaks as its aivi person, in the prompt and
    // in the metadata, so memories and outcomes know who it was.
    const who = turn.kind === 'message' ? store.identityFor(platform.id, turn.user) : null;
    const text = promptText(platform, turn, who);
    if (!lease) throw new Error(`${platform.label} turn: no dispatcher slot; the engine grants one before asking`);
    if (lease.state === 'preparing') {
      // The lease's provide births the conversation's session; a conversation
      // that already has its session resumes as it was. A provide that fails is
      // a turn that never started.
      await dispatcher.provide(lease.id, sessionWork(platform, turn, who, agent, directory)).catch(error => {
        throw new TurnNotStarted(error);
      });
      if (!turn.ready) ready();
    }
    const result = await runTurn(
      client,
      {
        sessionId: turn.session,
        agent,
        directory,
        create: false, // the lease's provide created it; the conversation keeps its history
        permissions,
        messageId: messageIdFor(platform, turn.id),
        // Role behaviour lives in the agent definition; the prompt only carries who said what.
        text,
        messageMetadata: messageMetadata(platform, turn, who),
        // A `/model` pin outranks the pool's choice; prepareSession applies it to the session.
        ...(turn.model ? { model: turn.model } : {}),
      },
      { signal, onPermission: 'reject', events, ...(log ? { log } : {}) },
    );
    return result.text;
  };
}

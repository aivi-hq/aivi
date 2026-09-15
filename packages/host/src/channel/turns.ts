import { realpath, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { LoadedConfig, Logger } from '@aivi/core';
import type { SessionEvents } from '../events.ts';
import type { OpenCodeClient } from '../opencode.ts';
import { reentryPrompt } from '../reports.ts';
import { connectForTurn, runTurn } from '../session.ts';
import type { ChannelPlatform } from './contract.ts';
import type { Ask } from './engine.ts';

/** Native message id for a turn; only `[A-Za-z0-9_]` survive so any platform id fits. */
export const messageIdFor = (platform: ChannelPlatform, turnId: string) =>
  `msg_${platform.id}_${turnId.replaceAll(/[^A-Za-z0-9_]/g, '_')}`;

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
  log?: Logger,
): Promise<Ask> {
  const permissions: { action: string; resource: string; effect: 'allow' }[] = [];
  // Sources may be files or directories. Match native canonical external-directory boundaries.
  for (const source of loaded.sources) {
    const path = await realpath(source.path);
    const directory = (await stat(path)).isDirectory() ? path : dirname(path);
    if (/[?*]/.test(directory)) throw new Error('Knowledge directory contains native permission wildcard characters');
    permissions.push({
      action: 'external_directory',
      resource: `${directory.replaceAll('\\', '/')}/**`,
      effect: 'allow',
    });
  }
  const speaker =
    platform.describeSpeaker ?? (turn => `[${platform.label} message from ${turn.name} (user ${turn.user})]`);

  return async (turn, signal, ready) => {
    const client = await connectForTurn(opencode);
    // A conversation that adopted a job's session keeps that session's agent and directory.
    const agent = turn.agent ?? config.agent;
    const directory = turn.directory ?? config.directory;
    const said = `${speaker(turn)}\n${turn.text}`;
    const text =
      turn.kind === 'job'
        ? reentryPrompt(turn.text)
        : !turn.ready && turn.seed
          ? `[Earlier in this thread aivi posted this outcome of a scheduled job:]\n${turn.seed}\n\n${said}`
          : said;
    const result = await runTurn(
      client,
      {
        sessionId: turn.session,
        agent,
        directory,
        create: !turn.ready,
        title: `${platform.label} ${turn.channel}`,
        sessionMetadata: { aivi: { origin: platform.id, channel: turn.channel } },
        permissions,
        messageId: messageIdFor(platform, turn.id),
        // Role behaviour lives in the agent definition; the prompt only carries who said what.
        text,
        messageMetadata: {
          aivi:
            turn.kind === 'job'
              ? { origin: 'job-result', channel: turn.channel, run: turn.id.slice('run:'.length) }
              : { origin: platform.id, channel: turn.channel, user: turn.user, sourceMessage: turn.id },
        },
      },
      { signal, onPermission: 'reject', events, onCreated: ready, ...(log ? { log } : {}) },
    );
    return result.text;
  };
}

import { realpath, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { LoadedConfig, Logger } from '@aivi/core';
import type { OpenCodeClient } from '@aivi/host';
import { connectForTurn, reentryPrompt, runTurn } from '@aivi/host';
import type { DiscordConfig } from './config.ts';
import type { Turn } from './store.ts';

export type NativeChat = (turn: Turn, signal: AbortSignal, ready: () => void) => Promise<string>;

/**
 * One Discord turn = one verified turn of the configured agent's native session.
 * The agent file is the whole boundary: aivi adds nothing but `external_directory`
 * allows for the configured knowledge sources, which the agent file cannot know.
 * Permission prompts are auto-rejected because nobody sits at the server.
 */
export async function createNativeChat(
  config: DiscordConfig,
  loaded: LoadedConfig,
  opencode: () => Promise<OpenCodeClient>,
  log?: Logger,
): Promise<NativeChat> {
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

  return async (turn, signal, ready) => {
    const client = await connectForTurn(opencode);
    const result = await runTurn(
      client,
      {
        sessionId: turn.session,
        agent: config.agent,
        directory: config.directory,
        create: !turn.ready,
        title: `Discord ${turn.channel}`,
        sessionMetadata: { aivi: { origin: 'discord', channel: turn.channel } },
        permissions,
        messageId: `msg_discord_${turn.id.replaceAll(':', '_')}`,
        // Role behaviour lives in the agent definition; the prompt only carries who said what.
        text:
          turn.kind === 'job'
            ? reentryPrompt(turn.text)
            : `[Discord message from ${turn.name} (user ${turn.user})]\n${turn.text}`,
        messageMetadata: {
          aivi:
            turn.kind === 'job'
              ? { origin: 'job-result', channel: turn.channel, job: turn.id.slice('job:'.length) }
              : { origin: 'discord', channel: turn.channel, user: turn.user, discordMessage: turn.id },
        },
      },
      { signal, onPermission: 'reject', onCreated: ready, ...(log ? { log } : {}) },
    );
    return result.text;
  };
}

import { realpath, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { runTurn } from '@aivi/host';
import type { OpenCodeClient } from '@aivi/host';
import type { LoadedConfig, Logger } from '@aivi/core';
import type { DiscordConfig } from './config.ts';
import type { Turn } from './store.ts';

export type NativeChat = (turn: Turn, signal: AbortSignal, ready: () => void) => Promise<string>;

/**
 * One Discord turn = one verified turn of a fixed-agent native session. The
 * librarian is read-only: deny everything, allow read/search tools and reads
 * inside the configured knowledge sources. Permission prompts are auto-rejected
 * because nobody sits at the server to approve them.
 */
export async function createNativeChat(config: DiscordConfig, loaded: LoadedConfig, opencode: () => Promise<OpenCodeClient>, log?: Logger): Promise<NativeChat> {
  // Plugin tools use their tool id as permission action; `execute` only enables Code Mode.
  const readOnlyTools = ['read', 'glob', 'grep', 'execute', 'skill', 'webfetch', 'websearch', 'knowledge_search', 'aivi_sources', 'aivi_status'];
  const permissions: { action: string; resource: string; effect: 'allow' | 'deny' }[] = [
    { action: '*', resource: '*', effect: 'deny' },
    ...readOnlyTools.map(action => ({ action, resource: '*', effect: 'allow' as const })),
    { action: 'read', resource: '*.env', effect: 'deny' },
    { action: 'read', resource: '*.env.*', effect: 'deny' },
  ];
  // Sources may be files or directories. Match native canonical external-directory boundaries.
  for (const source of loaded.sources) {
    const path = await realpath(source.path);
    const directory = (await stat(path)).isDirectory() ? path : dirname(path);
    if (/[?*]/.test(directory)) throw new Error('Knowledge directory contains native permission wildcard characters');
    permissions.push({ action: 'external_directory', resource: `${directory.replaceAll('\\', '/')}/**`, effect: 'allow' });
  }

  return async (turn, signal, ready) => {
    const client = await opencode();
    const result = await runTurn(client, {
      sessionId: turn.session, agent: config.agent, directory: config.directory, create: !turn.ready,
      title: `Discord ${turn.channel}`,
      sessionMetadata: { aivi: { origin: 'discord', channel: turn.channel } },
      permissions,
      messageId: `msg_discord_${turn.id}`,
      // Role behaviour lives in the agent definition; the prompt only carries who said what.
      text: `[Discord message from ${turn.name} (user ${turn.user})]\n${turn.text}`,
      messageMetadata: { aivi: { origin: 'discord', channel: turn.channel, user: turn.user, discordMessage: turn.id } },
    }, { signal, onPermission: 'reject', onCreated: ready, ...(log ? { log } : {}) });
    return result.text;
  };
}

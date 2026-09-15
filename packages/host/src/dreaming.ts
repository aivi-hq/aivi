import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { Logger, Task } from '@aivi/core';
import { silentLogger } from '@aivi/core';
import type { OpenCodeClient } from './opencode.ts';
import { runTurn } from './session.ts';
import type { Store } from './store.ts';

type DreamingTask = Extract<Task, { kind: 'dreaming' }>;

export interface DreamingDeps {
  store: Store;
  opencode: () => Promise<OpenCodeClient>;
  stateDirectory: string;
  signal: AbortSignal;
  log?: Logger | undefined;
  now?: () => number;
}

export interface DreamingResult {
  reviewed: number;
  since: number;
  until: number;
  sessions: string[];
  transcript?: string;
  changed: string[];
  text?: string;
  rejectedPermissions?: { action: string; resources: string[] }[];
}

const CURSOR_MIGRATIONS = [
  'CREATE TABLE dreaming_cursor(key TEXT PRIMARY KEY, since INTEGER NOT NULL, updated_at INTEGER NOT NULL)',
];

/** One memory directory has one cursor: the newest session update it has already reviewed. */
export function readCursor(store: Store, key: string): number {
  store.migrate('dreaming', CURSOR_MIGRATIONS);
  const row = store.db.prepare('SELECT since FROM dreaming_cursor WHERE key=?').get(key);
  return row ? Number(row.since) : 0;
}

export function writeCursor(store: Store, key: string, since: number, now = Date.now()): void {
  store.db
    .prepare(
      'INSERT INTO dreaming_cursor(key,since,updated_at) VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET since=excluded.since,updated_at=excluded.updated_at',
    )
    .run(key, since, now);
}

interface ReviewedSession {
  id: string;
  origin: string;
  channel?: string;
  updated: number;
  lines: string[];
}

/**
 * Sessions aivi created (by origin) that changed after `since`, oldest first,
 * capped at `max` so a backlog is worked through in order across runs.
 */
export async function collectSessions(
  client: OpenCodeClient,
  since: number,
  origins: string[],
  max: number,
  signal: AbortSignal,
): Promise<ReviewedSession[]> {
  const candidates: { id: string; origin: string; channel?: string; updated: number }[] = [];
  let cursor: string | undefined;
  outer: while (true) {
    // The API refuses `cursor` together with `order`; the order sticks to the cursor.
    const page = await client.session.list(cursor ? { limit: 50, cursor } : { limit: 50, order: 'desc' }, { signal });
    for (const session of page.data) {
      if (session.time.updated <= since) break outer;
      const aivi = (session.metadata as { aivi?: { origin?: string; channel?: string } } | undefined)?.aivi;
      if (!aivi?.origin || !origins.includes(aivi.origin)) continue;
      candidates.push({
        id: session.id,
        origin: aivi.origin,
        ...(aivi.channel ? { channel: aivi.channel } : {}),
        updated: session.time.updated,
      });
    }
    if (!page.cursor.next || page.data.length === 0) break;
    cursor = page.cursor.next;
  }
  candidates.sort((a, b) => a.updated - b.updated);
  const batch = candidates.slice(0, max);
  const sessions: ReviewedSession[] = [];
  for (const candidate of batch) {
    const lines: string[] = [];
    let messageCursor: string | undefined;
    while (true) {
      const page = await client.message.list(
        messageCursor
          ? { sessionID: candidate.id, limit: 200, cursor: messageCursor }
          : { sessionID: candidate.id, limit: 200, order: 'asc' },
        { signal },
      );
      for (const message of page.data) {
        if (message.time.created <= since) continue;
        const when = new Date(message.time.created).toISOString().slice(0, 16).replace('T', ' ');
        if (message.type === 'user') lines.push(`**user** ${when}\n${message.text.trim()}`);
        else if (message.type === 'assistant') {
          const text = message.content
            .filter(p => p.type === 'text')
            .map(p => p.text)
            .join('\n')
            .trim();
          if (text) lines.push(`**${message.agent}** ${when}\n${text}`);
        }
      }
      if (!page.cursor.next || page.data.length === 0) break;
      messageCursor = page.cursor.next;
    }
    if (lines.length) sessions.push({ ...candidate, lines });
  }
  return sessions;
}

export function renderTranscript(sessions: ReviewedSession[], since: number): string {
  const head = `# Conversations since ${since ? new Date(since).toISOString() : 'the beginning'}\n\n${sessions.length} session(s). Speaker lines show who said what; "user" lines from Discord start with the speaker's name and id.\n`;
  const body = sessions
    .map(
      s =>
        `\n## ${s.id} (${s.origin}${s.channel ? `, channel ${s.channel}` : ''}) last updated ${new Date(s.updated).toISOString()}\n\n${s.lines.join('\n\n')}\n`,
    )
    .join('');
  return head + body;
}

async function snapshot(directory: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const walk = async (dir: string) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile())
        files.set(
          relative(directory, path),
          createHash('sha256')
            .update(await readFile(path))
            .digest('hex'),
        );
    }
  };
  await walk(directory);
  return files;
}

/**
 * Dreaming: review conversations since the last run and let the dreamer agent
 * distil them into memory files. The host only moves data and enforces the
 * write boundary; what counts as memorable lives in the agent definition.
 */
export async function dream(
  task: DreamingTask,
  jobId: string,
  deps: DreamingDeps,
): Promise<{ state: 'succeeded' | 'blocked'; result: DreamingResult; reason?: string }> {
  const log = (deps.log ?? silentLogger).child({ component: 'dreaming', job: jobId });
  const now = deps.now ?? Date.now;
  const since = readCursor(deps.store, task.memoryDirectory);
  const client = await deps.opencode();
  const sessions = await collectSessions(client, since, task.origins, task.maxSessions, deps.signal);
  if (!sessions.length) {
    log.info('nothing.new', { since });
    return { state: 'succeeded', result: { reviewed: 0, since, until: since, sessions: [], changed: [] } };
  }
  const until = Math.max(...sessions.map(s => s.updated));

  const runDir = join(deps.stateDirectory, 'dreaming');
  await mkdir(runDir, { recursive: true, mode: 0o700 });
  await mkdir(join(task.memoryDirectory, 'proposals'), { recursive: true });
  const factsPath = join(task.memoryDirectory, 'facts.md');
  await stat(factsPath).catch(() =>
    writeFile(
      factsPath,
      '# Facts\n\nDurable facts and decisions, dated and attributed. Maintained by dreaming; humans may edit.\n',
    ),
  );
  const transcript = join(runDir, `${jobId}.md`);
  await writeFile(transcript, renderTranscript(sessions, since), { mode: 0o600 });

  const before = await snapshot(task.memoryDirectory);
  const memory = task.memoryDirectory.replaceAll('\\', '/');
  const permissions: { action: string; resource: string; effect: 'allow' | 'deny' }[] = [
    { action: '*', resource: '*', effect: 'deny' },
    ...['read', 'glob', 'grep', 'execute', 'knowledge_search', 'aivi_sources'].map(action => ({
      action,
      resource: '*',
      effect: 'allow' as const,
    })),
    { action: 'external_directory', resource: `${memory}/**`, effect: 'allow' },
    { action: 'external_directory', resource: `${runDir.replaceAll('\\', '/')}/**`, effect: 'allow' },
    // The agent may grow facts and proposals; rules and everything else stay human-owned.
    { action: 'edit', resource: `${memory}/facts.md`, effect: 'allow' },
    { action: 'edit', resource: `${memory}/proposals/*`, effect: 'allow' },
  ];
  const suffix = jobId.replaceAll('-', '');
  const metadata = { aivi: { origin: 'dreaming', job: jobId } };
  const turn = await runTurn(
    client,
    {
      sessionId: `ses_aivi_${suffix}`,
      agent: task.agent,
      directory: task.directory,
      create: true,
      title: `aivi dreaming ${new Date(now()).toISOString().slice(0, 10)}`,
      sessionMetadata: metadata,
      permissions,
      messageId: `msg_aivi_${suffix}`,
      messageMetadata: metadata,
      text: [
        `Dreaming run. Review the conversations in ${transcript} (${sessions.length} session(s), ${since ? `since ${new Date(since).toISOString()}` : 'all history'}).`,
        `Memory directory: ${task.memoryDirectory}`,
        `- Read ${factsPath} first and reconcile: update or date-supersede existing entries instead of duplicating them.`,
        `- You may edit only facts.md and files under proposals/. Do not touch anything else.`,
        `- Finish with a short summary of what you recorded, proposed, and deliberately left out.`,
      ].join('\n'),
    },
    { signal: deps.signal, onPermission: 'reject', log },
  );

  const after = await snapshot(task.memoryDirectory);
  const changed = [...new Set([...before.keys(), ...after.keys()])]
    .filter(file => before.get(file) !== after.get(file))
    .sort();
  writeCursor(deps.store, task.memoryDirectory, until, now());
  log.info('dreamed', { reviewed: sessions.length, since, until, changed });
  return {
    state: 'succeeded',
    result: {
      reviewed: sessions.length,
      since,
      until,
      sessions: sessions.map(s => s.id),
      transcript,
      changed,
      text: turn.text,
      rejectedPermissions: turn.rejected,
    },
  };
}

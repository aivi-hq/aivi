/** The voice module's own tables, namespaced through `store.migrate('voice',
 *  …)` like every other module.
 *
 *  Identity is learned, never enrolled: a closed turn is embedded, scanned
 *  against every stored vector (cosine, one dot product per stored voice —
 *  thousands of people are microseconds), matched above threshold or minted
 *  as a fresh `tN`. The store persisting across runs is what makes hearing
 *  someone again across meetings recognition, not a fresh guess.
 *
 *  Lines group under transcripts — one row per room per serve — so a tool
 *  can page through one meeting's lines and leave the others alone.
 */
import type { Store } from '@aivi/plugin';

const MIGRATIONS = [
  `
  CREATE TABLE voice_identities (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
  );
  CREATE TABLE voice_embeddings (
    identity INTEGER NOT NULL REFERENCES voice_identities(id),
    vec BLOB NOT NULL
  );
  CREATE TABLE voice_transcripts (
    id INTEGER PRIMARY KEY,
    started_at TEXT NOT NULL,
    source TEXT NOT NULL
  );
  CREATE TABLE voice_lines (
    id INTEGER PRIMARY KEY,
    transcript INTEGER NOT NULL REFERENCES voice_transcripts(id),
    at TEXT NOT NULL,
    t0 REAL NOT NULL,
    t1 REAL NOT NULL,
    speaker TEXT NOT NULL,
    text TEXT NOT NULL,
    wake INTEGER NOT NULL DEFAULT 0,
    user TEXT,
    channel TEXT
  );
  CREATE INDEX voice_lines_transcript ON voice_lines(transcript, id);
  CREATE TABLE voice_state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
];

export type Match = { name: string; score: number; minted: boolean };

export function cos(a: Float32Array | number[], b: Float32Array | number[]): number {
  let d = 0,
    na = 0,
    nb = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return d / Math.sqrt(na * nb);
}

const toBlob = (v: Float32Array | number[]) => new Uint8Array(new Float32Array(v).buffer);
const fromBlob = (b: Uint8Array) => new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);

type VoiceLog = { info(msg: string, fields?: Record<string, unknown>): void };

export interface VoiceLine {
  id: number;
  transcript: number;
  at: string;
  t0: number;
  t1: number;
  speaker: string;
  text: string;
  wake: boolean;
  user?: string;
  channel?: string;
}

export class VoiceStore {
  private store: Store;
  private log: VoiceLog;

  constructor(store: Store, log: VoiceLog) {
    this.store = store;
    this.log = log;
    store.migrate('voice', MIGRATIONS);
  }

  /** The OpenCode session one room speaks into, kept across restarts: a
   *  call room keeps its conversation, a meeting keeps its addressed thread.
   *  The id is the dispatcher's (it mints sessions when providing a lease);
   *  voice only remembers which one is this room's. */
  roomSession(room: string): string | undefined {
    const row = this.store.db.prepare('SELECT value FROM voice_state WHERE key = ?').get(`session:${room}`) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  setRoomSession(room: string, sessionId: string): void {
    const db = this.store.db;
    db.prepare(
      'INSERT INTO voice_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    ).run(`session:${room}`, sessionId);
    db.prepare(
      'INSERT INTO voice_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
    ).run(`session_at:${room}`, String(Date.now()));
  }

  /** When this room's session last exchanged words (epoch ms); undefined
   *  when the room has no session. The resume window is measured from here. */
  roomSessionAt(room: string): { id: string; at: number } | undefined {
    const row = this.store.db.prepare('SELECT value FROM voice_state WHERE key = ?').get(`session:${room}`) as
      | { value: string }
      | undefined;
    if (!row) return undefined;
    const at = this.store.db.prepare('SELECT value FROM voice_state WHERE key = ?').get(`session_at:${room}`) as
      | { value: string }
      | undefined;
    return { id: row.value, at: Number(at?.value ?? 0) };
  }

  /** Words went to the session: the resume window restarts. A no-op when
   *  the room has no session yet (creating it stamps the time anyway). */
  touchRoomSession(room: string): void {
    this.store.db
      .prepare(
        'INSERT INTO voice_state(key, value) SELECT ?, ? WHERE EXISTS (SELECT 1 FROM voice_state WHERE key = ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(`session_at:${room}`, String(Date.now()), `session:${room}`);
  }

  /** The persisted session died with an old OpenCode, or aged out of the
   *  resume window: forget which one this room's was, the next turn mints
   *  a fresh one. */
  clearRoomSession(room: string): void {
    this.store.db.prepare('DELETE FROM voice_state WHERE key IN (?, ?)').run(`session:${room}`, `session_at:${room}`);
  }

  /** The lease a room holds while its turn works, persisted so a crash
   *  cannot leave the slot silently held: startup releases what remains. */
  setRoomLease(room: string, leaseId: string | null): void {
    if (leaseId === null) {
      this.store.db.prepare('DELETE FROM voice_state WHERE key = ?').run(`lease:${room}`);
      return;
    }
    this.store.db
      .prepare('INSERT INTO voice_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run(`lease:${room}`, leaseId);
  }

  roomLeases(): Array<{ label: string; leaseId: string }> {
    const rows = this.store.db.prepare("SELECT key, value FROM voice_state WHERE key LIKE 'lease:%'").all() as Array<{
      key: string;
      value: string;
    }>;
    return rows.map(r => ({ label: r.key.slice('lease:'.length), leaseId: r.value }));
  }

  /** Begin a transcript: one meeting in one room. */
  openTranscript(source: string): number {
    const r = this.store.db
      .prepare('INSERT INTO voice_transcripts(started_at, source) VALUES (?, ?)')
      .run(new Date().toISOString(), source);
    return Number(r.lastInsertRowid);
  }

  /** The groups, newest first: what exists to read back. */
  transcripts(last = 20): Array<{ id: number; startedAt: string; source: string; lines: number }> {
    const rows = this.store.db
      .prepare(
        `SELECT t.id, t.started_at, t.source, COUNT(l.id) AS lines
         FROM voice_transcripts t LEFT JOIN voice_lines l ON l.transcript = t.id
         GROUP BY t.id ORDER BY t.id DESC LIMIT ?`,
      )
      .all(Math.min(last, 100)) as Array<{ id: number; started_at: string; source: string; lines: number }>;
    return rows.map(r => ({ id: r.id, startedAt: r.started_at, source: r.source, lines: r.lines }));
  }

  /** One finished line; `user`/`channel` carry the platform's own answer
   *  (Discord ids) when the room had one. Returns the line id. */
  appendLine(
    transcript: number,
    t0: number,
    t1: number,
    speaker: string,
    text: string,
    opts: { wake?: boolean; user?: string; channel?: string } = {},
  ): number {
    const r = this.store.db
      .prepare(
        'INSERT INTO voice_lines(transcript, at, t0, t1, speaker, text, wake, user, channel) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        transcript,
        new Date().toISOString(),
        t0,
        t1,
        speaker,
        text,
        opts.wake ? 1 : 0,
        opts.user ?? null,
        opts.channel ?? null,
      );
    this.log.info('voice.line', { transcript, t0, t1, speaker, wake: opts.wake ?? false });
    return Number(r.lastInsertRowid);
  }

  /** Read a transcript back, paginated: the last `last` lines, then older
   *  pages via `before` (the smallest line id a reader has seen). `id`
   *  rises with time, so one cursor pages every transcript the same way. */
  readLines(opts: { transcript?: number; last: number; speaker?: string; before?: number }): VoiceLine[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (opts.transcript !== undefined) {
      where.push('transcript = ?');
      args.push(opts.transcript);
    }
    if (opts.speaker) {
      where.push('speaker = ?');
      args.push(opts.speaker);
    }
    if (opts.before !== undefined) {
      where.push('id < ?');
      args.push(opts.before);
    }
    const rows = this.store.db
      .prepare(
        `SELECT id, transcript, at, t0, t1, speaker, text, wake, user, channel FROM voice_lines
         ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY id DESC LIMIT ?`,
      )
      .all(...args, Math.min(opts.last, 500)) as Array<Record<string, string | number | null>>;
    return rows.reverse().map(r => ({
      id: Number(r.id),
      transcript: Number(r.transcript),
      at: String(r.at),
      t0: Number(r.t0),
      t1: Number(r.t1),
      speaker: String(r.speaker),
      text: String(r.text),
      wake: r.wake === 1,
      ...(r.user !== null && r.user !== undefined ? { user: String(r.user) } : {}),
      ...(r.channel !== null && r.channel !== undefined ? { channel: String(r.channel) } : {}),
    }));
  }

  speakers(): Array<{ name: string; samples: number }> {
    return this.store.db
      .prepare(
        `SELECT i.name, COUNT(e.identity) AS samples FROM voice_identities i
         LEFT JOIN voice_embeddings e ON e.identity = i.id GROUP BY i.id ORDER BY i.name`,
      )
      .all() as Array<{ name: string; samples: number }>;
  }

  /**
   * Identify a voice, learning it if new. The proven rule: cosine against
   * each identity's centroid; at/above threshold it is that person (and the
   * sample sharpens them); below threshold a short blip keeps the nearest
   * label for continuity, a real utterance mints a new `tN`.
   */
  identify(vec: Float32Array, durSec: number, threshold: number): Match {
    const ids = this.store.db.prepare('SELECT id, name FROM voice_identities ORDER BY id').all() as Array<{
      id: number;
      name: string;
    }>;
    const centroids = new Map<number, number[]>();
    for (const id of ids) {
      const vecs = this.store.db.prepare('SELECT vec FROM voice_embeddings WHERE identity = ?').all(id.id) as Array<{
        vec: Uint8Array;
      }>;
      if (!vecs.length) continue;
      const c = new Float64Array(vec.length);
      for (const v of vecs) {
        const f = fromBlob(v.vec);
        for (let i = 0; i < c.length; i++) c[i] = (c[i] ?? 0) + f[i]! / vecs.length;
      }
      centroids.set(id.id, Array.from(c));
    }
    let best: { id: number; name: string; score: number } | null = null;
    for (const [id, c] of centroids) {
      const s = cos(vec, c);
      if (!best || s > best.score) best = { id, name: ids.find(x => x.id === id)!.name, score: s };
    }
    if (best && best.score >= threshold) {
      this.store.db.prepare('INSERT INTO voice_embeddings(identity, vec) VALUES (?, ?)').run(best.id, toBlob(vec));
      return { name: best.name, score: best.score, minted: false };
    }
    if (durSec < 2 && best) return { name: best.name, score: best.score, minted: false };
    const used = new Set(ids.map(i => i.name));
    let n = 1;
    while (used.has(`t${n}`)) n++; // renamed identities keep their names; mints never collide
    const name = `t${n}`;
    const r = this.store.db.prepare('INSERT INTO voice_identities(name) VALUES (?)').run(name);
    this.store.db
      .prepare('INSERT INTO voice_embeddings(identity, vec) VALUES (?, ?)')
      .run(Number(r.lastInsertRowid), toBlob(vec));
    return { name, score: best?.score ?? 0, minted: true };
  }
}

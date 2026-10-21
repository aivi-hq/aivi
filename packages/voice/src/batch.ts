/** Batch engine client: one resident ASR process, utterance-sized requests.
 *
 *  The Discord lane does not stream — Discord already cut the audio into
 *  utterances and named the speaker, so the engine's only job is to
 *  transcribe one utterance at a time, as well as it can (offline quality,
 *  no delay constraint). Protocol on top of the same engine block with
 *  `batch: true`:
 *
 *    -> {"id":"r1","pcm":"<base64 s16le 16 kHz mono>"}   (stdin)
 *    <- {"id":"r1","text":"..."} or {"id":"r1","error":"..."}  (stdout)
 *
 *  Requests are serialized: one model, one decode at a time. A request that
 *  goes unanswered for `timeoutMs` resolves to null and is logged — a lost
 *  utterance must be visible, not silent.
 */
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';

const SR = 16000;

/** 16 kHz float PCM -> base64 s16le, the wire form both batch engines read. */
export function samplesToBase64(samples: Float32Array): string {
  const buf = Buffer.allocUnsafe(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]!));
    buf.writeInt16LE(v < 0 ? Math.round(v * 32768) : Math.round(v * 32767), i * 2);
  }
  return buf.toString('base64');
}

type BatchLog = {
  info(msg: string, f?: Record<string, unknown>): void;
  warn(msg: string, f?: Record<string, unknown>): void;
};

export interface BatchEngineSpec {
  command: string;
  args: string[];
  readyMarker: string;
  /** Model name through the environment (VOXTRAL_MODEL); the script's own
   *  default when unset. */
  model?: string | undefined;
}

export class BatchEngineRun {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, (text: string | null) => void>();
  private chain: Promise<void> = Promise.resolve();
  private seq = 0;
  private stopped = false;

  private readonly spec: BatchEngineSpec;
  private readonly log: BatchLog;
  private readonly timeoutMs: number;

  constructor(spec: BatchEngineSpec, log: BatchLog, timeoutMs = 60_000) {
    this.spec = spec;
    this.log = log;
    this.timeoutMs = timeoutMs;
  }

  start(): Promise<void> {
    this.stopped = false;
    return new Promise((resolve, reject) => {
      const child = spawn(this.spec.command, this.spec.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...(this.spec.model ? { VOXTRAL_MODEL: this.spec.model } : {}) },
      });
      this.child = child;
      let ready = false;
      let stderrBuf = '';
      let stdoutBuf = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (d: string) => {
        stderrBuf = (stderrBuf + d).slice(-8192);
        if (!ready && stderrBuf.includes(this.spec.readyMarker)) {
          ready = true;
          resolve();
        }
      });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (d: string) => {
        stdoutBuf += d;
        // bounded by the buffer: every pass consumes one line
        for (let i = stdoutBuf.indexOf('\n'); i >= 0; i = stdoutBuf.indexOf('\n')) {
          const line = stdoutBuf.slice(0, i).trim();
          stdoutBuf = stdoutBuf.slice(i + 1);
          if (!line) continue;
          try {
            const res = JSON.parse(line) as { id?: string; text?: string; error?: string };
            const settle = res.id ? this.pending.get(res.id) : undefined;
            if (res.id && settle) {
              this.pending.delete(res.id);
              if (res.error) this.log.warn('voice.batch.engine-error', { id: res.id, error: res.error });
              settle(res.error ? null : (res.text ?? null));
            }
          } catch {
            this.log.warn('voice.batch.bad-line', { line: line.slice(0, 120) });
          }
        }
      });
      child.stdin.on('error', err => this.log.warn('voice.batch.stdin-error', { error: String(err) }));
      child.on('exit', code => {
        this.child = null;
        for (const settle of this.pending.values()) settle(null);
        this.pending.clear();
        if (!ready) {
          ready = true;
          const tail = stderrBuf.slice(-400).trim().split('\n').slice(-3).join(' | ');
          reject(new Error(`batch engine exited ${code} before ready: ${tail || 'no stderr'}`));
          return;
        }
        if (!this.stopped) this.log.warn('voice.batch.exited', { code });
      });
      child.on('error', err => {
        this.log.warn('voice.batch.spawn-failed', { error: String(err) });
        if (!ready) {
          ready = true;
          reject(err);
        }
      });
    });
  }

  /** Transcribe one utterance; null means lost (engine error or timeout). */
  transcribe(samples: Float32Array): Promise<string | null> {
    const child = this.child;
    if (!child) return Promise.resolve(null);
    const prev = this.chain;
    let release!: () => void;
    this.chain = new Promise<void>(res => {
      release = res;
    });
    return prev.then(
      () =>
        new Promise<string | null>(res => {
          const active = this.child;
          if (!active) {
            release();
            res(null);
            return;
          }
          const id = `r${++this.seq}`;
          const timer = setTimeout(() => {
            if (this.pending.delete(id)) {
              this.log.warn('voice.batch.timeout', { id, seconds: this.timeoutMs / 1000 });
              res(null);
            }
            release();
          }, this.timeoutMs);
          this.pending.set(id, text => {
            clearTimeout(timer);
            res(text);
            release();
          });
          const req = { id, pcm: samplesToBase64(samples) };
          if (!active.stdin.write(`${JSON.stringify(req)}\n`)) {
            active.stdin.once('drain', () => {}); // backpressure only; the reply drives us
          }
        }),
    );
  }

  /** Seconds of audio a request carries (for logs and sanity checks). */
  static duration(samples: Float32Array): number {
    return samples.length / SR;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const child = this.child;
    this.child = null;
    for (const settle of this.pending.values()) settle(null);
    this.pending.clear();
    if (!child) return;
    child.stdin.end();
    child.kill('SIGKILL');
  }
}

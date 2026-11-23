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
import { Sidecar, type SidecarLog } from './sidecar.ts';

/** 16 kHz float PCM -> base64 s16le, the wire form both batch engines read. */
export function samplesToBase64(samples: Float32Array): string {
  const buf = Buffer.allocUnsafe(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]!));
    buf.writeInt16LE(v < 0 ? Math.round(v * 32768) : Math.round(v * 32767), i * 2);
  }
  return buf.toString('base64');
}

export interface BatchEngineSpec {
  command: string;
  args: string[];
  readyMarker: string;
  /** Model name through the environment (VOXTRAL_MODEL); the script's own
   *  default when unset. */
  model?: string | undefined;
}

export class BatchEngineRun {
  private readonly proc: Sidecar;
  private pending = new Map<string, (text: string | null) => void>();
  private chain: Promise<void> = Promise.resolve();
  private seq = 0;

  private readonly log: SidecarLog;
  private readonly timeoutMs: number;

  constructor(spec: BatchEngineSpec, log: SidecarLog, timeoutMs = 60_000) {
    this.log = log;
    this.timeoutMs = timeoutMs;
    this.proc = new Sidecar(
      {
        prefix: 'voice.batch',
        title: 'batch engine',
        spec,
        env: spec.model ? { VOXTRAL_MODEL: spec.model } : {},
        log,
      },
      {
        onMessage: (message, line) => this.receive(message, line),
        onGone: () => this.loseAll(),
        onExit: code => this.log.warn('voice.batch.exited', { code }),
      },
    );
  }

  start(): Promise<void> {
    return this.proc.start();
  }

  /** One reply. Only a well-formed one answers its request; a malformed one
   *  still settles it — as lost, never as text. */
  private receive(res: Record<string, unknown>, line: string): void {
    const { id, text, error } = res;
    if (typeof id !== 'string') {
      this.proc.badLine(line);
      return;
    }
    const settle = this.pending.get(id);
    if (!settle) return; // a late answer to a request that already ended: nobody waits
    this.pending.delete(id);
    if ((text !== undefined && typeof text !== 'string') || (error !== undefined && typeof error !== 'string')) {
      this.proc.badLine(line);
      settle(null);
      return;
    }
    if (error) this.log.warn('voice.batch.engine-error', { id, error });
    settle(error ? null : (text ?? null));
  }

  /** Nothing more will be answered: every waiting request is lost. */
  private loseAll(): void {
    for (const settle of this.pending.values()) settle(null);
    this.pending.clear();
  }

  /** The process is running. A dead endpoint answers every request with a
   *  loss, so whoever keeps one warm asks before handing it out again. */
  get alive(): boolean {
    return this.proc.alive;
  }

  /** Transcribe one utterance; null means lost (engine error or timeout). */
  transcribe(samples: Float32Array): Promise<string | null> {
    if (!this.proc.alive) return Promise.resolve(null);
    const prev = this.chain;
    let release!: () => void;
    this.chain = new Promise<void>(res => {
      release = res;
    });
    return prev.then(
      () =>
        new Promise<string | null>(res => {
          if (!this.proc.alive) {
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
          // The pipe buffers what it cannot take at once; the reply drives us.
          this.proc.write(`${JSON.stringify({ id, pcm: samplesToBase64(samples) })}\n`);
        }),
    );
  }

  async stop(): Promise<void> {
    this.loseAll();
    this.proc.stop();
  }
}

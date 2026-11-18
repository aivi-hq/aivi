/** TTS engine client: the voice aivi speaks with (the bridge's "virtual mic").
 *
 *  Same sidecar shape as the batch ASR client, different payload:
 *
 *    -> {"id":"t1","text":"...","voice":"nl_female","stream":true}   (stdin)
 *    <- {"id":"t1","seq":0,"audio":"<base64 wav>","sr":24000,"final":false}
 *    <- ... last chunk carries "final":true ...
 *    <- {"id":"t1","error":"..."}
 *
 *  One model, one synthesis at a time (requests serialize). `chunks` yields
 *  the speech as wav chunks IN ORDER — with stream on, while the model is
 *  still synthesizing, so the first sound waits for the first chunk, not the
 *  whole sentence; with stream off it yields the one finished wav. A reply
 *  that cannot be spoken yields nothing and is logged — a silent aivi must
 *  be a visible silent aivi. `engine/mlx-tts.py` is the reference (Voxtral
 *  TTS, Dutch voices nl_male / nl_female).
 */
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { objectMessage } from './sidecar.ts';

export interface TtsSpec {
  command: string;
  args: string[];
  readyMarker: string;
  voice: string;
  /** Model name via the engine's environment (VOXTRAL_TTS_MODEL); the
   *  script's own default when unset. */
  model?: string | undefined;
  /** Speak while synthesizing: chunks land as they are generated (Voxtral's
   *  own interval, its own seam handling). False waits for the whole
   *  sentence — same protocol, one final chunk. */
  stream: boolean;
}

type TtsLog = {
  info(msg: string, f?: Record<string, unknown>): void;
  warn(msg: string, f?: Record<string, unknown>): void;
};

/** One waiting request: chunks land through `deliver`; null ends it. */
interface TtsWaiter {
  deliver(chunk: Buffer | null): void;
}

export class TtsRun {
  private child: ChildProcessWithoutNullStreams | null = null;
  private pending = new Map<string, TtsWaiter>();
  private chain: Promise<void> = Promise.resolve();
  private seq = 0;
  private stopped = false;

  private readonly spec: TtsSpec;
  private readonly log: TtsLog;
  private readonly timeoutMs: number;

  constructor(spec: TtsSpec, log: TtsLog, timeoutMs = 120_000) {
    this.spec = spec;
    this.log = log;
    this.timeoutMs = timeoutMs;
  }

  start(): Promise<void> {
    this.stopped = false;
    return new Promise((resolve, reject) => {
      const child = spawn(this.spec.command, this.spec.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...(this.spec.model ? { VOXTRAL_TTS_MODEL: this.spec.model } : {}) },
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
          if (line) this.receive(line);
        }
      });
      child.stdin.on('error', err => this.log.warn('voice.tts.stdin-error', { error: String(err) }));
      child.on('exit', code => {
        this.child = null;
        for (const waiter of this.pending.values()) waiter.deliver(null); // a dead voice ends every stream
        this.pending.clear();
        if (!ready) {
          ready = true;
          const tail = stderrBuf.slice(-400).trim().split('\n').slice(-3).join(' | ');
          reject(new Error(`tts engine exited ${code} before ready: ${tail || 'no stderr'}`));
          return;
        }
        if (!this.stopped) this.log.warn('voice.tts.exited', { code });
      });
      child.on('error', err => {
        this.log.warn('voice.tts.spawn-failed', { error: String(err) });
        if (!ready) {
          ready = true;
          reject(err);
        }
      });
    });
  }

  /** One stdout line. Only a well-formed reply is spoken; a malformed one
   *  ends its sentence now — left alone it would hold the voice until the
   *  timeout. */
  private receive(line: string): void {
    let res: Record<string, unknown>;
    try {
      res = objectMessage(line);
    } catch {
      this.badLine(line);
      return;
    }
    const { id, audio, error, final } = res;
    if (typeof id !== 'string') {
      this.badLine(line);
      return;
    }
    const waiter = this.pending.get(id);
    if (!waiter) return; // an abandoned request (barge-in): the rest of it goes unheard
    const malformed =
      (audio !== undefined && typeof audio !== 'string') ||
      (error !== undefined && typeof error !== 'string') ||
      (final !== undefined && typeof final !== 'boolean');
    if (malformed) this.badLine(line);
    else if (error) this.log.warn('voice.tts.engine-error', { id, error });
    else if (audio) waiter.deliver(Buffer.from(audio, 'base64'));
    // The sentence is done: a failed or malformed reply ends it unspoken, and
    // a non-streaming reply carries no flag and is its own final chunk — one
    // path for the client.
    if (malformed || error || final !== false) {
      this.pending.delete(id);
      waiter.deliver(null);
    }
  }

  private badLine(line: string): void {
    this.log.warn('voice.tts.bad-line', { line: line.slice(0, 120) });
  }

  /** The process is running. A dead voice speaks nothing, so whoever keeps
   *  one warm asks before handing it out again. */
  get alive(): boolean {
    return this.child !== null;
  }

  /** Speak one sentence: wav chunks out in order, the first one the moment
   *  it exists. The request holds the model until the generator ends; an
   *  abandoned generator (barge-in) drops the rest of its speech and lets
   *  the next sentence queue — the engine finishes the audio it already
   *  committed to, so one abandoned sentence's remaining synthesis is the
   *  price of immediate turn-taking. Yields nothing when unspoken (engine
   *  error, timeout, dead child). */
  async *chunks(text: string): AsyncGenerator<Buffer> {
    const prev = this.chain;
    let release!: () => void;
    this.chain = new Promise<void>(res => {
      release = res;
    });
    await prev;
    const child = this.child;
    if (!child) {
      release();
      return;
    }
    const id = `t${++this.seq}`;
    const items: (Buffer | null)[] = [];
    let notify!: () => void;
    let slot = new Promise<void>(res => {
      notify = res;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = () => {
      timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          this.log.warn('voice.tts.timeout', { id, seconds: this.timeoutMs / 1000 });
          items.push(null);
          notify();
        }
      }, this.timeoutMs);
    };
    const deliver = (chunk: Buffer | null) => {
      if (timer) clearTimeout(timer);
      items.push(chunk);
      notify();
      if (chunk !== null) arm(); // quiet between chunks is loss too
    };
    this.pending.set(id, { deliver });
    arm();
    child.stdin.write(`${JSON.stringify({ id, text, voice: this.spec.voice, stream: this.spec.stream })}\n`);
    try {
      // ends on the queue's sentinel: final, error, timeout, and death all
      // push one, so the loop cannot outlive the answer
      let item: Buffer | null;
      do {
        while (items.length === 0) {
          await slot;
          slot = new Promise<void>(res => {
            notify = res;
          });
        }
        item = items.shift()!;
        if (item !== null) yield item;
      } while (item !== null);
    } finally {
      if (timer) clearTimeout(timer);
      this.pending.delete(id); // done or abandoned: nothing more lands for this request
      release();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const child = this.child;
    this.child = null;
    for (const waiter of this.pending.values()) waiter.deliver(null);
    this.pending.clear();
    if (!child) return;
    child.stdin.end();
    child.kill('SIGKILL');
  }
}

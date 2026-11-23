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
import { Sidecar, type SidecarLog } from './sidecar.ts';

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

/** One waiting request: chunks land through `deliver`; null ends it. */
interface TtsWaiter {
  deliver(chunk: Buffer | null): void;
}

export class TtsRun {
  private readonly proc: Sidecar;
  private pending = new Map<string, TtsWaiter>();
  private chain: Promise<void> = Promise.resolve();
  private seq = 0;

  private readonly spec: TtsSpec;
  private readonly log: SidecarLog;
  private readonly timeoutMs: number;

  constructor(spec: TtsSpec, log: SidecarLog, timeoutMs = 120_000) {
    this.spec = spec;
    this.log = log;
    this.timeoutMs = timeoutMs;
    this.proc = new Sidecar(
      {
        prefix: 'voice.tts',
        title: 'tts engine',
        spec,
        env: spec.model ? { VOXTRAL_TTS_MODEL: spec.model } : {},
        log,
      },
      {
        onMessage: (message, line) => this.receive(message, line),
        onGone: () => this.endAll(), // a dead voice ends every stream
        onExit: code => this.log.warn('voice.tts.exited', { code }),
      },
    );
  }

  start(): Promise<void> {
    return this.proc.start();
  }

  /** One reply. Only a well-formed one is spoken; a malformed one ends its
   *  sentence now — left alone it would hold the voice until the timeout. */
  private receive(res: Record<string, unknown>, line: string): void {
    const { id, audio, error, final } = res;
    if (typeof id !== 'string') {
      this.proc.badLine(line);
      return;
    }
    const waiter = this.pending.get(id);
    if (!waiter) return; // an abandoned request (barge-in): the rest of it goes unheard
    const malformed =
      (audio !== undefined && typeof audio !== 'string') ||
      (error !== undefined && typeof error !== 'string') ||
      (final !== undefined && typeof final !== 'boolean');
    if (malformed) this.proc.badLine(line);
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

  /** Nothing more will be spoken: every waiting sentence ends where it is. */
  private endAll(): void {
    for (const waiter of this.pending.values()) waiter.deliver(null);
    this.pending.clear();
  }

  /** The process is running. A dead voice speaks nothing, so whoever keeps
   *  one warm asks before handing it out again. */
  get alive(): boolean {
    return this.proc.alive;
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
    if (!this.proc.alive) {
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
    this.proc.write(`${JSON.stringify({ id, text, voice: this.spec.voice, stream: this.spec.stream })}\n`);
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
    this.endAll();
    this.proc.stop();
  }
}

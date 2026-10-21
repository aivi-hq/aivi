/** The engine sidecar: one stdio child speaking the voice engine protocol.
 *
 *  stdin  (to engine, JSONL): {"a":"<b64 s16le 16 kHz mono>"} mixed streaming
 *  audio; {"a","lane"} one named speaker's live chunk; {"lane","end":true}
 *  that utterance is over (flush the tail, then lane_end); {"id","a"} a batch
 *  request — transcribe one finished utterance.
 *  stdout (from engine): JSONL — {"ev":"delta","text","pos","lane"?},
 *  {"ev":"act","t","slot"} (-1 slot = silence, mixed only),
 *  {"ev":"session_reset","pos","lane"?}, {"ev":"lane_end","lane"},
 *  {"ev":"eof"}, and batch answers {"id","text"}. stderr: status; the
 *  readyMarker line means the models are loaded. The FIRST stdout event is
 *  {"ev":"diar","on"} — the engine's one answer on the diarizer, settled
 *  at startup by DIAR_MODEL: with it, act slots are speaker candidates the
 *  host can name; without it, slots are loudness labels and mixed lines
 *  stay nameless.
 *
 *  Audio comes from ffmpeg (paced file or platform mic capture) or from
 *  `write()` (a platform adapter: Discord feeds its demuxed audio), relayed
 *  through this process so the fusion
 *  can slice recent audio out of the same stream the engine hears. One
 *  engine, both jobs: rooms stream through it, and finished utterances are
 *  transcribed in it too — no second process for the same weights. Named
 *  lanes (a platform that demuxes its speakers, like Discord) ride live
 *  sessions in the same process and skip the ring tap: identity slicing is
 *  the mixed lane's job, the platform already knows who speaks here.
 */
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import type { Readable } from 'node:stream';

export type EngineEvent =
  | { ev: 'delta'; text: string; pos: number; lane?: string }
  | { ev: 'act'; t: number; slot: number }
  | { ev: 'session_reset'; pos: number; lane?: string }
  | { ev: 'lane_end'; lane: string }
  | { ev: 'diar'; on: boolean }
  | { ev: 'eof' };

export interface EngineSpec {
  command: string;
  args: string[];
  /** stderr line that means the engine will read stdin. */
  readyMarker: string;
  /** Model names passed through as the environment speaks (VOXTRAL_MODEL,
   *  DIAR_MODEL): the ASR keeps its script's own default when unset; the
   *  diarizer has no default — `diarModel` is the whole answer, said once:
   *  set → the engine loads it at startup (and fails loudly if it cannot);
   *  unset → the engine says so in its first `diar` event and mixed lines
   *  stay nameless. There is no per-room decision anymore (ruled 2026-10-14). */
  model?: string | undefined;
  diarModel?: string | undefined;
  /** Where the audio comes from, when the caller has its own — Discord's
   *  demuxed stream, a test's silence. Absent: the default, which is ffmpeg
   *  for a file or a microphone and nothing for push (the caller writes PCM
   *  itself through `write`). */
  source?: (() => AudioStream) | undefined;
}

export interface AudioSource {
  /** 'push': no source — someone writes PCM in via write() (the Discord adapter). */
  type: 'file' | 'mic' | 'push';
  path?: string | undefined;
  paced?: boolean | undefined;
  device?: string | undefined;
}

/** The audio feeding the engine: s16le 16 kHz mono PCM, as a stream. */
export interface AudioStream {
  /** The bytes, as they come. */
  stream: Readable;
  /** End the producer — kill the process behind it. */
  stop: () => void;
}

const SR = 16000;
const RING_SECONDS = 180;

export type EngineLog = {
  info(msg: string, f?: Record<string, unknown>): void;
  warn(msg: string, f?: Record<string, unknown>): void;
};

export interface EngineHandlers {
  onEvent(e: EngineEvent): void;
  /** Engine exited without being stopped (after the eof event it is normal). */
  onExit(code: number | null): void;
}

function micArgs(device?: string): string[] {
  if (process.platform === 'darwin') {
    return ['-f', 'avfoundation', '-i', `:${device ?? 'none:default'}`];
  }
  return ['-f', 'alsa', '-i', device ?? 'default'];
}

/** The default source: ffmpeg turns a file or a microphone into raw PCM. It is
 *  a decoder and nothing more — the engine speaks the protocol, the source
 *  only supplies the bytes. A caller with its own audio hands its own
 *  stream (Discord, a test). */
function defaultSource(input: AudioSource, log: EngineLog): AudioStream | undefined {
  if (input.type === 'push') return undefined;
  // -re paces a file at native speed; a live capture device is already real time.
  const args =
    input.type === 'file' ? [...(input.paced === false ? [] : ['-re']), '-i', input.path!] : micArgs(input.device);
  const child = spawn(
    'ffmpeg',
    ['-v', 'error', '-nostats', ...args, '-ar', String(SR), '-ac', '1', '-f', 's16le', '-'],
    {
      stdio: ['ignore', 'pipe', 'inherit'],
    },
  );
  child.on('exit', code => {
    if (code !== 0) log.warn('voice.source.exited', { code });
  });
  child.on('error', err => log.warn('voice.source.spawn-failed', { error: String(err) }));
  return { stream: child.stdout, stop: () => child.kill('SIGKILL') };
}

export class EngineRun {
  private engine: ChildProcessWithoutNullStreams | null = null;
  private source: AudioStream | null = null;
  private ring = new Float32Array(RING_SECONDS * SR);
  private ringEnd = 0; // absolute sample index one past the last written
  private stopped = false;
  private eofSeen = false;
  private pending = new Map<string, (text: string | null) => void>();
  private reqSeq = 0;

  private spec: EngineSpec;
  private input: AudioSource;
  private handlers: EngineHandlers;
  private log: EngineLog;

  constructor(spec: EngineSpec, input: AudioSource, handlers: EngineHandlers, log: EngineLog) {
    this.spec = spec;
    this.input = input;
    this.handlers = handlers;
    this.log = log;
  }

  /** Samples kept for slicing: [from, to) in absolute stream positions. */
  slice(from: number, to: number): Float32Array | null {
    const i0 = Math.round(from * SR),
      i1 = Math.round(to * SR);
    if (i1 <= i0 || i0 < this.ringEnd - this.ring.length || i1 > this.ringEnd) return null;
    const out = new Float32Array(i1 - i0);
    for (let i = 0; i < out.length; i++) out[i] = this.ring[(i0 + i) % this.ring.length]!;
    return out;
  }

  /** Spawn the engine and start feeding. Resolves when the ready marker
   *  appeared; rejects if either process died first. */
  start(): Promise<void> {
    this.stopped = false;
    this.eofSeen = false;
    return new Promise((resolve, reject) => {
      const env = {
        ...process.env,
        ...(this.spec.model ? { VOXTRAL_MODEL: this.spec.model } : {}),
        ...(this.spec.diarModel ? { DIAR_MODEL: this.spec.diarModel } : {}),
      };
      const engine = spawn(this.spec.command, this.spec.args, { stdio: ['pipe', 'pipe', 'pipe'], env });
      this.engine = engine;
      let ready = false;
      let stderrBuf = '';
      let stdoutBuf = '';
      engine.stderr.setEncoding('utf8');
      engine.stderr.on('data', (d: string) => {
        stderrBuf = (stderrBuf + d).slice(-8192);
        if (!ready && stderrBuf.includes(this.spec.readyMarker)) {
          ready = true;
          // A source, if there is one: the caller's own stream, or the default
          // (ffmpeg for a file or a microphone). Push without a source: the
          // caller writes the PCM itself.
          this.startSource();
          resolve();
        }
      });
      engine.stdout.setEncoding('utf8');
      engine.stdout.on('data', (d: string) => {
        stdoutBuf += d;
        // bounded by the buffer: every pass consumes one line, and a
        // buffer without a newline ends the loop
        for (let i = stdoutBuf.indexOf('\n'); i >= 0; i = stdoutBuf.indexOf('\n')) {
          const line = stdoutBuf.slice(0, i).trim();
          stdoutBuf = stdoutBuf.slice(i + 1);
          if (!line) continue;
          let msg: { ev?: string; id?: string; text?: string; error?: string };
          try {
            msg = JSON.parse(line);
          } catch {
            this.log.warn('voice.engine.bad-line', { line: line.slice(0, 120) });
            continue;
          }
          if (typeof msg.id === 'string') {
            const waiter = this.pending.get(msg.id);
            this.pending.delete(msg.id);
            if (!waiter) continue; // a late answer to a dead request: nothing waits
            if (msg.error) this.log.warn('voice.engine.batch-error', { error: msg.error });
            waiter(msg.text?.trim() || null);
            continue;
          }
          const e = msg as EngineEvent;
          if (e.ev === 'eof') this.eofSeen = true;
          this.handlers.onEvent(e);
        }
      });
      engine.on('exit', code => {
        this.engine = null;
        for (const waiter of this.pending.values()) waiter(null); // a dead engine answers nothing
        this.pending.clear();
        if (!ready) {
          ready = true;
          const tail = stderrBuf.slice(-400).trim().split('\n').slice(-3).join(' | ');
          reject(new Error(`engine exited ${code} before ready: ${tail || 'no stderr'}`));
          return;
        }
        if (!this.stopped) this.handlers.onExit(code);
      });
      // A dead engine must not turn a write into an unhandled stream error.
      engine.stdin.on('error', err => this.log.warn('voice.engine.stdin-error', { error: String(err) }));
      engine.on('error', err => {
        this.log.warn('voice.engine.spawn-failed', { error: String(err) });
        if (!ready) {
          ready = true;
          reject(err);
        }
      });
    });
  }

  private startSource(): void {
    if (this.stopped || !this.engine) return;
    const source = this.spec.source ? this.spec.source() : defaultSource(this.input, this.log);
    if (!source) return;
    this.source = source;
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      this.source = null;
      this.engine?.stdin.end();
    };
    source.stream.on('data', (buf: Buffer) => {
      const f32 = new Float32Array(buf.length / 2);
      for (let i = 0; i < f32.length; i++) f32[i] = buf.readInt16LE(i * 2) / 32768;
      const written = this.writeFrame(buf);
      if (!written && this.engine) {
        source.stream.pause();
        this.engine.stdin.once('drain', () => source.stream.resume());
      }
      this.tap(f32);
    });
    // The audio is over: the file ran out, the capture ended, the source died.
    // Either way the engine's stdin ends, and the engine answers with its eof.
    source.stream.on('end', end);
    source.stream.on('close', end);
    source.stream.on('error', err => this.log.warn('voice.source-failed', { error: String(err) }));
  }

  /** One JSONL frame per event: two frames sharing one TCP/pipe segment would
   *  arrive as one write, and the engine reads one event per line. */
  private writeFrame(buf: Buffer): boolean {
    const engine = this.engine;
    if (!engine) return true;
    return engine.stdin.write(`${JSON.stringify({ a: buf.toString('base64') })}\n`);
  }

  /** Push mode: feed one s16le 16 kHz mono chunk, same ring tap as ffmpeg feeds. */
  write(buf: Buffer): void {
    if (this.stopped || !this.engine) return;
    const f32 = new Float32Array(buf.length / 2);
    for (let i = 0; i < f32.length; i++) f32[i] = buf.readInt16LE(i * 2) / 32768;
    this.writeFrame(buf);
    this.tap(f32);
  }

  /** One named speaker's live chunk: a lane of its own in the engine, no
   *  diarizer, no ring tap (the platform named the speaker already — the
   *  mixed-timeline ring is for slicing anonymous audio for identity). */
  writeLane(lane: string, pcm: Float32Array): void {
    const engine = this.engine;
    if (!engine || this.stopped) return;
    engine.stdin.write(`${JSON.stringify({ a: this.b64i16(pcm), lane })}\n`);
  }

  /** The speaker's utterance is over: the engine flushes the tail (deltas
   *  keep coming) and answers with a lane_end event. */
  endLane(lane: string): void {
    const engine = this.engine;
    if (!engine || this.stopped) return;
    engine.stdin.write(`${JSON.stringify({ lane, end: true })}\n`);
  }

  private b64i16(pcm: Float32Array): string {
    const i16 = new Int16Array(pcm.length);
    for (let i = 0; i < pcm.length; i++) i16[i] = Math.max(-32768, Math.min(32767, Math.round(pcm[i]! * 32768)));
    return Buffer.from(i16.buffer).toString('base64');
  }

  /** Transcribe one finished utterance in this same process — the batch lane
   *  is not a second engine, it is the engine asked a different question.
   *  Resolves with the text, or null when the request was lost (error line,
   *  engine death). */
  transcribe(pcm: Float32Array): Promise<string | null> {
    const engine = this.engine;
    if (!engine || this.stopped) return Promise.resolve(null);
    const id = `t${++this.reqSeq}`;
    return new Promise(resolve => {
      this.pending.set(id, resolve);
      engine.stdin.write(`${JSON.stringify({ id, a: this.b64i16(pcm) })}\n`);
    });
  }

  private tap(samples: Float32Array): void {
    for (let i = 0; i < samples.length; i++) this.ring[this.ringEnd++ % this.ring.length] = samples[i]!;
  }

  /** True once the engine said eof: the file ran out, this is not a crash. */
  get eof(): boolean {
    return this.eofSeen;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.source?.stop();
    this.source = null;
    for (const waiter of this.pending.values()) waiter(null);
    this.pending.clear();
    const engine = this.engine;
    if (!engine) return;
    this.engine = null;
    engine.stdin.end();
    engine.kill('SIGKILL');
  }
}

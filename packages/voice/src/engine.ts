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
import { spawn } from 'node:child_process';
import type { Readable } from 'node:stream';
import { Sidecar, type SidecarLog } from './sidecar.ts';

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

export type EngineLog = SidecarLog;

export interface EngineHandlers {
  onEvent(e: EngineEvent): void;
  /** Engine exited without being stopped (after the eof event it is normal). */
  onExit(code: number | null): void;
}

const finiteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const validLane = (value: Record<string, unknown>): boolean =>
  value.lane === undefined || typeof value.lane === 'string';

/** Validate the fields the room consumes. Unknown metadata may pass through,
 *  but malformed text or timestamps must never become transcript facts. */
function engineEvent(value: Record<string, unknown>): value is EngineEvent {
  switch (value.ev) {
    case 'delta':
      return typeof value.text === 'string' && finiteNumber(value.pos) && validLane(value);
    case 'act':
      return finiteNumber(value.t) && finiteNumber(value.slot);
    case 'session_reset':
      return finiteNumber(value.pos) && validLane(value);
    case 'lane_end':
      return typeof value.lane === 'string';
    case 'diar':
      return typeof value.on === 'boolean';
    case 'eof':
      return true;
    default:
      return false;
  }
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
  // An exit we asked for is not a failed source: only a decoder that ended
  // on its own, badly, is worth a warning.
  let stopped = false;
  child.on('exit', code => {
    if (code !== 0 && !stopped) log.warn('voice.source.exited', { code });
  });
  child.on('error', err => log.warn('voice.source.spawn-failed', { error: String(err) }));
  return {
    stream: child.stdout,
    stop: () => {
      stopped = true;
      child.kill('SIGKILL');
    },
  };
}

export class EngineRun {
  private readonly proc: Sidecar;
  private source: AudioStream | null = null;
  private ring = new Float32Array(RING_SECONDS * SR);
  private ringEnd = 0; // absolute sample index one past the last written
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
    this.proc = new Sidecar(
      {
        prefix: 'voice.engine',
        title: 'engine',
        spec,
        env: {
          ...(spec.model ? { VOXTRAL_MODEL: spec.model } : {}),
          ...(spec.diarModel ? { DIAR_MODEL: spec.diarModel } : {}),
        },
        log,
      },
      {
        onMessage: (message, line) => this.receive(message, line),
        // A source, if there is one: the caller's own stream, or the default
        // (ffmpeg for a file or a microphone). Push without a source: the
        // caller writes the PCM itself.
        onReady: () => this.startSource(),
        onGone: () => this.silence(),
        // Engine exited without being stopped (after the eof event it is normal).
        onExit: code => this.handlers.onExit(code),
      },
    );
  }

  /** Samples kept for slicing: [from, to) in absolute stream positions. */
  slice(from: number, to: number): Float32Array | null {
    const i0 = Math.round(from * SR),
      i1 = Math.round(to * SR);
    // The ring holds what was heard, from the start of the stream at the
    // earliest: nothing before it, nothing older than its length.
    if (i1 <= i0 || i0 < Math.max(0, this.ringEnd - this.ring.length) || i1 > this.ringEnd) return null;
    const out = new Float32Array(i1 - i0);
    for (let i = 0; i < out.length; i++) out[i] = this.ring[(i0 + i) % this.ring.length]!;
    return out;
  }

  /** Spawn the engine and start feeding. Resolves when the ready marker
   *  appeared; rejects if either process died first. */
  start(): Promise<void> {
    this.eofSeen = false;
    return this.proc.start();
  }

  /** Protocol validation and request settlement have separate boundaries; a
   *  malformed reply must still settle its waiting request. */
  private receive(msg: Record<string, unknown>, line: string): void {
    if (typeof msg.id === 'string') {
      this.reply(msg.id, msg, line);
      return;
    }
    if (!engineEvent(msg)) {
      this.proc.badLine(line);
      return;
    }
    if (msg.ev === 'eof') this.eofSeen = true;
    this.handlers.onEvent(msg);
  }

  private reply(id: string, msg: Record<string, unknown>, line: string): void {
    const waiter = this.pending.get(id);
    this.pending.delete(id);
    if (!waiter) return; // an abandoned request has nobody left to answer
    const text = msg.text;
    const error = msg.error;
    if ((text !== undefined && typeof text !== 'string') || (error !== undefined && typeof error !== 'string')) {
      this.proc.badLine(line);
      waiter(null);
      return;
    }
    if (error) this.log.warn('voice.engine.batch-error', { error });
    waiter(error ? null : text?.trim() || null);
  }

  /** Nothing is left to hear the audio or to answer: a producer still
   *  running (a capture device, a paced file) ends with the engine it was
   *  feeding, and a dead engine answers every waiting request with a loss. */
  private silence(): void {
    this.source?.stop();
    this.source = null;
    for (const waiter of this.pending.values()) waiter(null);
    this.pending.clear();
  }

  private startSource(): void {
    if (!this.proc.alive) return;
    const source = this.spec.source ? this.spec.source() : defaultSource(this.input, this.log);
    if (!source) return;
    this.source = source;
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      this.source = null;
      this.proc.endInput();
    };
    source.stream.on('data', (buf: Buffer) => {
      const f32 = new Float32Array(buf.length / 2);
      for (let i = 0; i < f32.length; i++) f32[i] = buf.readInt16LE(i * 2) / 32768;
      if (!this.writeFrame(buf)) {
        source.stream.pause();
        this.proc.drained(() => source.stream.resume());
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
    return this.proc.write(`${JSON.stringify({ a: buf.toString('base64') })}\n`);
  }

  /** Push mode: feed one s16le 16 kHz mono chunk, same ring tap as ffmpeg feeds. */
  write(buf: Buffer): void {
    if (!this.proc.alive) return;
    const f32 = new Float32Array(buf.length / 2);
    for (let i = 0; i < f32.length; i++) f32[i] = buf.readInt16LE(i * 2) / 32768;
    this.writeFrame(buf);
    this.tap(f32);
  }

  /** One named speaker's live chunk: a lane of its own in the engine, no
   *  diarizer, no ring tap (the platform named the speaker already — the
   *  mixed-timeline ring is for slicing anonymous audio for identity). */
  writeLane(lane: string, pcm: Float32Array): void {
    if (!this.proc.alive) return;
    this.proc.write(`${JSON.stringify({ a: this.b64i16(pcm), lane })}\n`);
  }

  /** The speaker's utterance is over: the engine flushes the tail (deltas
   *  keep coming) and answers with a lane_end event. */
  endLane(lane: string): void {
    if (!this.proc.alive) return;
    this.proc.write(`${JSON.stringify({ lane, end: true })}\n`);
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
    if (!this.proc.alive) return Promise.resolve(null);
    const id = `t${++this.reqSeq}`;
    return new Promise(resolve => {
      this.pending.set(id, resolve);
      this.proc.write(`${JSON.stringify({ id, a: this.b64i16(pcm) })}\n`);
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
    this.silence();
    this.proc.stop();
  }
}

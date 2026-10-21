/** One room, heard: the implementation of the kit's `VoiceRoom`, and the
 *  shell that wires the three working parts together —
 *  - `speech.ts` (SpeechOut): mouths, clause cutting, the speaking window,
 *    barge silence;
 *  - `fusion.ts` (MixedFusion): mixed-audio engine events → transcript
 *    lines, the wake cut, identity naming;
 *  - `lanes.ts` (LaneBook): one live lane per named speaker, streaming into
 *    the shared engine.
 *
 *  Two ways speech arrives:
 *  - `feed`: mixed PCM, the anonymous kind. The streaming engine runs ASR
 *    and diarization; the fusion turns their events into transcript lines —
 *    an act change closes the open line, the slice is embedded, and the
 *    person memory says who. This is where diarization, transcript and
 *    person lookup fuse into one clean row.
 *  - `heard`: a platform already segmented and named the speech (Discord).
 *    The batch transcriber words it; the platform's name stands.
 *
 *  From a line, the mode decides. CALL rooms are the conversation, not a
 *  record: no transcript rows exist — closed sentences batch into one
 *  prompt once the person is finished (a quiet gap), and go straight to the
 *  session, which answers and can be interrupted (barge-in: aivi falls
 *  silent, the interrupting words go in, the answer is reconsidered).
 *  MEETING rooms append to the transcript (the record is what a meeting
 *  IS) and say nothing until the wake phrase activates the session. The
 *  session is a normal OpenCode session holding a real lease — see turns.ts.
 *
 *  Push rooms (Discord, future platform adapters) do not own an engine: they
 *  attach
 *  to the module's shared one, which is born at the first audio of the host
 *  and stays warm across meetings (see shared.ts). File and mic rooms are
 *  one-shot development lanes and keep their own process.
 */
import { ConfigurationError } from '@aivi/plugin';
import type { RoomOptions, VoiceLane, VoiceRoom } from '@aivi/plugin/voice';
import type { AudioSource, EngineEvent, EngineSpec } from './engine.ts';
import { EngineRun } from './engine.ts';
import { MixedFusion } from './fusion.ts';
import { LaneBook } from './lanes.ts';
import type { EngineSink, EngineState, SharedEngine } from './shared.ts';
import { SpeechOut } from './speech.ts';
import type { VoiceStore } from './store.ts';
import type { TtsRun } from './tts.ts';
import type { TurnsDeps } from './turns.ts';
import { VoiceTurns } from './turns.ts';
import { scanWake, stripWake } from './wake.ts';

const SR = 16000;
const BUFFER_MAX_BYTES = SR * 2 * 60; // own-lane wait-for-engine buffer: 60 s, then oldest goes
/** The "finished" window of a conversation: sentences this close together
 *  are one turn of speech, batched into one prompt. The one setTimeout in
 *  voice: between utterances nothing flows to time against (a Discord room
 *  holds no audio when nobody speaks), and a conversation must know when
 *  the person is done. */
const CONVERSATION_GAP_MS = 1500;

export interface RoomInit extends RoomOptions {
  /** What feeds the streaming engine for this room: file and mic spawn
   *  ffmpeg (voice's own lanes); 'push' rooms feed `feed()` themselves. */
  engineInput: AudioSource;
}

/** Shared across rooms except what the room IS: `mode` and `agent` are
 *  filled per room from `RoomOptions` (the opener declares them); the three
 *  session/lease hooks are filled per room in the constructor — they belong
 *  to this label, not to the module. */
export interface RoomDeps extends Omit<TurnsDeps, 'session' | 'rememberSession' | 'rememberLease' | 'clearSession'> {
  mode: 'call' | 'meeting';
  wakePhrases: string[];
  engineSpec: EngineSpec;
  /** Session shape, from the voice block: what rooms prompt with. */
  agent: string;
  directory: string;
  model?: { providerID: string; modelID: string; variant?: string | undefined } | undefined;
  pool?: string | undefined;
  identity: { model: string; threshold: number } | undefined;
  embedder: {
    createStream(): { acceptWaveform(a: { samples: Float32Array; sampleRate: number }): void };
    isReady(s: unknown): boolean;
    compute(s: unknown): Float32Array;
  } | null;
  store: VoiceStore;
  /** The module's one streaming engine: born at first audio, warm across
   *  meetings; push rooms feed and hear through it. */
  sharedEngine: SharedEngine;
  /** A separate batch endpoint (`stt` block, e.g. remote): created on first
   *  need; null when unconfigured. The streaming engine answers batch
   *  requests itself — this is only for when another endpoint is named. */
  getStt: () => Promise<{ transcribe(pcm: Float32Array): Promise<string | null> } | null>;
  /** Shared voice, created on first need; null when unconfigured. */
  getTts: () => Promise<TtsRun | null>;
  /** The "finished" window (tests shorten it); default CONVERSATION_GAP_MS. */
  finishWindowMs?: number;
  /** Minutes of quiet a room may resume its OpenCode session for; `0`:
   *  fresh session every join; `false`: always resume the same one. */
  resumeMinutes: number | false;
}

export class HearingRoom implements VoiceRoom {
  private engine: EngineRun | null = null;
  private engineReady = false;
  private buffered: Buffer[] = [];
  private bufferedBytes = 0;
  private transcript: number | undefined;
  private turns: VoiceTurns;
  private listeners: Array<(event: Record<string, unknown>) => void> = [];
  private stopped = false;
  private sink: EngineSink | null = null;
  private engineState: EngineState = 'idle';
  // The conversation: sentences closed within the finished window batch
  // into one prompt; the play generation drops answers a barge-in cut off.
  private batch: Array<{ speaker: string; text: string }> = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  private readonly speech: SpeechOut;
  private readonly fusion: MixedFusion;
  private readonly laneBook: LaneBook;

  private readonly init: RoomInit;
  private readonly deps: RoomDeps;

  constructor(init: RoomInit, deps: RoomDeps) {
    this.init = init;
    this.deps = deps;
    if (init.streaming && deps.mode === 'meeting' && !deps.identity)
      throw new ConfigurationError(
        `room ${init.label}: meeting rooms that only carry audio need identity — a meeting with one anonymous speaker is a monologue`,
      );
    this.speech = new SpeechOut({
      label: init.label,
      log: deps.log,
      getTts: deps.getTts,
      emit: e => this.emit(e),
    });
    this.fusion = new MixedFusion({
      mode: deps.mode,
      wakePhrases: deps.wakePhrases,
      label: init.label,
      log: deps.log,
      emit: e => this.emit(e),
      speaking: () => this.speech.isSpeaking,
      barge: () => this.bargeIn(),
      identify: (t0, t1) => this.identifySlice(t0, t1),
      commit: (t0, t1, speaker, text, wake) => this.commitLine(t0, t1, speaker, text, { wake }),
    });
    this.laneBook = new LaneBook({
      mode: deps.mode,
      wakePhrases: deps.wakePhrases,
      label: init.label,
      log: deps.log,
      sharedEngine: deps.sharedEngine,
      transcribe: pcm => this.transcribeSpeech(pcm),
      speaking: () => this.speech.isSpeaking,
      barge: () => this.bargeIn(),
      stopped: () => this.stopped,
      commit: (t0, t1, speaker, text, opts) => this.commitLine(t0, t1, speaker, text, opts),
    });
    // Only meetings keep a record. A call room's transcript IS its OpenCode
    // session — no rows, no group, no pointer in message metadata.
    this.transcript = deps.mode === 'meeting' ? deps.store.openTranscript(init.label) : undefined;
    // Per-room view of the shared deps: this room's session and lease live
    // in the voice store under this room's label. Turns asks for the session
    // once, when the room opens — which is exactly the rejoining question:
    // resume it if the last exchange was inside the window, start fresh
    // past it (an old conversation is not free, it is prefill). Mid-room the
    // session is never expired: the people are still here; every exchange
    // touches the stamp so the NEXT open measures from the last word, not
    // from the first.
    const turnDeps: TurnsDeps = {
      ...deps,
      session: () => {
        const stored = deps.store.roomSessionAt(init.label);
        if (!stored) return undefined;
        if (deps.resumeMinutes === false) return stored.id;
        const insideWindow = deps.resumeMinutes > 0 && Date.now() - stored.at <= deps.resumeMinutes * 60_000;
        if (insideWindow) return stored.id;
        deps.store.clearRoomSession(init.label);
        deps.log.info('voice.session.expired', {
          room: init.label,
          session: stored.id,
          quietMinutes: Math.round((Date.now() - stored.at) / 60_000),
          hint: 'past the resume window: a fresh session, not an old conversation replayed as prefill',
        });
        return undefined;
      },
      rememberSession: id => deps.store.setRoomSession(init.label, id),
      clearSession: () => deps.store.clearRoomSession(init.label),
      rememberLease: id => deps.store.setRoomLease(init.label, id),
    };
    this.turns = new VoiceTurns(
      {
        pool: deps.pool,
        agent: deps.agent,
        directory: deps.directory,
        model: deps.model,
        steerWhenBusy: deps.mode === 'call',
        origin: init.id,
        transcript: this.transcript,
      },
      turnDeps,
    );
    this.turns.onAnswered = text => this.speech.finish(text);
    this.turns.onText = ev => this.speech.text(ev);
    this.turns.onTurnState = state => this.emit({ ev: 'turn', state });
    if (init.engineInput.type === 'push') {
      // Attach to the shared engine: it may already be loaded (another room
      // heard audio first) — the page then says ready at once, not idle.
      this.sink = {
        onEvent: e => this.onEngineEvent(e),
        onState: state => this.setEngineState(state),
      };
      deps.sharedEngine.attach(this.sink);
    } else void this.startEngine();
  }

  /** Current engine state: a page that connects to a warm host is told the
   *  truth at once, not a spinner for models that loaded an hour ago. */
  currentEngineState(): EngineState {
    return this.engineState;
  }

  /** Own-lane rooms (file, mic) begin their own engine at once; push rooms
   *  never own one — the shared engine loads on the host's first audio. */
  private async startEngine(): Promise<void> {
    if (this.engine) return;
    this.setEngineState('loading'); // the page says so; models take ~30 s
    const engine = new EngineRun(
      this.deps.engineSpec,
      this.init.engineInput,
      {
        onEvent: e => this.onEngineEvent(e),
        onExit: code => {
          if (engine.eof || this.stopped) return;
          this.engine = null;
          this.engineReady = false;
          this.setEngineState('failed'); // the page must not keep showing ready on a dead process
          this.deps.log.warn('voice.engine.exited', { room: this.init.label, code });
        },
      },
      this.deps.log,
    );
    this.engine = engine;
    try {
      await engine.start();
      this.engineReady = true;
      this.setEngineState('ready');
      for (const buf of this.buffered) engine.write(buf); // audio that arrived first goes in order
      this.buffered = [];
      this.bufferedBytes = 0;
    } catch (error) {
      // Failed like stt/tts fail: not cached as a permanent no, the next
      // audio tries the load again.
      this.engine = null;
      this.setEngineState('failed');
      this.deps.log.warn('voice.engine.start-failed', { room: this.init.label, error: String(error) });
    }
  }

  /** Engine state is remembered: a page that joins a warm room sees the
   *  truth now (ready, idle, failed), never a stale spinner. */
  private setEngineState(state: EngineState): void {
    this.engineState = state;
    if (state === 'failed' || state === 'idle') this.laneBook.engineDied();
    this.emit({ ev: 'engine', state });
  }

  feed(pcm: Buffer): void {
    if (this.stopped) return;
    if (this.init.engineInput.type === 'push') {
      this.deps.sharedEngine.push(pcm); // shared engine: born on this audio if nothing loaded it first
      return;
    }
    // Own lane (file, mic): its own process, retried after a failed load.
    if (this.engine && this.engineReady) {
      this.engine.write(pcm);
      return;
    }
    if (!this.engine) void this.startEngine();
    this.buffered.push(pcm);
    this.bufferedBytes += pcm.length;
    while (this.bufferedBytes > BUFFER_MAX_BYTES && this.buffered.length > 1) {
      this.bufferedBytes -= this.buffered.shift()!.length;
      this.deps.log.warn('voice.room.dropped', {
        room: this.init.label,
        hint: 'audio arrived before the engine was ready',
      });
    }
  }

  /** One named speaker's live utterance (see lanes.ts): the lane IS the
   *  speaker, words come back as they are heard, and the platform's own
   *  silence rule closes the utterance with `end()`. */
  lane(init: { speaker: string; user: string; person?: boolean; channel?: string }): VoiceLane {
    return this.laneBook.lane(init);
  }

  /** Transcribe one finished stretch of audio: this room's own engine first
   *  (file/mic lanes), then the shared streaming engine (born on this
   *  utterance if nothing loaded it), then a configured `stt` endpoint. */
  private async transcribeSpeech(pcm: Float32Array): Promise<string | null> {
    if (this.engine && this.engineReady) return await this.engine.transcribe(pcm);
    const run = await this.deps.sharedEngine.ready();
    if (run) return await run.transcribe(pcm);
    const stt = await this.deps.getStt();
    if (!stt) {
      this.deps.log.warn('voice.stt.missing', {
        room: this.init.label,
        hint: 'rooms that report finished speech need a running engine or a voice.stt endpoint',
      });
      return null;
    }
    return await stt.transcribe(pcm);
  }

  async heard(utt: {
    speaker?: string;
    user?: string;
    channel?: string;
    person?: boolean;
    pcm: Float32Array;
  }): Promise<string | null> {
    if (this.stopped) return null;
    const text = await this.transcribeSpeech(utt.pcm);
    if (!text) return null;
    const at = Date.now() / 1000;
    const wake = this.deps.mode === 'meeting' ? scanWake(text, this.deps.wakePhrases) : null;
    this.commitLine(at, at, utt.speaker ?? '', text, {
      wake,
      ...(utt.user !== undefined ? { user: utt.user } : {}),
      ...(utt.channel !== undefined ? { channel: utt.channel } : {}),
      ...(utt.person !== undefined ? { person: utt.person } : {}),
    });
    return text;
  }

  mouth(play: (wav: Buffer) => boolean | Promise<boolean>, stop?: () => void, flush?: () => void): () => void {
    return this.speech.mouth(play, stop, flush);
  }

  onEvent(listener: (event: Record<string, unknown>) => void): () => void {
    this.listeners.push(listener);
    // A page that joins a warm host sees the truth now, not a stale spinner:
    // the current engine state is replayed to the new listener.
    listener({ ev: 'engine', state: this.engineState });
    return () => {
      this.listeners = this.listeners.filter(l => l !== listener);
    };
  }

  /** Module fan-out after any voice lease released: a capacity refusal was
   *  never a lost line — try the pool again. */
  retryTurns(): void {
    this.turns.retry();
  }

  /** Engine events fan out: a lane-tagged event belongs to the room that
   *  opened the lane and to no one else; mixed audio belongs to whoever
   *  listens for it — a named-lane room (Discord) must never fuse another
   *  room's page audio into its own lines. Own-process rooms (file, mic)
   *  hear their own process. */
  private onEngineEvent(e: EngineEvent): void {
    if (this.laneBook.event(e)) return;
    if (this.init.engineInput.type === 'push' && !this.init.streaming) return;
    this.fusion.event(e);
  }

  private identifySlice(t0: number, t1: number): string | null {
    if (!this.deps.embedder || !this.deps.identity) return null;
    const samples = this.engine ? this.engine.slice(t0, t1) : this.deps.sharedEngine.slice(t0, t1);
    if (!samples) {
      this.deps.log.warn('voice.slice.lost', { room: this.init.label, t0, t1 });
      return null;
    }
    const stream = this.deps.embedder.createStream();
    stream.acceptWaveform({ samples, sampleRate: SR });
    if (!this.deps.embedder.isReady(stream)) return null;
    const vec = new Float32Array(this.deps.embedder.compute(stream));
    const m = this.deps.store.identify(vec, t1 - t0, this.deps.identity.threshold);
    this.deps.log.info('voice.identify', { name: m.name, score: +m.score.toFixed(3), minted: m.minted });
    return m.name;
  }

  /** Show the line to the room, act per mode. Meeting: a row in the record.
   *  Call: no row exists — the words go to the session, batched until the
   *  person is finished. */
  private commitLine(
    t0: number,
    t1: number,
    speaker: string,
    text: string,
    opts: { wake: string | null; user?: string; channel?: string; person?: boolean },
  ): void {
    if (this.deps.mode === 'meeting') {
      const id = this.deps.store.appendLine(this.transcript!, t0, t1, speaker, text, {
        wake: opts.wake !== null,
        ...(opts.user !== undefined ? { user: opts.user } : {}),
        ...(opts.channel !== undefined ? { channel: opts.channel } : {}),
      });
      this.emit({ ev: 'line', id, t0, t1, speaker, text });
      if (opts.wake) {
        this.deps.store.touchRoomSession(this.init.label); // the window restarts on every exchange
        this.turns.prompt({
          text: `You were addressed by ${speaker || 'someone'} during a meeting (transcript ${this.transcript}, line ${id}). They said: "${stripWake(text, opts.wake)}". Use the aivi_voice_transcript tool to read back what was said around this moment.`,
          speakers: speaker === '' ? [] : [speaker],
          wake: opts.wake,
        });
      }
      return;
    }
    // Call: the session is the record. Caption the room, batch the words.
    // Aivi's own voice never arrives as data: Discord separates streams
    // server-side, and the file/mic development lanes play nothing back —
    // so what is heard here is a person.
    // Finished words that landed while aivi was speaking are the
    // interruption: it falls silent now. heard() reaches here only with real
    // words (a sniffle transcribes to nothing and never gets this far), and
    // only a LINKED person (`person`) may interrupt — a stranger cannot.
    // Streaming rooms barged already, on the first recognized delta.
    if (this.speech.isSpeaking && opts.person) this.bargeIn();
    // every committed line, in the log: what the room heard is the first
    // thing to check when a transcript looks wrong (2026-10-14 — the
    // operator could see the face's captions but the log said nothing)
    this.deps.log.info('voice.line', { room: this.init.label, speaker, text });
    this.emit({ ev: 'line', t0, t1, speaker, text });
    this.batch.push({ speaker, text });
    this.armFlush();
  }

  /** The finished window: a sentence lands, the window reopens; the window
   *  closing means the person is done talking — one prompt, not one per
   *  sentence. */
  private armFlush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushBatch();
    }, this.deps.finishWindowMs ?? CONVERSATION_GAP_MS);
  }

  private flushBatch(): void {
    if (!this.batch.length) return;
    const said = this.batch;
    this.batch = [];
    // Every line prefixes its speaker to the text when it has one: the
    // model must know who to answer (and `messageMetadata` carries the same
    // names for dreaming's attribution). Named lanes bring platform names,
    // diarizer slots bring their bound person; a nameless line carries no
    // prefix — guessing a name would invent people (ruled 2026-10-14).
    const text = said.map(b => (b.speaker === '' ? b.text : `[${b.speaker}] ${b.text}`)).join('\n');
    const speakers = [...new Set(said.map(b => b.speaker).filter(s => s !== ''))];
    // the words are done; this is the moment they become a prompt — said,
    // so a room that heard something is distinguishable from one that only
    // transcribed (the operator's "is it in transcribe mode?" deserved an
    // answer the log could give, 2026-10-14)
    this.deps.log.info('voice.flush', { room: this.init.label, lines: said.length, speakers });
    this.deps.store.touchRoomSession(this.init.label); // the window restarts on every exchange
    this.turns.prompt({ text, speakers });
  }

  /** Stop talking and listen (see speech.ts): silence the playing answer,
   *  drop the answers still queued to be spoken. The interrupting words
   *  arrive as speech through the normal path and the session gets to
   *  reconsider. Meeting rooms are polite: answers play to the end there. */
  bargeIn(): void {
    if (this.deps.mode !== 'call' || this.stopped) return;
    this.speech.barge();
  }

  private emit(event: Record<string, unknown>): void {
    for (const l of this.listeners) {
      try {
        l(event);
      } catch (error) {
        this.deps.log.warn('voice.listener.failed', { room: this.init.label, error: String(error) });
      }
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.batch.length) {
      this.deps.log.info('voice.batch.dropped', {
        room: this.init.label,
        lines: this.batch.length,
        hint: 'the room closed inside the finished window: those sentences were never finished',
      });
      this.batch = [];
    }
    if (this.sink) {
      this.deps.sharedEngine.detach(this.sink); // the meeting ends; the models stay warm for the next one
      this.sink = null;
    }
    this.laneBook.closeAll();
    const engine = this.engine; // own lanes only: a shared engine outlives every room
    this.engine = null;
    if (engine) await engine.stop(); // no more lines can be born after this
    await this.turns.stop(); // a running turn finishes and releases its lease
  }
}

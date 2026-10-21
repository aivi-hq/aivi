/** One streaming engine for the whole host, warm across meetings.
 *
 *  Rooms attach and detach; the engine itself is born at the **first audio
 *  from any room** and lives until the module stops. A person leaving a
 *  Discord channel closes the *meeting* — connection, room, transcript — and
 *  costs nothing else: the models stay loaded, the next meeting starts ready
 *  (ruled 2026-10-12: engine warmth is @aivi/voice's job, not the platform
 *  consumer's; a rejoin must not reload models because someone walked out).
 *
 *  Fusion stays per-room: every attached room sees every engine event and
 *  keeps its own open line, its own transcript. Audio that arrives before
 *  the load finishes is buffered here (60 s, oldest first) and flushed in
 *  order. A failed load is not cached: the next audio tries again.
 */
import type { EngineEvent, EngineLog, EngineSpec } from './engine.ts';
import { EngineRun } from './engine.ts';

const SR = 16000;
const BUFFER_MAX_BYTES = SR * 2 * 60; // wait-for-engine buffer: 60 s, then oldest goes

export type EngineState = 'idle' | 'loading' | 'ready' | 'failed';

export interface EngineSink {
  onEvent(e: EngineEvent): void;
  onState(state: EngineState): void;
}

export class SharedEngine {
  private run: EngineRun | null = null;
  private starting: Promise<EngineRun | null> | null = null;
  private state: EngineState = 'idle';
  private readonly sinks = new Set<EngineSink>();
  private buffered: Buffer[] = [];
  private bufferedBytes = 0;
  private stopped = false;
  // The engine answers the diarizer question ONCE, at startup; a room that
  // attaches later (the next meeting) must hear the answer too, so it is
  // remembered here — and forgotten when the process dies, because the
  // next engine gets a fresh say.
  private diar: Extract<EngineEvent, { ev: 'diar' }> | null = null;

  private readonly spec: EngineSpec;
  private readonly log: EngineLog;

  constructor(spec: EngineSpec, log: EngineLog) {
    this.spec = spec;
    this.log = log;
  }

  /** A room starts hearing: it sees the current state at once (a page opened
   *  after the load says ready, not idle), then every event from then on. */
  attach(sink: EngineSink): void {
    this.sinks.add(sink);
    if (this.diar) sink.onEvent(this.diar); // the naming truth, before anything else
    sink.onState(this.state);
  }

  /** A room stops hearing. The engine does not care: it keeps its weights. */
  detach(sink: EngineSink): void {
    this.sinks.delete(sink);
  }

  /** PCM in: written when ready, buffered (in order) while loading. */
  push(pcm: Buffer): void {
    if (this.stopped) return;
    if (this.run && this.state === 'ready') {
      this.run.write(pcm);
      return;
    }
    this.buffered.push(pcm);
    this.bufferedBytes += pcm.length;
    while (this.bufferedBytes > BUFFER_MAX_BYTES && this.buffered.length > 1) {
      this.bufferedBytes -= this.buffered.shift()!.length;
      this.log.warn('voice.engine.dropped', { hint: 'audio arrived before the engine was ready' });
    }
    void this.ready();
  }

  /** The running engine, spawning it on first need; concurrent callers share
   *  one load. Null when the load failed — the next audio tries again. */
  ready(): Promise<EngineRun | null> {
    if (this.stopped) return Promise.resolve(null);
    if (this.run && this.state === 'ready') return Promise.resolve(this.run);
    this.starting ??= this.start().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  /** Samples kept for identity slicing, from whatever is loaded. */
  slice(from: number, to: number): Float32Array | null {
    return this.run?.slice(from, to) ?? null;
  }

  private async start(): Promise<EngineRun | null> {
    this.setState('loading');
    const run = new EngineRun(
      this.spec,
      { type: 'push' }, // every room feeds through push; ffmpeg lanes own their process
      {
        onEvent: e => {
          if (e.ev === 'diar') this.diar = e;
          for (const sink of this.sinks) {
            try {
              sink.onEvent(e);
            } catch (error) {
              this.log.warn('voice.engine.sink-failed', { error: String(error) });
            }
          }
        },
        onExit: code => {
          // An engine that died mid-room is not cached: the next audio loads
          // again. Said once loudly — silent model loss is the old crime.
          if (this.stopped || run.eof) return;
          this.log.warn('voice.engine.exited', { code });
          this.run = null;
          this.diar = null; // the next engine gets a fresh say on the diarizer
          this.setState('failed');
        },
      },
      this.log,
    );
    try {
      await run.start();
      this.run = run;
      this.setState('ready');
      const queued = this.buffered;
      this.buffered = [];
      this.bufferedBytes = 0;
      for (const buf of queued) run.write(buf); // audio that arrived first goes in order
      return run;
    } catch (error) {
      this.log.warn('voice.engine.start-failed', { error: String(error) });
      this.setState('failed');
      return null;
    }
  }

  private setState(state: EngineState): void {
    if (this.state === state) return;
    this.state = state;
    for (const sink of this.sinks) {
      try {
        sink.onState(state);
      } catch (error) {
        this.log.warn('voice.engine.sink-failed', { error: String(error) });
      }
    }
  }

  /** Module stop: the only thing that ends the engine. */
  async stop(): Promise<void> {
    this.stopped = true;
    const run = this.run;
    this.run = null;
    this.setState('idle');
    if (run) await run.stop();
  }
}

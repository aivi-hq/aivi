import type { TestContext } from 'node:test';
import { Store } from '@aivi/host';
import type { EngineEvent, EngineRun } from '../src/engine.ts';
import { HearingRoom, type RoomDeps, type RoomInit } from '../src/room.ts';
import type { EngineSink, EngineState, SharedEngine } from '../src/shared.ts';
import { VoiceStore } from '../src/store.ts';
import type { TtsRun } from '../src/tts.ts';
import { boundary } from './boundary.ts';
import { engineSpec } from './process-fixture.ts';
import { turnHost } from './turns-fixture.ts';

/** A tenth of a second of silence: enough audio to be an utterance. */
export const pcm = new Float32Array(1600);

/** One sentence that reached the voice: the test plays its audio out. */
export interface Sentence {
  text: string;
  chunk(wav: string): void;
  end(): void;
}

/** A room with all its machinery and nothing alive: a recorded host, a real
 *  in-memory store, and the shared engine and the voice as the room sees
 *  them. The default is a push room, the shape a platform adapter opens.
 *  Pass a database to share it across rooms — that is how a rejoin is told. */
export function hearingRoom(
  t: TestContext,
  options: {
    mode?: RoomDeps['mode'];
    init?: Partial<RoomInit>;
    deps?: Partial<RoomDeps>;
    database?: Store;
    /** `absent`: the shared engine never loads, so lanes fall back to batch. */
    engine?: 'ready' | 'absent';
  } = {},
) {
  const host = turnHost(t);
  const database = options.database ?? new Store(':memory:');
  if (!options.database)
    t.after(() => {
      if (database.db.isOpen) database.close();
    });
  const store = new VoiceStore(database, host.deps.log);

  const sinks = new Set<EngineSink>();
  // The engine joined a live lane: its first audio was written.
  const joined = boundary<[lane: string]>();
  const live = new Set<string>();
  const transcribe = t.mock.fn<EngineRun['transcribe']>(async () => null);
  const writeLane = t.mock.fn<EngineRun['writeLane']>(lane => {
    if (live.has(lane)) return;
    live.add(lane);
    joined.reach(lane);
  });
  const endLane = t.mock.fn<EngineRun['endLane']>();
  const run = { transcribe, writeLane, endLane } as unknown as EngineRun;
  let state: EngineState = options.engine === 'absent' ? 'idle' : 'ready';
  const ready = t.mock.fn<SharedEngine['ready']>(async () => (options.engine === 'absent' ? null : run));
  const push = t.mock.fn<SharedEngine['push']>();
  const slice = t.mock.fn<SharedEngine['slice']>(() => null);
  const attach = t.mock.fn<SharedEngine['attach']>(sink => {
    sinks.add(sink);
    sink.onState(state);
  });
  const detach = t.mock.fn<SharedEngine['detach']>(sink => {
    sinks.delete(sink);
  });

  // The voice: every stretch of text reaches `sentences` and stays on the
  // air until the test ends it.
  const sentences = boundary<[sentence: Sentence]>();
  const tts = {
    async *chunks(text: string): AsyncGenerator<Buffer> {
      const audio = boundary<[wav: Buffer | null]>();
      sentences.reach({ text, chunk: wav => audio.reach(Buffer.from(wav)), end: () => audio.reach(null) });
      for (let [wav] = await audio.next(); wav !== null; [wav] = await audio.next()) yield wav;
    },
  } as unknown as TtsRun;
  const getTts = t.mock.fn<RoomDeps['getTts']>(async () => tts);
  const getStt = t.mock.fn<RoomDeps['getStt']>(async () => null);

  const room = new HearingRoom(
    { id: 'discord', label: 'room', engineInput: { type: 'push' }, ...options.init },
    {
      ...host.deps,
      mode: options.mode ?? 'call',
      wakePhrases: ['hey assistant'],
      engineSpec,
      agent: 'assistant',
      directory: '/voice',
      identity: undefined,
      embedder: null,
      store,
      sharedEngine: { attach, detach, push, ready, slice } as unknown as SharedEngine,
      getStt,
      getTts,
      resumeMinutes: 30,
      ...options.deps,
    },
  );
  t.after(() => room.stop());
  // What the room shows whoever watches it, from the first replayed state on.
  const events = t.mock.fn<(event: Record<string, unknown>) => void>();
  room.onEvent(events);
  return {
    ...host,
    room,
    database,
    store,
    joined,
    transcribe,
    writeLane,
    endLane,
    ready,
    push,
    slice,
    attach,
    detach,
    sentences,
    getTts,
    getStt,
    events,
    /** One engine event, to every room attached to the shared engine. */
    engineEvent: (event: EngineEvent) => {
      for (const sink of [...sinks]) sink.onEvent(event);
    },
    /** The shared engine changed state: every attached room hears it. */
    engineState: (next: EngineState) => {
      state = next;
      for (const sink of [...sinks]) sink.onState(next);
    },
  };
}

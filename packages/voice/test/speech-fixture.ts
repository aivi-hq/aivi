import type { TestContext } from 'node:test';
import type { Logger } from '@aivi/core';
import { SpeechOut } from '../src/speech.ts';
import type { TtsRun } from '../src/tts.ts';
import { boundary } from './boundary.ts';

/** Every continuation that can run has run. One turn of the event loop
 *  drains the whole microtask queue whatever its depth, so nothing is
 *  counted and no clock moves. Only for state with no boundary of its own —
 *  a speaking window closing behind its last audio. */
export const drained = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

/** One stretch of text that reached the voice: the test plays its audio out. */
interface Sentence {
  text: string;
  chunk(wav: string): void;
  end(): void;
}

/** The voice as a room sees it: every stretch of text reaches `sentences`
 *  and stays on the air until the test ends it. Nothing is synthesized. */
export function speaker() {
  const sentences = boundary<[sentence: Sentence]>();
  // Every stretch that reached the voice so far, in order.
  const spoken: string[] = [];
  const tts = {
    async *chunks(text: string): AsyncGenerator<Buffer> {
      const audio = boundary<[wav: Buffer | null]>();
      spoken.push(text);
      sentences.reach({ text, chunk: wav => audio.reach(Buffer.from(wav)), end: () => audio.reach(null) });
      for (let [wav] = await audio.next(); wav !== null; [wav] = await audio.next()) yield wav;
    },
  } as unknown as TtsRun;
  return { sentences, spoken, tts };
}

type Say = (message: string, fields?: Record<string, unknown>) => void;

/** The speech lane alone: a recorded log and event fan-out, and the fake
 *  voice above. */
export function speechOut(t: TestContext) {
  const debug = t.mock.fn<Say>();
  const info = t.mock.fn<Say>();
  const warn = t.mock.fn<Say>();
  const emit = t.mock.fn<(event: Record<string, unknown>) => void>();
  const voice = speaker();
  const getTts = t.mock.fn<() => Promise<TtsRun | null>>(async () => voice.tts);
  const out = new SpeechOut({
    label: 'room',
    log: { debug, info, warn } as unknown as Logger,
    getTts,
    emit,
  });
  /** A mouth whose every wav is recorded and, when asked, held on the air. */
  const mouth = (playing: (wav: Buffer) => boolean | Promise<boolean> = () => true) => {
    const play = t.mock.fn(playing);
    const stop = t.mock.fn<() => void>();
    // The answer is over for this mouth: the last chunk was handed over.
    const flushed = boundary();
    const flush = t.mock.fn(() => flushed.reach());
    const unregister = out.mouth(play, stop, flush);
    return {
      play,
      stop,
      flush,
      flushed,
      unregister,
      heard: () => play.mock.calls.map(call => String(call.arguments[0])),
    };
  };
  return {
    out,
    debug,
    info,
    warn,
    emit,
    getTts,
    tts: voice.tts,
    sentences: voice.sentences,
    spoken: voice.spoken,
    mouth,
  };
}

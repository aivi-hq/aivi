import type { TestContext } from 'node:test';
import type { Logger } from '@aivi/core';
import type { EngineRun } from '../src/engine.ts';
import { LaneBook, type LanesDeps } from '../src/lanes.ts';
import type { SharedEngine } from '../src/shared.ts';

export function lanes(t: TestContext, mode: LanesDeps['mode'] = 'call') {
  const debug = t.mock.fn();
  const info = t.mock.fn();
  const warn = t.mock.fn();
  const joined = Promise.withResolvers<string>();
  const writeLane = t.mock.fn<EngineRun['writeLane']>(id => {
    joined.resolve(id);
  });
  const endLane = t.mock.fn<EngineRun['endLane']>();
  const run = { writeLane, endLane } as unknown as EngineRun;
  const ready = t.mock.fn<SharedEngine['ready']>(async () => run);
  const transcribe = t.mock.fn<LanesDeps['transcribe']>(async () => 'fallback');
  const speaking = t.mock.fn<LanesDeps['speaking']>(() => false);
  const barge = t.mock.fn<LanesDeps['barge']>();
  const stopped = t.mock.fn<LanesDeps['stopped']>(() => false);
  const commit = t.mock.fn<LanesDeps['commit']>();
  const book = new LaneBook({
    mode,
    wakePhrases: ['hey assistant'],
    label: 'room',
    log: { debug, info, warn } as unknown as Logger,
    sharedEngine: { ready } as unknown as SharedEngine,
    transcribe,
    speaking,
    barge,
    stopped,
    commit,
  });
  return {
    book,
    debug,
    info,
    warn,
    joined: joined.promise,
    writeLane,
    endLane,
    run,
    ready,
    transcribe,
    speaking,
    barge,
    stopped,
    commit,
  };
}

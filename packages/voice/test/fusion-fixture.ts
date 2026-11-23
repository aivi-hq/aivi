import type { TestContext } from 'node:test';
import type { Logger } from '@aivi/core';
import { type FusionDeps, MixedFusion } from '../src/fusion.ts';

export function fusion(t: TestContext, mode: FusionDeps['mode'] = 'meeting') {
  const info = t.mock.fn();
  const emit = t.mock.fn<FusionDeps['emit']>();
  const speaking = t.mock.fn<FusionDeps['speaking']>(() => false);
  const barge = t.mock.fn<FusionDeps['barge']>();
  const identify = t.mock.fn<FusionDeps['identify']>(() => 'Ada');
  const commit = t.mock.fn<FusionDeps['commit']>();
  const deps: FusionDeps = {
    mode,
    wakePhrases: ['hey assistant'],
    label: 'room',
    log: { info } as unknown as Logger,
    emit,
    speaking,
    barge,
    identify,
    commit,
  };
  return { f: new MixedFusion(deps), info, emit, speaking, barge, identify, commit };
}

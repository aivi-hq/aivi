import assert from 'node:assert/strict';
import type { TestContext } from 'node:test';
import type { Logger } from '@aivi/core';
import { Store } from '@aivi/host';
import type { Dispatcher } from '@aivi/plugin/dispatcher';
import type { AiviServices, RunningModule, ToolHandler } from '@aivi/plugin/module';
import type { VoiceAdapter } from '@aivi/plugin/voice';
import { BatchEngineRun } from '../src/batch.ts';
import { voiceConfigSchema } from '../src/config.ts';
import { createVoiceModule } from '../src/module.ts';
import type { HearingRoom, RoomDeps, RoomInit } from '../src/room.ts';
import { SharedEngine } from '../src/shared.ts';
import { VoiceStore } from '../src/store.ts';
import { TtsRun } from '../src/tts.ts';

/** A module, not a host: real in-memory persistence, fake engines and room
 *  consumers. No audio source, process, native model or OpenCode is started. */
export function voiceModule(t: TestContext, input: Record<string, unknown> = {}) {
  const database = new Store(':memory:');
  t.after(() => database.close());
  const info = t.mock.fn();
  const warn = t.mock.fn();
  const log = { info, warn, getChild: () => log, with: () => log } as unknown as Logger;
  const store = new VoiceStore(database, log);
  const tools = new Map<string, ToolHandler>();
  const order: string[] = [];
  const claim = t.mock.fn<AiviServices['tools']['claim']>((descriptor, handler) => {
    tools.set(`${descriptor.namespace}_${descriptor.name}`, handler);
  });
  const releaseTool = t.mock.fn<AiviServices['tools']['release']>(id => {
    order.push('release-tool');
    tools.delete(id);
  });
  const release = t.mock.fn<Dispatcher['release']>(async id => ({ ended: { id, pool: 'default', state: 'active' } }));
  let callback: Parameters<Dispatcher['registerCallback']>[1];
  const registerCallback = t.mock.fn<Dispatcher['registerCallback']>((service, handler) => {
    assert.equal(service, 'voice');
    callback = handler;
  });
  let adapter: VoiceAdapter;
  const unprovide = t.mock.fn(() => {
    order.push('unprovide');
  });
  const provide = t.mock.fn<AiviServices['voice']['provide']>(value => {
    adapter = value;
    return unprovide;
  });
  const wake = t.mock.fn();
  const signal = new AbortController().signal;
  const opencode = t.mock.fn<AiviServices['opencode']>(async () => {
    throw new Error('OpenCode must not be discovered by a module unit');
  });
  const events = { watch: t.mock.fn(() => () => {}) };
  const services = {
    store: database,
    log,
    tools: { claim, release: releaseTool },
    voice: { provide },
    dispatcher: { release, registerCallback },
    wake,
    signal,
    opencode,
    events,
  } as unknown as AiviServices;
  const makeRoom = (init: RoomInit, deps: RoomDeps) => {
    const stop = t.mock.fn(async () => {
      order.push(`room:${init.label}`);
    });
    const retryTurns = t.mock.fn();
    return { init, deps, stop, retryTurns };
  };
  const rooms: ReturnType<typeof makeRoom>[] = [];
  const createRoom = t.mock.fn((init: RoomInit, deps: RoomDeps): HearingRoom => {
    const room = makeRoom(init, deps);
    rooms.push(room);
    return room as unknown as HearingRoom;
  });
  const batchStart = t.mock.method(BatchEngineRun.prototype, 'start', async () => {});
  const batchStop = t.mock.method(BatchEngineRun.prototype, 'stop', async () => {
    order.push('batch');
  });
  // A stubbed start spawns nothing; the stub stands in for a running process.
  const batchAlive = t.mock.getter(BatchEngineRun.prototype, 'alive', () => true);
  const ttsStart = t.mock.method(TtsRun.prototype, 'start', async () => {});
  const ttsStop = t.mock.method(TtsRun.prototype, 'stop', async () => {
    order.push('tts');
  });
  const ttsAlive = t.mock.getter(TtsRun.prototype, 'alive', () => true);
  const sharedStop = t.mock.method(SharedEngine.prototype, 'stop', async () => {
    order.push('shared');
  });
  const config = voiceConfigSchema.parse({ asr: { command: 'fake-asr' }, ...input });
  let running: RunningModule | undefined;
  let stopped = false;
  const start = async () => {
    running = await createVoiceModule(config, createRoom).start(services);
    return running;
  };
  const stop = async () => {
    if (stopped || !running) return;
    stopped = true;
    await running.stop();
  };
  t.after(stop);
  const room = () => {
    adapter.room({ id: 'meet', label: 'meeting' });
    return rooms.at(-1)!;
  };
  const tool = (input: Record<string, unknown>) =>
    tools.get('aivi_voice_transcript')!({ sessionId: 'ses_test', input });
  const dispatch = (...args: Parameters<typeof callback>) => callback(...args);
  return {
    config,
    services,
    store,
    log,
    info,
    warn,
    tools,
    claim,
    releaseTool,
    release,
    registerCallback,
    provide,
    unprovide,
    wake,
    signal,
    opencode,
    events,
    rooms,
    createRoom,
    batchStart,
    batchStop,
    batchAlive,
    ttsStart,
    ttsStop,
    ttsAlive,
    sharedStop,
    order,
    start,
    stop,
    room,
    tool,
    dispatch,
    adapter: () => adapter,
  };
}

import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { test } from 'node:test';
import type { Dispatcher } from '@aivi/plugin/dispatcher';
import type { AiviServices } from '@aivi/plugin/module';
import { MODULE_ID, plugin, voiceConfigSchema } from '../src/index.ts';
import { boundary } from './boundary.ts';
import { voiceModule } from './module-fixture.ts';
import { voiceProcesses } from './process-fixture.ts';

const engine = { command: 'python' };

test('the voice block needs only an engine and fills in the rest', () => {
  const block = voiceConfigSchema.parse({ asr: engine });

  assert.deepEqual(block, {
    asr: { command: 'python', args: [], readyMarker: 'engine ready' },
    directory: '.',
    resumeMinutes: 30,
    wake: { phrases: ['hey assistant', 'hello assistant'] },
  });
  assert.deepEqual(
    voiceConfigSchema.parse({ asr: engine, tts: engine }).tts,
    { command: 'python', args: [], readyMarker: 'tts ready', voice: 'nl_female', stream: true },
    'the voice has its own ready marker and speaks while it synthesizes',
  );
  assert.equal(voiceConfigSchema.parse({ asr: engine, identity: { model: 'voice.onnx' } }).identity?.threshold, 0.5);
});

test('rooms declare their kind: the block carries no mode and no agent', () => {
  assert.equal(voiceConfigSchema.safeParse({ asr: engine, mode: 'meeting' }).success, false);
  assert.equal(voiceConfigSchema.safeParse({ asr: engine, agent: 'assistant' }).success, false);
  const file = voiceConfigSchema.parse({ asr: engine, room: { type: 'file', path: 'meeting.wav' } }).room;
  const mic = voiceConfigSchema.parse({ asr: engine, room: { type: 'mic', mode: 'call' } }).room;
  assert.deepEqual(file, { type: 'file', path: 'meeting.wav', paced: true, mode: 'call' });
  assert.deepEqual(mic, { type: 'mic', mode: 'call' }, 'a room that declares nothing is a call');
});

test('a meeting room of its own is refused without identity: one anonymous speaker is a monologue', () => {
  const room = { type: 'file', path: 'meeting.wav', mode: 'meeting' };

  const refused = voiceConfigSchema.safeParse({ asr: engine, room });
  const named = voiceConfigSchema.parse({ asr: engine, room, identity: { model: 'voice.onnx' } });

  assert.equal(refused.success, false);
  assert.deepEqual(refused.error?.issues[0]?.path, ['identity']);
  assert.equal(named.room?.mode, 'meeting');
});

test('the resume window is whole minutes, zero for a fresh session every join, or false for one forever', () => {
  assert.equal(voiceConfigSchema.parse({ asr: engine, resumeMinutes: 0 }).resumeMinutes, 0);
  assert.equal(voiceConfigSchema.parse({ asr: engine, resumeMinutes: false }).resumeMinutes, false);
  assert.equal(voiceConfigSchema.safeParse({ asr: engine, resumeMinutes: -1 }).success, false);
  assert.equal(voiceConfigSchema.safeParse({ asr: engine, resumeMinutes: 1.5 }).success, false);
  assert.equal(voiceConfigSchema.safeParse({ asr: engine, resumeMinutes: true }).success, false);
});

test('the plugin entry carries the module id and the block schema, and builds the module only when asked', async () => {
  assert.equal(plugin.id, MODULE_ID);
  assert.equal(plugin.configSchema, voiceConfigSchema);

  const module = await plugin.createModule(voiceConfigSchema.parse({ asr: engine, room: { type: 'mic' } }), '/home');

  assert.equal(module.id, 'voice');
});

test('paths in the block resolve against the home: the file a room hears and the directory its agent lives in', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const processes = voiceProcesses(t);
  const h = voiceModule(t, { directory: 'agents', room: { type: 'file', path: 'audio/meeting.wav' } });
  const provided = boundary<Parameters<Dispatcher['provide']>>();
  const dispatcher = {
    ...h.services.dispatcher,
    request: () => ({ lease: { id: 'lease-1', pool: 'default', state: 'preparing' } }),
    provide: async (...work: Parameters<Dispatcher['provide']>) => {
      provided.reach(...work);
      throw new Error('no session in this test');
    },
  };
  const module = await plugin.createModule(h.config, '/home');
  const running = await module.start({ ...h.services, dispatcher } as unknown as AiviServices);
  t.after(() => running.stop());
  const [loaded] = processes.children;

  loaded!.ready();
  loaded!.response({ ev: 'act', t: 0, slot: 0 });
  loaded!.response({ ev: 'delta', text: 'hello there', pos: 1 });
  loaded!.response({ ev: 'act', t: 1.5, slot: -1 });
  t.mock.timers.tick(1500);
  const [lease, work] = await provided.next();

  assert.deepEqual(processes.spawn.mock.calls[1]!.arguments[1].slice(3, 6), [
    '-re',
    '-i',
    resolve('/home', 'audio/meeting.wav'),
  ]);
  assert.equal(lease, 'lease-1');
  assert.deepEqual(work, { agent: 'assistant', directory: resolve('/home', 'agents') });
});

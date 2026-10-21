import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PluginSetupContext } from '@aivi/plugin';
import * as prompts from '@clack/prompts';
import { voiceConfigSchema } from '../src/config.ts';
import setup from '../src/setup.ts';

/** A context answering confirms from a script and recording writes. Nothing
 *  touches disk and no engine runtime is created: these paths decline the
 *  install, so uv is never probed. */
function harness(answers: string[], config: Record<string, unknown>) {
  const queue = [...answers];
  const blocks: { path: string[]; value: unknown }[] = [];
  const notes: string[] = [];
  const ctx: PluginSetupContext = {
    home: '/home',
    configPath: '/home/config.json',
    identityName: 'Clawd',
    config,
    print: () => {},
    withStore: async () => {
      throw new Error('the setup flow reads no store');
    },
    prompts: {
      ...prompts,
      note: (lines = '', title = '') => {
        notes.push(`${title}: ${lines}`);
      },
      confirm: async () => {
        const answer = queue.shift();
        if (answer === undefined) throw new Error('the answer script ran dry');
        return answer === 'yes';
      },
      spinner: () => ({
        start: () => {},
        message: () => {},
        stop: () => {},
      }),
      log: { message: async () => {} },
    } as unknown as typeof prompts,
    async fetch() {
      throw new Error('no platform to fetch');
    },
    async writeConfigBlock(path, value) {
      blocks.push({ path, value });
    },
    async writeSecret() {
      throw new Error('voice writes no secret');
    },
  };
  return { ctx, blocks, notes };
}

test('voice setup writes the engine block pointing at the home’s own runtime, installing nothing', async () => {
  const h = harness(['no', 'no', 'no', 'no', 'no'], { version: 1 });
  const result = await setup(h.ctx);
  assert.equal(result.module, 'voice');
  assert.match(result.summary, /create that runtime/);
  assert.match(result.summary, /Rooms declare their kind/, 'the room-kind story is told at the end of setup');
  assert.match(result.summary, /mixed lines stay nameless/, 'the diarizer no says its consequence');
  assert.match(result.summary, /aivi stays mute/, 'the voice no says its consequence');
  assert.match(result.summary, /nobody gets named/, 'the voiceprint no says its consequence');
  assert.deepEqual(h.blocks[0]!.path, ['plugins', 'voice']);
  const block = voiceConfigSchema.parse(h.blocks[0]!.value);
  assert.equal(block.asr.command, '/home/runtimes/voice/bin/python', 'the runtime installs under the home');
  assert.match(block.asr.args[0]!, /engine\/mlx-engine\.py$/, 'the engine script ships with the package');
  assert.equal(block.asr.diarModel, undefined, 'no diarizer: the feature no is a feature no');
  assert.equal(block.tts, undefined, 'no voice block: a mute aivi is a written choice, not a surprise');
  assert.equal(block.identity, undefined);
});

test('every yes lands in the block even when nothing can download: the choice is the feature', async () => {
  // no runtime exists at /home, so no python is spawned and no model can
  // land here — yet every yes must still write its feature: downloads
  // follow on first use, said in the summary, never silently dropped.
  const h = harness(['no', 'yes', 'yes', 'yes', 'yes'], { version: 1 });
  const result = await setup(h.ctx);
  const block = voiceConfigSchema.parse(h.blocks[0]!.value);
  assert.equal(block.asr.diarModel, 'mlx-community/Nemotron-3-Diarization');
  assert.ok(block.tts, 'the voice block stands');
  assert.equal(block.tts!.voice, 'nl_female', 'the Dutch lady is the default voice');
  assert.match(String(block.identity!.model), /3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced\.onnx$/);
  assert.match(result.summary, /downloads on first use/, 'the summary says the models are not here yet');
  assert.ok(h.notes.join('\n').includes('failed'), 'the voiceprint download that could not run is named, not hidden');
});

test('the written block says nothing about rooms: kind belongs to the room opener', async () => {
  const h = harness(['no', 'no', 'no', 'no', 'no'], { version: 1 });
  await setup(h.ctx);
  const raw = h.blocks[0]!.value as Record<string, unknown>;
  assert.equal('mode' in raw, false, 'no global mode: a room declares call/meeting when it opens');
  assert.equal('agent' in raw, false, 'no global agent: the opener names the agent its rooms speak as');
});

test('a configured voice is never clobbered', async () => {
  const configured = harness([], {
    version: 1,
    plugins: { voice: { asr: { command: '/somewhere/python' } } },
  });
  await assert.rejects(setup(configured.ctx), /already configured/);
  assert.deepEqual(configured.blocks, []);
});

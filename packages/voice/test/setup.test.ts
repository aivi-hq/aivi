import assert from 'node:assert/strict';
import childProcess, { type SpawnSyncReturns } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { PluginSetupCancelled } from '@aivi/plugin';
import { cancelSetup, setupFixture } from '../../plugin/test/setup-fixture.ts';
import { voiceConfigSchema } from '../src/config.ts';
import setup from '../src/setup.ts';

const ASR = 'mlx-community/Voxtral-Mini-4B-Realtime-2602-4bit';
const DIARIZER = 'mlx-community/Nemotron-3-Diarization';
const TTS = 'mlx-community/Voxtral-4B-TTS-2603-mlx-6bit';
const VOICEPRINT = '3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx';

type Command = (command: string, args: readonly string[]) => Partial<SpawnSyncReturns<string>>;

/** The wizard against a scratch home. Every command it would run is answered
 *  here — no uv, no python, no model download — and every answer is scripted
 *  in the order the wizard asks: runtime, transcription, diarizer, voice,
 *  voiceprint. */
function wizard(t: TestContext, answers: unknown[], command: Command = () => ({ status: 0 })) {
  const home = mkdtempSync(join(tmpdir(), 'aivi-voice-setup-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const h = setupFixture(t, answers);
  h.ctx.home = home;
  h.ctx.configPath = join(home, 'config.json');
  const run = t.mock.method(childProcess, 'spawnSync', ((name: string, args: readonly string[]) => ({
    status: 0,
    stdout: '',
    stderr: '',
    ...command(name, args),
  })) as unknown as typeof childProcess.spawnSync);
  syncBuiltinESMExports();
  t.after(() => {
    run.mock.restore();
    syncBuiltinESMExports();
  });
  const runtime = join(home, 'runtimes', 'voice');
  const python = join(runtime, 'bin', 'python');
  const voiceprint = join(home, 'models', VOICEPRINT);
  const place = (file: string, content = '') => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  };
  return {
    ...h,
    home,
    runtime,
    python,
    voiceprint,
    place,
    /** The commands the wizard ran, as typed on a shell. */
    ran: () => run.mock.calls.map(call => [call.arguments[0], ...(call.arguments[1] as string[])].join(' ')),
    block: () => voiceConfigSchema.parse(h.configWrites.mock.calls[0]!.arguments[1]),
    notes: () => h.note.mock.calls.map(call => `${call.arguments[1] ?? ''}: ${call.arguments[0]}`),
  };
}

test('declining everything still writes an engine block that points at the home’s own runtime, installing nothing', async t => {
  const h = wizard(t, [false, false, false, false, false]);

  const result = await setup(h.ctx);

  assert.equal(result.module, 'voice');
  assert.deepEqual(h.configWrites.mock.calls[0]!.arguments[0], ['plugins', 'voice']);
  const block = h.block();
  assert.equal(block.asr.command, h.python, 'the runtime belongs under the home');
  assert.match(block.asr.args[0]!, /engine\/mlx-engine\.py$/, 'the engine script ships with the package');
  assert.equal(block.asr.model, ASR);
  assert.equal(block.asr.diarModel, undefined, 'no diarizer: the feature no is a feature no');
  assert.equal(block.tts, undefined, 'no voice block: a mute aivi is a written choice');
  assert.equal(block.identity, undefined);
  const written = h.configWrites.mock.calls[0]!.arguments[1] as Record<string, unknown>;
  assert.equal('mode' in written, false, 'a room declares call or meeting when it opens');
  assert.equal('agent' in written, false, 'the opener names the agent its rooms speak as');
  assert.deepEqual(h.ran(), [], 'no tool is probed and nothing is downloaded');
  assert.match(result.summary, /no runtime yet — create that runtime before first audio/);
  assert.match(result.summary, /diarizer off: mixed lines stay nameless/);
  assert.match(result.summary, /voice nl_female off: aivi stays mute/);
  assert.match(result.summary, /no voiceprint: nobody gets named, meeting rooms refused/);
  assert.match(result.summary, /Rooms declare their kind/);
  assert.ok(
    h.notes().some(note => note.includes(`uv venv ${h.runtime} --python 3.12`)),
    'the operator is told how to create the runtime by hand',
  );
});

test('every yes lands in the block even when nothing can be downloaded yet', async t => {
  const h = wizard(t, [false, true, true, true, true]);

  const result = await setup(h.ctx);

  const block = h.block();
  assert.equal(block.asr.diarModel, DIARIZER);
  assert.deepEqual(block.tts, {
    command: h.python,
    args: [block.tts!.args[0]],
    readyMarker: 'tts ready',
    voice: 'nl_female',
    model: TTS,
    stream: true,
  });
  assert.match(block.tts!.args[0]!, /engine\/mlx-tts\.py$/);
  assert.equal(block.identity?.model, h.voiceprint);
  assert.deepEqual(h.ran(), [], 'without a runtime there is no python to download with');
  assert.match(result.summary, /diarizer on, downloads on first use/);
  assert.match(result.summary, /voice nl_female on, downloads on first use/);
  assert.match(result.summary, /voiceprint on/);
  assert.ok(
    h.notes().some(note => note.startsWith('Downloads: ') && note.includes(VOICEPRINT)),
    'the voiceprint that could not be fetched is named, not hidden',
  );
  assert.equal(existsSync(h.voiceprint), false);
});

test('a yes to the runtime creates it with uv and downloads each chosen model with its python', async t => {
  const h = wizard(t, [true, true, true, true, true], (command, args) => {
    if (command === 'uv' && args[0] === 'venv') h.place(h.python);
    return { status: args.join(' ').includes(DIARIZER) ? 1 : 0 };
  });
  h.fetch.mock.mockImplementation(async () => new Response(Buffer.from('onnx bytes')));

  const result = await setup(h.ctx);

  const pins = h.ran()[2]!.split(' ').at(-1)!;
  const download = (repo: string) =>
    `${h.python} -c from huggingface_hub import snapshot_download; snapshot_download('${repo}')`;
  assert.match(pins, /engine\/requirements\.txt$/);
  assert.deepEqual(h.ran(), [
    'uv --version',
    `uv venv ${h.runtime} --python 3.12`,
    `uv pip install --python ${h.python} -r ${pins}`,
    download(ASR),
    download(DIARIZER),
    download(TTS),
  ]);
  assert.deepEqual(
    h.spinners[0]!.stop.mock.calls.map(call => call.arguments[0]),
    ['Engine runtime ready'],
  );
  assert.match(result.summary, /runtime created/);
  assert.match(result.summary, /transcription downloaded/);
  assert.match(result.summary, /diarizer on, downloads on first use/, 'a failed download leaves the feature on');
  assert.match(result.summary, /voice nl_female downloaded/);
  assert.equal(h.block().asr.diarModel, DIARIZER);
  assert.equal(readFileSync(h.voiceprint, 'utf8'), 'onnx bytes');
  assert.match(String(h.fetch.mock.calls[0]!.arguments[0]), new RegExp(`${VOICEPRINT}$`));
  assert.deepEqual(
    h.notes().filter(note => note.startsWith('Downloads: ')),
    [`Downloads: These downloads failed; the config stands and the model downloads itself on first use:\n${DIARIZER}`],
  );
});

test('a runtime and a voiceprint that are already there stay as they are', async t => {
  const h = wizard(t, [true, false, false, false, true]);
  h.place(h.python);
  h.place(h.voiceprint, 'the operator’s own copy');

  const result = await setup(h.ctx);

  assert.deepEqual(h.ran(), [], 'uv is not even probed for a runtime that exists');
  assert.equal(h.fetch.mock.callCount(), 0);
  assert.equal(readFileSync(h.voiceprint, 'utf8'), 'the operator’s own copy');
  assert.match(result.summary, /runtime already in place/);
  assert.ok(h.notes().some(note => note.startsWith('Runtime: ')));
  assert.deepEqual(
    h.log.mock.calls.map(call => call.arguments[0]),
    ['models/ already holds the voiceprint; it stays as it is.'],
  );
  assert.equal(h.block().identity?.model, h.voiceprint);
});

test('a voiceprint the server refuses is a failed download, and the choice still stands', async t => {
  const h = wizard(t, [false, false, false, false, true]);
  h.fetch.mock.mockImplementation(async () => new Response('gone', { status: 404 }));

  await setup(h.ctx);

  assert.equal(existsSync(h.voiceprint), false);
  assert.equal(h.block().identity?.model, h.voiceprint);
  assert.ok(h.notes().some(note => note.startsWith('Downloads: ') && note.includes(VOICEPRINT)));
});

test('a host without uv is told how to go on, and nothing is installed or written', async t => {
  const h = wizard(t, [true], command => (command === 'uv' ? { status: null } : {}));

  await assert.rejects(setup(h.ctx), (error: Error) => {
    assert.match(error.message, /aivi never installs tools onto your host unasked/);
    assert.match(error.message, /https:\/\/docs\.astral\.sh\/uv\//);
    assert.match(error.message, /uv pip install -r .*engine\/requirements\.txt/);
    return true;
  });

  assert.deepEqual(h.ran(), ['uv --version']);
  assert.deepEqual(
    h.spinners[0]!.stop.mock.calls.map(call => call.arguments[0]),
    ['uv is not on PATH'],
  );
  assert.equal(h.configWrites.mock.callCount(), 0);
});

test('an environment uv cannot create or fill fails the setup with what uv said', async t => {
  const cases: Array<[step: string, said: Partial<SpawnSyncReturns<string>>, message: RegExp, stopped: string]> = [
    [
      'venv',
      { status: 2, stderr: 'no python 3.12 found\n' },
      /^uv venv .* failed: no python 3\.12 found$/,
      'Could not create the environment',
    ],
    ['venv', { status: 2 }, /^uv venv .* failed: exit 2$/, 'Could not create the environment'],
    [
      'pip',
      { status: 1, stdout: 'no matching wheel\n' },
      /^uv pip install -r .* failed: no matching wheel$/,
      'Could not install the engine runtime',
    ],
    ['pip', { status: 1 }, /^uv pip install -r .* failed: exit 1$/, 'Could not install the engine runtime'],
  ];
  for (const [step, said, message, stopped] of cases) {
    await t.test(`${step} ${JSON.stringify(said)}`, async t => {
      const h = wizard(t, [true], (command, args) => (command === 'uv' && args[0] === step ? said : {}));

      await assert.rejects(setup(h.ctx), { message });

      assert.deepEqual(
        h.spinners[0]!.stop.mock.calls.map(call => call.arguments[0]),
        [stopped],
      );
      assert.equal(h.configWrites.mock.callCount(), 0);
    });
  }
});

test('a cancelled question stops the setup before anything is written', async t => {
  const h = wizard(t, [false, true, cancelSetup]);

  await assert.rejects(setup(h.ctx), PluginSetupCancelled);

  assert.equal(h.configWrites.mock.callCount(), 0);
});

test('a configured voice is never clobbered', async t => {
  const h = wizard(t, []);
  h.ctx.config = { version: 1, plugins: { voice: { asr: { command: '/somewhere/python' } } } };

  await assert.rejects(setup(h.ctx), /already configured/);

  assert.equal(h.ask.mock.callCount(), 0);
  assert.equal(h.configWrites.mock.callCount(), 0);
});

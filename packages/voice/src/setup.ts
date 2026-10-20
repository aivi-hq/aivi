/**
 * The setup `aivi add @aivi/voice` may run: there is no platform account and
 * no secret — the whole decision is the engine runtime and which audio
 * models the home wants. The flow creates the one python runtime aivi is
 * allowed to own under `<home>/runtimes/voice/` (an install, kept apart from
 * `state/`, which is generated data), then walks the audio models ONE AT A
 * TIME — transcription, speaker separation, the voice, the voiceprint — and
 * each yes downloads the model now (into the Hugging Face cache, or the
 * 27 MB ONNX into `<home>/models/`) and writes its config. Each no is an
 * honest feature choice, said plainly: no diarizer means nameless lines, no
 * TTS means a mute aivi, no identity means no speaker naming. Nothing
 * installs without a confirm, and nothing on the host is touched beyond the
 * runtime directory and the home's own files. A plugin is fine without this
 * flow — `aivi add` lists it on its `./config` export alone and the block
 * can be written by hand.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type PluginSetup, type PluginSetupContext, type PluginSetupResult, settled } from '@aivi/plugin';
import { voiceConfigSchema } from './config.ts';

/** The package's own directory: holds engine/mlx-engine.py and its pins. */
const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The models, named once here and nowhere else; the config and the
 *  downloads read from these, so wizard and docs cannot drift. */
const ASR_MODEL = 'mlx-community/Voxtral-Mini-4B-Realtime-2602-4bit';
const DIAR_MODEL = 'mlx-community/Nemotron-3-Diarization';
const TTS_MODEL = 'mlx-community/Voxtral-4B-TTS-2603-mlx-6bit';
const VOICE = 'nl_female'; // the Dutch lady — clean; `casual_female` is the accented one
/** The CAM++ voiceprint: 27 MB, not a HF repo (sherpa-onnx release asset). */
const IDENTITY_FILE = '3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx';
const IDENTITY_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/${IDENTITY_FILE}`;

const run = (command: string, args: string[]) => spawnSync(command, args, { encoding: 'utf8' });

/** Pull a Hugging Face repo into the cache with the runtime's own python —
 *  the same download first audio would trigger, just paid now. */
const hfDownload = (python: string, repo: string) =>
  spawnSync(python, ['-c', `from huggingface_hub import snapshot_download; snapshot_download('${repo}')`], {
    stdio: 'inherit',
  });

/** Create the runtime when it is asked for: probe uv (never install tools
 *  unasked), venv, install the pins. Answers whether it was CREATED now
 *  (already-there is not "made"); a failure throws with the operator's own
 *  way forward in the message. */
async function createRuntime(ctx: PluginSetupContext, envDir: string, python: string, pins: string) {
  if (existsSync(python)) {
    ctx.prompts.note(`runtimes/voice is already there and stays as it is; its bin/python will be used.`, 'Runtime');
    return false;
  }
  const spinner = ctx.prompts.spinner();
  spinner.start('Probing uv');
  const uv = run('uv', ['--version']);
  if (uv.status !== 0) {
    spinner.stop('uv is not on PATH');
    throw new Error(
      'aivi never installs tools onto your host unasked. Install uv (https://docs.astral.sh/uv/) and rerun this command; or create any python 3.12 environment with `uv pip install -r ' +
        pins +
        '` and write the voice block by hand.',
    );
  }
  spinner.message('Creating runtimes/voice');
  const venv = run('uv', ['venv', envDir, '--python', '3.12']);
  if (venv.status !== 0) {
    spinner.stop('Could not create the environment');
    throw new Error(`uv venv ${envDir} failed: ${(venv.stderr || venv.stdout || '').trim() || `exit ${venv.status}`}`);
  }
  spinner.message('Installing the pinned engine runtime (this is the big download)');
  const pip = run('uv', ['pip', 'install', '--python', python, '-r', pins]);
  const made = pip.status === 0;
  spinner.stop(made ? 'Engine runtime ready' : 'Could not install the engine runtime');
  if (!made)
    throw new Error(
      `uv pip install -r ${pins} failed: ${(pip.stderr || pip.stdout || '').trim() || `exit ${pip.status}`}`,
    );
  return made;
}

const setup: PluginSetup = async (ctx): Promise<PluginSetupResult> => {
  const existing = (ctx.config.plugins as Record<string, unknown> | undefined)?.voice;
  if (existing !== undefined)
    throw new Error(
      'Voice is already configured (the plugins.voice block in config.json). Edit that block; aivi add configures a plugin that is not configured yet.',
    );
  const envDir = join(ctx.home, 'runtimes', 'voice');
  const python = join(envDir, 'bin', 'python');
  const engine = join(packageDir, 'engine', 'mlx-engine.py');
  const ttsEngine = join(packageDir, 'engine', 'mlx-tts.py');
  const pins = join(packageDir, 'engine', 'requirements.txt');
  ctx.prompts.note(
    [
      'Voice hears rooms through one engine process per host: streaming transcription with speaker',
      'separation on it (MLX), batch answers in the same process, and optional CAM++ identity from ONNX.',
      'The runtime lives under runtimes/voice (uv, python 3.12, mlx-audio pinned by',
      'engine/requirements.txt — about a gigabyte). Then each audio model is asked about one at a',
      'time: yes downloads it now, no is a feature choice with consequences said in the question.',
      'After this: configure Discord voice (or a file/mic development lane) — and a meeting room',
      'that must know who spoke needs the diarizer and the voiceprint.',
    ].join('\n'),
    'What voice needs',
  );
  const wantsRuntime = settled(
    ctx,
    await ctx.prompts.confirm({
      message: `Create the MLX engine runtime in runtimes/voice now? (~1 GB, one time)`,
      initialValue: true,
    }),
  );
  let made = false;
  if (wantsRuntime) made = await createRuntime(ctx, envDir, python, pins);
  else
    ctx.prompts.note(
      `Nothing installed. Before first audio: uv venv ${envDir} --python 3.12 && uv pip install --python ${python} -r ${pins}.`,
    );
  const haveRuntime = existsSync(python);
  const lost: string[] = []; // downloads that failed: said at the end, never hidden

  /** One model, one question, one download attempt. The question's YES is
   *  the FEATURE (it lands in the block whatever happens); the download is
   *  convenience — `here` answers whether the model is HERE NOW. A failed
   *  download says so, and the model still arrives lazily on first use. */
  const askModel = async (question: string, repo: string): Promise<{ on: boolean; here: boolean }> => {
    const yes = settled(ctx, await ctx.prompts.confirm({ message: question, initialValue: true }));
    if (!yes) return { on: false, here: false };
    if (!haveRuntime) return { on: true, here: false }; // lazy on first audio, said in the summary
    await ctx.prompts.log.message(`Downloading ${repo} — progress below, this can take a while.`);
    const dl = hfDownload(python, repo);
    if (dl.status !== 0) lost.push(repo);
    return { on: true, here: dl.status === 0 };
  };

  // One at a time, in the order the voice needs them.
  const asr = await askModel(
    `Download the transcription model now? (${ASR_MODEL}, ~2.5 GB — first audio would wait for it either way)`,
    ASR_MODEL,
  );
  const diar = await askModel(
    `Download the speaker-separation model now? (${DIAR_MODEL}, ~400 MB. Without it, mixed-audio lines carry NO speaker: naming a slice that may blend two voices invents people.)`,
    DIAR_MODEL,
  );
  const tts = await askModel(
    `Download the voice model now? (${TTS_MODEL}, ~3.5 GB. Without it, aivi answers in text and stays MUTE.)`,
    TTS_MODEL,
  );
  const identity = settled(
    ctx,
    await ctx.prompts.confirm({
      message: `Download the voiceprint model now? (CAM++, 27 MB into models/. Without it nobody gets named and meeting rooms are refused.)`,
      initialValue: true,
    }),
  );

  const block: Record<string, unknown> = {
    asr: {
      command: python,
      args: [engine],
      model: ASR_MODEL,
      ...(diar.on ? { diarModel: DIAR_MODEL } : {}),
    },
  };
  if (tts.on)
    block.tts = {
      command: python,
      args: [ttsEngine],
      voice: VOICE,
      model: TTS_MODEL,
      stream: true,
    };
  if (identity) {
    const modelPath = join(ctx.home, 'models', IDENTITY_FILE);
    if (existsSync(modelPath)) {
      await ctx.prompts.log.message('models/ already holds the voiceprint; it stays as it is.');
    } else {
      try {
        const res = await ctx.fetch(IDENTITY_URL);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        mkdirSync(dirname(modelPath), { recursive: true });
        writeFileSync(modelPath, Buffer.from(await res.arrayBuffer()));
      } catch (error) {
        lost.push(IDENTITY_URL);
        void error;
      }
    }
    block.identity = { model: modelPath };
  }
  const parsed = voiceConfigSchema.safeParse(block);
  if (!parsed.success) throw new Error('The voice block aivi writes does not load its own schema; this is a bug.');
  await ctx.writeConfigBlock(['plugins', 'voice'], block);

  const here = (m: { on: boolean; here: boolean }, name: string) =>
    !m.on ? `${name} off` : m.here ? `${name} downloaded` : `${name} on, downloads on first use`;
  const parts: string[] = [];
  parts.push(
    wantsRuntime
      ? `runtime ${made ? 'created' : 'already in place'}`
      : 'no runtime yet — create that runtime before first audio',
  );
  parts.push(here(asr, 'transcription'));
  parts.push(`${here(diar, 'diarizer')}${diar.on ? '' : ': mixed lines stay nameless'}`);
  parts.push(`${here(tts, `voice ${VOICE}`)}${tts.on ? '' : ': aivi stays mute'}`);
  parts.push(identity ? 'voiceprint on' : 'no voiceprint: nobody gets named, meeting rooms refused');
  const summary = `Voice is configured — ${parts.join('; ')}. Rooms declare their kind where they are configured — Discord voice is a call (default); a meeting room says "mode": "meeting".`;
  if (lost.length)
    ctx.prompts.note(
      `These downloads failed; the config stands and the model downloads itself on first use:\n${lost.join('\n')}`,
      'Downloads',
    );
  return { module: 'voice', summary };
};

export default setup;

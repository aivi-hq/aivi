/** The voice plugin's registry declaration, at its `./config` subpath: the
 *  module id, the block's own schema, and the lazy bridge to the module code.
 *
 *  Voice is the hearing capability: models, diarizer, person memory, wake,
 *  transcripts, and a voice. It provides the one adapter the kit's `Voice`
 *  seat holds; every module standing in a room (discord today, meet/teams/
 *  zoom tomorrow) opens a room through that seat and never imports this
 *  package. Nothing here is required by the rest of aivi: the package is
 *  composed only when it is listed in `aivi-plugins`, and the heavy parts
 *  (engine process, models) stay with it.
 */
import { absolutePath } from '@aivi/core';
import type { AiviPlugin } from '@aivi/plugin';
import { z } from 'zod';

export const MODULE_ID = 'voice';

/** A sidecar engine: any command speaking the stdio protocol named by its
 *  ready marker. The package never assumes python, a model or a GPU exists. */
const engineSchema = z.strictObject({
  command: z.string().min(1).describe('Executable to spawn as the engine.'),
  args: z.array(z.string()).default([]),
  /** stderr line that means the engine has loaded its models and will read stdin. */
  readyMarker: z.string().default('engine ready'),
  /** Model names handed to the engine through its environment (the reference
   *  engine: VOXTRAL_MODEL); absent means the engine script's own default. */
  model: z.string().min(1).optional(),
  /** Diarization model for the streaming engine (reference: DIAR_MODEL).
   *  Said ONCE, at engine startup: set → the model loads before the engine
   *  is ready, and one that will not load fails the start loudly; unset →
   *  expected, no diarizer — mixed audio is cut by loudness only and its
   *  lines carry no speaker, because naming a slice that may blend two
   *  voices invents people (ruled 2026-10-14). Named lanes (Discord) never
   *  touch the diarizer whatever this says. */
  diarModel: z.string().min(1).optional(),
});

/** The voice aivi speaks with: text requests in, wav answers out
 *  (`engine/mlx-tts.py` reference). A room registers a mouth; without a
 *  `tts` block aivi answers in text and logs that it is mute. */
const ttsSchema = z.strictObject({
  command: z.string().min(1).describe('Executable to spawn as the TTS engine.'),
  args: z.array(z.string()).default([]),
  readyMarker: z.string().default('tts ready'),
  /** Engine's own voice name, passed through untouched (Voxtral TTS: nl_female). */
  voice: z.string().default('nl_female'),
  /** Model name through the environment (VOXTRAL_TTS_MODEL); the script's
   *  own default when unset. */
  model: z.string().min(1).optional(),
  /** Speak while synthesizing: chunks of speech land and play as Voxtral
   *  generates them (its own interval, its own seam handling). False waits
   *  for the finished sentence — the default is the live voice. */
  stream: z.boolean().default(true),
});

/** Voice's own development lanes: a file/mic fed straight through the
 *  engine. Platform rooms (discord, meet) are opened by their own modules.
 *  Like any room these declare what they are: `mode` (default call). */
const roomSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('file'),
    path: z.string().min(1),
    /** Feed at natural speed. Off (turbo) is only for offline experiments:
     *  it breaks the switch-lag a live listener feels. */
    paced: z.boolean().default(true),
    mode: z.enum(['call', 'meeting']).default('call'),
  }),
  z.strictObject({
    type: z.literal('mic'),
    /** ffmpeg capture device; platform default when absent. */
    device: z.string().optional(),
    mode: z.enum(['call', 'meeting']).default('call'),
  }),
]);

export const voiceConfigSchema = z
  .strictObject({
    /** The streaming ASR engine: transcription + diarization + batch answers
     *  in one process (engine/mlx-engine.py reference); the diarizer loads
     *  at startup when `asr.diarModel` is set, and its absence is an
     *  expected configuration, not a failure. Paired with `tts`. */
    asr: engineSchema,
    /** A separate batch transcriber for utterances a platform already
     *  segmented and named (engine/mlx-batch.py speaks its protocol).
     *  Absent: the streaming engine answers batch requests in its own
     *  process — one engine per host, not one per job. */
    stt: engineSchema.optional(),
    tts: ttsSchema.optional(),
    /** Dispatcher pool the room sessions draw slots from — a name in
     *  `dispatcher.pools`, each pool one endpoint (capacity + optional
     *  model + optional fallback). Voice endpoints (local, remote) are pools
     *  of their own, like every other kind of work. Absent: the dispatcher's
     *  `default` pool — and with no pools configured at all, capacity is not
     *  moderated and turns run unbounded, the dispatcher's rule. */
    pool: z.string().min(1).optional(),
    /** OpenCode location that defines the agent. Default: the aivi home. */
    directory: z.string().min(1).default('.'),
    /** Pin room sessions to their own model; absent means the agent's. */
    model: z
      .strictObject({ providerID: z.string().min(1), modelID: z.string().min(1), variant: z.string().optional() })
      .optional(),
    /** How long after the last exchange a room resumes its OpenCode session:
     *  minutes of quiet, `0` (every join starts a fresh session — an old
     *  conversation is not free, it is prefill), or `false` to always resume
     *  the same session (one conversation forever, the pre-window behavior).
     *  An expired session is not deleted — OpenCode keeps its history; the
     *  room just stops pointing at it. */
    resumeMinutes: z.union([z.number().int().min(0), z.literal(false)]).default(30),
    wake: z
      .strictObject({
        /** Phrases scanned mechanically on streaming text (case- and
         *  diacritic-insensitive, word-bounded): "Hey, assistant!" and
         *  "hey  assistant" all match "hey assistant"; "Hello, assistant?"
         *  needs its own entry. Meeting mode only. Ruled 2026-10-13: the
         *  default names a word ASR actually transcribes — "aivi" came out
         *  as "AIBI" or "evie" more often than itself. */
        phrases: z.array(z.string().min(1)).default(['hey assistant', 'hello assistant']),
      })
      .default({ phrases: ['hey assistant', 'hello assistant'] }),
    identity: z
      .strictObject({
        /** CAM++-family speaker embedding model (ONNX, 16 kHz). */
        model: z.string().min(1),
        /** Cosine floor for "this is that stored voice". */
        threshold: z.number().min(0).max(1).default(0.5),
      })
      .optional(),
    /** Voice's own room for development and testing; platform rooms come
     *  from their own modules through the `Voice` seat. */
    room: roomSchema.optional(),
  })
  .superRefine((config, ctx) => {
    // Voice's own rooms carry mixed anonymous audio: a meeting without
    // person memory is a meeting nobody can be named in.
    if (config.room?.mode === 'meeting' && !config.identity) {
      ctx.addIssue({
        code: 'custom',
        path: ['identity'],
        message: 'a meeting room is pointless without identity: a meeting with one anonymous speaker is a monologue',
      });
    }
  });
export type VoiceConfig = z.infer<typeof voiceConfigSchema>;

/** The registry entry: `aivi serve` builds the module from the validated
 *  block; `directory` resolves against the home here, and the module code is
 *  imported lazily so composing the schema stays cheap. */
export const plugin: AiviPlugin<VoiceConfig> = {
  id: MODULE_ID,
  configSchema: voiceConfigSchema,
  createModule: (config, home) =>
    // The cycle back into this file (the module imports its own schema) is
    // that lazy design, not a tangle.
    import('./module.ts').then(m =>
      m.createVoiceModule({
        ...config,
        directory: absolutePath(home, config.directory),
        room:
          config.room?.type === 'file' ? { ...config.room, path: absolutePath(home, config.room.path) } : config.room,
      }),
    ),
};

# Voice as providers: cloud-first audio, local server as a peer (2026-10-15)

> **DEFERRED — operator ruling 2026-10-15:** ship what we have as honest
> 0.x; cloud providers come later. This file is verified research kept for
> that later round, not a pending plan. Do not build from it without a new go.

## Why

The voice plugin's architecture is the demo's, not aivi's: a python process
spawned by the host, speaking a private stdio protocol, holding all the
weights. LLMs swap providers with three config lines (`baseUrl`, `apiKey`,
`model`); voice cannot swap at all. The operator ruled (repeatedly): **work
with APIs; offer a local audio server as a SEPARATE process the operator
runs — like mlx-serve, which aivi does not ship or manage — and treat cloud
the same way.** This plan replaces the engine-process design with that
shape. It supersedes the engine/spawn sections of `voice-ship.md` (§ the
stdio engine, `DIAR_MODEL` startup ruling stays true INSIDE the server).

## What the research verified (all live docs, 2026-10-15)

### Streaming ASR with speaker labels (the hard requirement)

| Vendor | Wire | Speaker labels | Dutch | Notes |
| --- | --- | --- | --- | --- |
| Deepgram | `wss://api.deepgram.com/v1/listen?model=nova-3&language=nl&diarize_model=v1&interim_results=true&encoding=linear16&sample_rate=16000`, `Authorization: Token <key>`, binary frames | integer `words[].speaker` per word; `is_final`, `speech_final`, `UtteranceEnd`, `SpeechStarted` events | `nl` on nova-3 & nova-2 (also `multi`) | streaming diarizer v1; `diarize_model=v2` is batch-only. Close with `{"type":"CloseStream"}` |
| AssemblyAI | `wss://streaming.assemblyai.com/v3/ws?sample_rate=16000&speech_model=universal-3-5-pro&speaker_labels=true` | per-turn `speaker_label` + per-word `speaker`; revises labels with context | yes (multilingual list includes NL) | diarization +$0.12/hr; unlimited concurrency |
| Soniox | `wss://stt-rt.soniox.com/transcribe-websocket` (JSON config msg, binary frames) | per-token `speaker` string | 60+ languages incl. NL | sub-200 ms, turn detection, EU regional endpoint |

All three: one websocket, PCM in, text + speaker out. **No OpenAI API does
this** — OpenRouter's `/api/v1/audio/transcriptions` is batch-only (base64
upload, 60 s processing timeout, no diarizer), and OpenAI Realtime is a
voice-agent API, not a diarized meeting transcriber. So streaming ASR has
no existing common denominator → we define the protocol (below).

### TTS

OpenAI's `POST /v1/audio/speech` (text in, **raw audio streamed back**,
`response_format`: `pcm`/`wav`/`opus`/`mp3`) is already the de-facto
seam: OpenAI, OpenRouter (ElevenLabs/Gemini/MiniMax/Grok voices),
the mlx-audio server, llama.cpp's server, vLLM all implement it.
ElevenLabs native (`/v1/text-to-speech/{voice_id}/stream`, `xi-api-key`,
`pcm_16000`…) differs only in auth/path → small adapter.

### Batch ASR (Discord's finished utterances, file lanes)

OpenAI's `POST /v1/audio/transcriptions` is the seam: OpenRouter, Groq,
the mlx-audio server implement it. No diarization needed here (Discord
already names speakers).

## Shape

### aivi config — the LLM pattern, applied to audio

```jsonc
"voice": {
  "asr":  { "provider": "deepgram", "apiKey": "${DEEPGRAM_API_KEY}",
            "model": "nova-3", "language": "nl" },
  "tts":  { "provider": "openai-compatible",
            "baseUrl": "https://openrouter.ai/api/v1",
            "apiKey": "${OPENROUTER_API_KEY}",
            "model": "google/gemini-3.1-flash-tts-preview", "voice": "Kore" },
  "identity": { "model": "~/.aivi/models/campplus.onnx" }  // stays
}
```

`provider` picks the wire adapter; `baseUrl` optional (vendor default);
point `asr` at `http://127.0.0.1:8321` and the same client talks to the
local server. Capabilities are declared by the adapter+config:
**diarization on/off** → off means mixed lines carry no speaker (the
standing ruling — never guess a name).

### The audio server — `aivi-audio-server` (PyPI, uvx; operator-run)

Separate package (own repo dir `packages/audio-server/`, python, not
imported by aivi, not spawned by aivi). One command, mlx-serve style:

```sh
uvx aivi-audio-server --asr mlx-community/Voxtral-Mini-4B-Realtime-2602-4bit \
                      --diar mlx-community/Nemotron-3-Diarization \
                      --tts mlx-community/Voxtral-4B-TTS-2603-mlx-6bit \
                      --port 8321
```

Endpoints:
- `GET /health` — models loaded, capabilities.
- `POST /v1/audio/speech` + `POST /v1/audio/transcriptions` — **OpenAI
  compatible** (the mlx-audio library already ships such a server; we build
  ours on it, so those two come almost for free).
- `WS /v1/stream` — the diarized streaming protocol (below): the one piece
  mlx-audio's server lacks (its realtime route is VAD chunking, no
  speakers). Our `mlx-engine.py` Streamer/Lane logic moves behind it.

The diarizer rulings survive unchanged, they just live here now: load at
startup when `--diar` given, fail loud when configured-but-missing,
segments not raw frames, `low` preset.

### The streaming protocol (what `/v1/stream` speaks, and what every ASR adapter maps to)

Deliberately small — it is our own, modeled on what all three vendors
already send (they converge on the same events):

client → server: binary PCM frames; `{"type":"close"}`.
server → client, JSON:
- `{"ev":"delta","text":"...","speaker":0|null,"final":false}` — words as
  they land; `speaker` = diarizer slot integer, `null` when the provider
  has no diarizer.
- `{"ev":"turn","speaker":0|null,"text":"...","final":true,"from":s,"to":s}`
  — one utterance from one speaker, closed by the provider's endpointing
  (this replaces both the engine's act events AND fusion's energy
  backstop — the vendor does turn detection; the energy backstop stays
  only as the local-server fallback).
- `{"ev":"diar","on":true|false}` — first event, capability truth (same
  ruling as today).

Fusion keeps its job: slot→person voiceprint binding (once per slot,
middle-half hash, ≥2 s) — from the host's own audio ring buffer (moves from
engine to room: the host has the audio anyway, the server stays stateless
per-connection). CAM++ identity stays an in-process npm dep (27 MB, no
cloud equivalent, no server round-trip).

### Host side — delete list

`engine.ts` (stdio spawn, readyMarker), `shared.ts`, `batch.ts`, `tts.ts`
(stdio), the engine-JSONL protocol, ffmpeg source-spawning for the engine,
`DIAR_MODEL`/`VOXTRAL_MODEL` env plumbing, and the per-turn session-close
language-flip class of bugs (providers own sessions). What stays untouched:
rooms, fusion's slot→person binding, turns/steer, face, transcripts store,
wake (wake phrases still scan text), barge-in.

### Audio leases become real (and now mean something on cloud too)

`voice-asr` pool: a room's live stream holds one slot for its life; no slot
→ the room buffers audio and waits (queued, never denied — dispatcher's
rule). `voice-tts`: one slot per in-flight synthesis. On cloud, the pool IS
the rate limit you'd pay for anyway; on local, it's the GPU. The plan
doc's §10 "ruled, unbuilt" gets built here, because the seam that makes it
meaningful (network providers, N concurrent connections) is what we're
adding.

### Setup wizard (`aivi add @aivi/voice`) becomes the LLM wizard

1. Provider: cloud (deepgram/assemblyai/soniox/openai-compatible-tts) or
   local (`aivi-audio-server` URL). One choice per direction (asr/tts).
2. Key prompt (asks; verifies against the running server like every other
   plugin wizard does — a probe request, not a blind write).
3. Model/voice defaults per provider; Dutch default `language: "nl"`.
4. It does NOT install or start anything heavy — if local is chosen it
   prints the `uvx aivi-audio-server …` line and probes the URL, exactly
   like the mlx-serve relationship. The ~7 GB download only ever happens
   inside the operator-run server.

## Build order (nothing regresses, one gate per step)

1. **Seam in the host**: `AsrStream`/`Synth` interfaces + provider registry;
   move the ring buffer to the room; fusion speaks to the seam (energy
   backstop stays as fallback). Wire the current local engine behind a
   `local` adapter so every existing gate stays green while the rest lands.
2. **`aivi-audio-server` package**: mlx-audio's server + our `/v1/stream`
   route (the Streamer logic, moved). Dev home points at it; live-meet
   re-verification with the operator's ears.
3. **First cloud provider, verified live**: Deepgram recommended (Dutch,
   streaming diarization, free trial credit) — ~150 lines of adapter +
   a real Dutch meeting through it. Soniox/AssemblyAI follow the same
   adapter shape.
4. **TTS seam**: OpenAI-compatible `/v1/audio/speech` client (OpenRouter or
   OpenAI or the local server), ElevenLabs native as second adapter if the
   operator wants their voices specifically.
5. **Audio leases** (`voice-asr`/`voice-tts` pools) on top of the seam.
6. **Wizard + docs** as above; then the beta tagging (meet = beta, rest v1)
   and the clean-install test the operator wants to run.

## Honest cautions

- Deepgram's streaming diarizer on `language=nl`/`multi` is not explicitly
  guaranteed by their diarization page — step 3 verifies it with a real
  Dutch sample BEFORE we document it. If it disappoints, Soniox is the
  diarization-first vendor (that's their headline feature).
- Cloud costs money per meeting-hour (DG ~$0.26/h with diarization, AA
  $0.15–0.45/h + $0.12 diar, Soniox ~$0.30/h, TTS per character — all
  rough, verify at signup) — the local server stays first-class precisely
  so aivi never REQUIRES a key.
- **Cloud means the room's audio leaves the machine.** DG/AA/Soniox all
  advertise zero retention ("never stored"), but it is still someone
  else's server — the local provider exists so the privacy choice is real.
- The clock alignment is the fiddly part: vendor word timestamps are
  stream-relative; the host must map them onto its own ring buffer to cut
  voiceprint slices from the right milliseconds. One arithmetic, done
  carefully once, in the seam.
- Provider endpointing replaces our energy backstop on cloud — turn
  boundaries will feel slightly different; the face/listening wiring keys
  off deltas, which all vendors send, so it survives.
- The `speakers:` plural metadata, `[name] words` prompt ruling, and the
  slot→person DB survive untouched.

## Open questions (for the operator)

1. Which cloud ASR gets the verified-first slot — Deepgram (recommended)
   or Soniox? Needs a trial key from the operator either way.
2. TTS: is OpenRouter/OpenAI-compatible voices enough, or do you want the
   ElevenLabs native adapter (your current voices are mlx presets, so
   "enough" is likely)?
3. Package name: `aivi-audio-server` (PyPI) — fine, or prefer an npm name
   shipping python like the rest of aivi?

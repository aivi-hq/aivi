# @aivi/voice — optional live hearing for aivi: streaming speech with learned speaker identity

The hearing **capability**, not a channel. Modules that stand in a room —
`@aivi/channel-discord` today, meet/teams/zoom tomorrow — open a room through
the kit's `Voice` seat and feed it audio; they never import this package.
Nothing here is required by the rest of aivi: the package is composed only
when it is listed in `aivi-plugins`, and without it `services.voice.room(...)`
fails with `VoiceNotLoaded: aivi add @aivi/voice`. One honest failure, no
ordering ceremony.

## The two modes — declared by the room, not the block

A room **is** a call or a meeting, and the module opening it says which
(`RoomOptions.mode`, default `call` — ruled 2026-10-13: the voice block
carries no mode, because rooms differ and a call/meeting host coexists).
Call is the default because it is the common case and loads the least.

- **`call`** — the conversation, not a record. **No transcript rows exist**:
  the OpenCode session *is* the record. Sentences close and batch into one
  prompt once the person is finished — a quiet gap (`1.5 s`, the one
  setTimeout in voice: between utterances nothing flows to time against).
  A sentence that lands mid-turn **steers** the running turn (the
  interjection). And aivi can be interrupted — **but only by a real word**:
  barge-in waits for recognized WORDS from a **linked person**, not a bare
  speaking start, so a sniffle (which transcribes to nothing) no longer
  silences a whole answer for nothing, and a stranger cannot interrupt at all
  (see `lane`'s and `heard`'s `person`). A platform that demuxes its speakers
  (Discord) streams each utterance LIVE (a `lane` per speaker): words come
  back while the person is still talking, so the interruption lands on the
  first recognized word, not at the end of the utterance. On words: the
  playing answer stops mid-sentence,
  answers queued or synthesizing die, the interrupting words go in and the
  session reconsiders. `identity` is optional here. Aivi's own voice never
  comes back as data — Discord separates the streams server-side, the
  file/mic development lanes play nothing back — so there is nothing to
  guard against.
- **`meeting`** — lines only append to the transcript (SQLite, yours to dream
  over); that record is what a meeting *is*. The wake phrase (`wake.phrases`,
  scanned mechanically on streaming text, case- and diacritic-insensitive,
  whole words) is the only thing that activates the session: the addressed
  sentence (phrase stripped) plus the `aivi_voice_transcript` tool to read
  the meeting back. Meetings are polite: answers play to the end, barge-in
  does nothing. A streaming room without `identity` is refused — a meeting
  with one anonymous speaker is a monologue.

## Speaking the answer as it is written

The answer is spoken **sentence by sentence, while the model is still writing
it** — the first sound waits for the first sentence, not the whole reply.
Voice watches the same OpenCode events the channels' progress reads
(`session.text.started` / `.delta` for the room's session), cuts complete
sentences off the front, and sends each to the voice at once; the last
clause, if it has no closing punctuation, goes out when the answer ends.
`@discordjs/voice` plays the sentences back to back in order.
And each sentence speaks **while it synthesizes** too (`tts.stream`, default
on): Voxtral TTS yields audio chunks as it generates them — its own interval,
its own seam handling — and every chunk plays the moment it lands, so the
first *sound* waits for the first chunk, not the finished sentence. A barge-in
stops the playing chunk and the rest of the sentence goes unheard. This is
the streaming-model contract used honestly end to end: these models stream,
so voice consumes them as a stream.

## The room's session (`plugins.voice.resumeMinutes`)

Every room — call or meeting — talks to one OpenCode session, remembered in
the voice store under the room's label and surviving restarts. Rejoining
within `resumeMinutes` (default **30** minutes since the last exchange —
every sentence restarts the clock) resumes it: a coffee break does not end
the conversation. Past the window the room opens a **fresh** session,
logged (`voice.session.expired`) — an old conversation is not free to
carry, it is prefill; OpenCode keeps its history, the room just stops
pointing at it. `0`: every join starts fresh. `false`: always resume the
same session, however long the quiet (the old behavior, on purpose). The
window is checked when the room opens — a Discord meeting is an open, so a
rejoin is the question; a room mid-meeting never loses its session.

## How identity works (no enrollment, no preload step)

Nobody is enrolled. Each closed turn of a streaming room is sliced, embedded
(CAM++), and cosine-scanned against every stored voice: at/above
`identity.threshold` (default 0.5) it is that person and the sample sharpens
them; below it, a blip under 2 s keeps the nearest label for continuity, a
real utterance mints a fresh `tN`. The store is SQLite in aivi's database, so
recognizing someone again next week is the same lookup. Cost scales with one
dot product per stored voice — thousands of people are microseconds, nothing
is loaded up front. Rename voices by editing `voice_identities.name`.

Rooms that name their speakers (Discord) skip all of this: the platform's
name stands, and this plugin only transcribes.

## Capacity: voice pools are dispatcher pools

Room sessions are normal OpenCode sessions, and every turn takes a slot from
the **dispatcher** — the same capacity system ticket workers use. A pool is
an endpoint: capacity, an optional model, an optional fallback. Voice
endpoints (your local box, a remote one) are pools like any other:

```json
"dispatcher": {
  "pools": {
    "default":     { "capacity": 1 },
    "voice-local": { "capacity": 2, "model": "provider/model-id" },
    "voice-remote": { "capacity": 1, "model": "provider/remote-model", "fallback": "voice-local" }
  }
},
"voice": { "pool": "voice-local", ... }
```

A room's session is **born on the pool that grants its first slot** (the
pool's model decides at session create) and stays there: a resume returns to
its own pool, never a fallback. `pool` absent means the `default` pool; with
no pools configured at all, capacity is not moderated — the dispatcher's
rule, not ours. A full pool is never a lost line: the dispatcher queues the
request and hands the slot to it when one frees. Leases left behind by a
crash are released at startup (a voice turn has no ticket to block).

Categories keep their capacity apart: the room opener may carry its own
`pool` (`RoomOptions.pool`), which beats the voice block's — so Meet
meetings (`plugins.google-meet.pool`) can sit on a big local endpoint while
Discord calls answer snappy from another.

## Setup (`aivi add @aivi/voice`)

The wizard owns the whole local stack, one confirm at a time: it creates the
runtime under `runtimes/voice/` (uv, python 3.12, the pinned mlx-audio —
nothing on the host beyond that directory), then walks the audio models
**one at a time** — transcription (~2.5 GB), speaker separation (~400 MB),
the voice (~3.5 GB), the CAM++ voiceprint (27 MB, from the sherpa-onnx
releases into `models/`). Each yes downloads now and writes its config; each
no is a feature choice with its consequence in the question — no diarizer
means nameless mixed lines, no voice means mute, no voiceprint means nobody
gets named and meeting rooms are refused. A yes whose download cannot run
(no runtime yet, network down) still writes the feature: the model arrives
lazily on first use, and the summary says so. The default voice is
`nl_female` (the clean Dutch lady; `casual_female` is the accented one).

## Engines: one process does what a host actually asks

`asr` is the whole stack in one sidecar — streaming ASR, diarization, and
batch transcription of finished utterances (the pair is `asr` + `tts`):

- stdin (JSONL, one event per line): `{"a":"<b64 s16le 16k mono>"}` mixed
  room audio; `{"a","lane"}` one named speaker's live chunk; `{"lane","end"}`
  that utterance is over (flush the tail, then `lane_end`); `{"id","a"}` a
  batch request.
- stdout (JSONL): `{"ev":"delta","text","pos","lane"?}`,
  `{"ev":"act","t","slot"}` (slot `-1` = silence, mixed audio only),
  `{"ev":"session_reset","pos","lane"?}`, `{"ev":"lane_end","lane"}`,
  `{"ev":"eof"}`, and batch answers `{"id","text"}`. `readyMarker` on stderr
  means the ASR is loaded.
- **Diarization loads at engine startup when `asr.diarModel` is configured**
  (ruled 2026-10-14: loading it on first mixed chunk made the first sentence
  of every meeting pay ~400 MB of cold load; configured-but-missing fails
  loud at start). Unset is expected and legal: mixed lines stay anonymous,
  and a call-only host never pays its ~400 MB. Named lanes carry their
  speaker already (Discord demuxes by SSRC), so each lane is a bare Voxtral
  streaming session; call-mode mixed audio (a file/mic lane) gets voice
  activity from the waveform's energy. The same engine answers batch
  requests — no second process. `stt` exists only for a separate or remote
  batch endpoint (`engine/mlx-batch.py` speaks that protocol).

**Models are config, not code**: `asr.model` / `asr.diarModel` /
`stt.model` / `tts.model` pass through the environment (the reference engine
reads `VOXTRAL_MODEL`, `DIAR_MODEL`, `VOXTRAL_TTS_MODEL`); absent means the
script's pinned default. `tts.voice` names the voice (Dutch:
`nl_male`/`nl_female`).

Processes that actually start, by what you use: file/mic lane → one
engine (ASR loads, the diarizer only in meeting mode on first mixed audio);
Discord → one engine (ASR only, live lanes); TTS → its own process, and
only once a room has a mouth and an answer to speak. Nothing idles that
nothing asks of it.

**Engine warmth is the module's job**: the streaming engine is born at the
host's first audio — from any room — and stays loaded until the module stops.
Rooms attach and detach (a Discord channel joins, a meeting ends); a rejoin
never reloads models. Audio arriving mid-load is buffered (60 s, in order)
and flushed when the engine says ready.

Reference runtime — a runtime is an **install**, so it goes under `<home>/runtimes/`
(or a global path) — never `state/`, which is generated data, and never a
scratch dir:

```
uv venv ~/.aivi/runtimes/voice --python 3.12
uv pip install --python ~/.aivi/runtimes/voice/bin/python -r <this package>/engine/requirements.txt
```

Models are fetched to the global Hugging Face cache on first use.
`engine/mlx-engine.py` is the mac/Apple-Silicon reference (mlx-audio); any
process speaking the protocol can replace it (a linux lane, a remote engine).

## Voice's own room (`room`) — the development lanes

Platform rooms come from their own modules; `room` is the lane you can run
alone:

- `{ "type": "file", "path": "meeting.wav", "paced": true, "mode": "meeting" }`
  — a recording fed at natural speed (paced off is for offline experiments
  only: it breaks the switch-lag a live listener feels). Like every room it
  declares its kind; `mode` defaults to `call`.
- `{ "type": "mic", "device": "..." }` — ffmpeg capture (avfoundation/alsa
  args built; not yet verified on real hardware).

The file lane needs audio you may keep and replay: until licensed test audio
exists, hearing tests run live (Discord), not against recordings.

```json
"voice": {
  "asr": { "command": "~/.aivi/runtimes/voice/bin/python",
              "args": ["<this package>/engine/mlx-engine.py"] },
  "identity": { "model": "/path/to/campplus.onnx" },
  "tts": { "command": "~/.aivi/runtimes/voice/bin/python",
           "args": ["<this package>/engine/mlx-tts.py"], "voice": "nl_female" },
  "wake": { "phrases": ["hey assistant", "hello assistant"] },
  "pool": "voice-local"
}
```

Which agent answers is the **room opener's** word, not the voice block's
(ruled 2026-10-13): `channel-discord.voice.agent` overrides the module's own
`agent`, and any module opening a room can name one — a room that says
nothing speaks as `assistant`. `directory` says where those agents are
defined, and `model` pins room sessions to their own model — absent means
the agent's.

The home ships a **`voice-assistant`** agent built for rooms: one wildcard
denies every permission, and tools are opened back one at a time — today
that is Code Mode and `aivi_voice_transcript`, nothing else (the file shows
how to opt in further). Name it in `channel-discord.voice.agent` to have a
room answer fast and stay in its lane; its prompt keeps answers short and
speakable, because they are about to be spoken.

## Rooms opened by other modules (the contract)

`services.voice.room({ id, label, streaming, mode, agent })` returns a
handle — the opener declares what the room IS (`mode`, default call) and who
it speaks as (`agent`, default the opener's own or `assistant`):

- `feed(pcm)` — mixed s16le 16 kHz chunks, the anonymous kind. Voice streams
  ASR, identifies, scans the wake phrase, appends lines. Diarizes only in
  meeting mode; call mode reads voice activity off the waveform.
- `lane({ speaker, user, person, channel })` — one named speaker's LIVE
  utterance: `push(pcm)` feeds their platform-demuxed audio while they are
  still speaking (a bare Voxtral session of the shared engine — no diarizer,
  the lane IS the speaker), words come back as they are heard, and the first
  recognized word from a linked person is the barge-in. `end()` (the
  platform's own silence rule) flushes the tail and commits the line with
  what streamed — or batch-transcribes the buffered audio if no live lane
  ever came up; resolves with the text or `null` (loudly logged). `abort()`
  closes a cough unheard: no line.
- `heard({ speaker, user, channel, person, pcm })` — a finished utterance the
  platform already segmented **and named** (live platforms use `lane`
  instead): batch-transcribed (in the room's own engine when one is running —
  one engine per host, not one per job), appended under that name; resolves
  with the text or `null` when it was lost (loudly logged). `person: true`
  says the speaker is a **linked person** — the only kind allowed to
  interrupt a live answer (barge-in); a stranger's words are heard but never
  silence aivi.
- `mouth(play, stop?)` — be the room's speaker: called with a wav whenever
  aivi's answer should be spoken there — once per audio chunk, in order (a
  sentence spoken with `tts.stream` lands as several chunks; each is a
  complete playable wav). `stop` (optional) silences the mouth NOW —
  barge-in calls it: the playing chunk stops mid-sentence and nothing new
  starts. Discord passes its player stop; a page lane that plays through
  `onEvent` needs none. Returns the unregister.
- `bargeIn()` — stop talking and listen: call rooms silence the playing
  chunk and drop chunks and sentences queued or synthesizing; meeting rooms
  are polite and do nothing. Reached on recognized WORDS, never a bare
  speaking start: the first recognized delta of a linked person's live lane
  interrupts while they still speak, and `heard`/`lane.end` words do the
  same when the only lane available is the batch one.
- `onEvent(listener)` — watch fusion events (`engine`, `delta`, `line`,
  `session_reset`) for live captioning. New listeners immediately receive the
  current engine state (`idle`/`loading`/`ready`/`failed`): a page that joins
  a warm host says ready, not spinner.
- `stop()`.

Discord's filling lives in `@aivi/channel-discord` (`voice: { guild,
channels, silenceMs }` there): the bot joins a configured channel when the
first linked person enters and leaves when the last one is gone — presence
drives the *meeting* (connection, room, transcript), while the models stay
warm in `@aivi/voice` for the next one. An empty channel holds no
connection; a rejoin costs no reload. Discord demuxes its speakers by SSRC
and delivers a LIVE stream per user (a linked account speaks under its aivi
person name): every packet is decoded and pushed into a `lane()` while the
person is still talking, words come back as they are heard, and the
platform's own silence rule (`silenceMs`, AfterSilence) closes the
utterance — nothing is buffered into a "finished clip" first. See its
README for the DAVE reality check.

## Reading transcripts back (`aivi_voice_transcript`)

Meetings only: a call room keeps no record, so it contributes no groups —
its conversation lives in its OpenCode session.

- `{ "action": "transcripts" }` — the groups (one per room per serve; a
  Discord meeting is a room of its own, so its group ends when the last
  person leaves), newest first, with line counts.
- `{ "action": "lines", "transcript": 3, "last": 50 }` — the last lines of a
  group; `before: <smallest id seen>` pages older lines; `speaker` filters.
- `{ "action": "speakers" }` — the known voices and their sample counts.

## Models and measured footprint (models excluded from runtime sizes)

| Model | Source | Size | License | Job |
| --- | --- | --- | --- | --- |
| Voxtral Mini 4B Realtime 4-bit | mlx-community/Voxtral-Mini-4B-Realtime-2602-4bit | ~2.5 GB | Apache-2.0 | streaming ASR + batch (`asr.model`) |
| Nemotron-3-Diarization | mlx-community/Nemotron-3-Diarization | ~400 MB | OpenMDW-1.1 | who-is-active, ≤8 voices, 0.32 s live buffer (`ultra_low`), lazy (`asr.diarModel`) |
| CAM++ sv zh_en 16k | sherpa speaker models (3D-Speaker) | 27 MB | Apache-2.0 | voice identity (`identity.model`) |
| Voxtral 4B TTS 6-bit | mlx-community/Voxtral-4B-TTS-2603-mlx-6bit | ~3.5 GB (4B params, 6-bit) | CC-BY-NC-4.0 (Mistral community license, non-commercial) | the voice aivi speaks (`tts.model`, optional) |

Measured on an M-series Mac against a real 4-speaker meeting (10 min):
engine RSS 4.7 GB (both models, one process, wired limit 8 GB); speaker
switch detected median 0.82 s / p95 1.49 s; 4/4 speakers correctly separated
with zero enrollment; identities kept across a second listen 99.3% of
seconds. Streaming diarization output every ~300 ms; text deltas ~0.5 s
behind the audio. Runtime npm deps: `sherpa-onnx-node` (33 MB, in-process —
identity, no server) plus the engine runtime above (the runtime is the
engine's, not the module's).

## Gaps, stated plainly

- **Person linking (streaming rooms only)**: Discord's linked accounts
  already speak under their aivi person names. Voiceprint labels (`tN`,
  renamed) are not yet bound to aivi people; transcripts carry the voice
  label until that seam exists.
- **No access control**: whoever is heard is heard. Channels gate by link
  codes; a microphone in a room cannot, and none is pretended — room
  sessions run with `onPermission: reject` so a stranger's speech can at
  least never grant a permission.
- **Mic capture** builds platform ffmpeg args but has not been verified on
  real hardware.
- **Warm, not babysat**: the engine loads on the first audio and stays
  loaded until the module stops; an engine that dies mid-meeting logs, says
  `failed` to every attached room, and the next audio loads a fresh one
  (the supervisor decides anything beyond that).
- **Mac-first lane**: the reference engine is MLX. The protocols are the
  seam for linux engines (vLLM/CUDA or sherpa); none is shipped yet.
- **Live lanes untested**: offline tests cover protocols, config rules,
  storage and the capacity seam; joining a real guild and opening the chat
  page need a live token and are verified by a human's ears, not mocks.
- **TTS plays in the browser room and in Discord**: the browser page speaks
  the wav directly; Discord plays it through the audio lane in
  `@aivi/channel-discord` (wav → 48 kHz stereo → 20 ms opus → the same
  DAVE-sealed connection). The virtual webcam (a face) is TBD.
- **Browser room is one shared transcript**: whoever opens the page feeds
  the same room. Per-page rooms arrive with real meeting plugins.
- **Grant→persist window**: a crash in the milliseconds between a dispatcher
  grant and its persist can hide one orphan lease; the persisted-id release
  at startup catches every other case.

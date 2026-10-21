# Would `@aivi/google-meet` fit the voice contract? (research, 2026-10-13)

Question from the operator: a meet plugin should use voice exactly like Discord
does — no direct link to the voice package, everything through the shared
interface in `@aivi/plugin`. Discord has none today (it opens
`services.voice.room({ id, label })`). Does that contract hold up for a real
Google Meet adapter? Research only; nothing built.

## How a bot can actually be in a Meet — two routes, and they land on the contract's two input methods

1. **Presence (headless browser + WebRTC).** Meet has no public bot/voice API.
   The community path is a browser that joins the call URL and handles the
   WebRTC peer directly — and this can **lean on the existing browser plugin**
   (operator note 2026-10-13): `@aivi/browser` already gives aivi a real
   browser it can log into and extend, which is exactly the login-wall
   problem Meet presence hits. Subscribe the mixed remote audio track,
   publish a local mic track fed from our TTS wavs. The remote audio is ONE
   mixed stream (Meet's SFU mixes audio; there is no per-speaker demux like
   Discord's SSRCs). → This route pushes mixed PCM: **`room.feed()`**, exactly
   the path the fusion, diarizer, identity and wake machinery already serve.
2. **Workspace APIs (no audio at all).** Google exposes Meet transcription
   (captions) and recordings through Workspace APIs: live caption events
   arrive as text with the **signed-in identity's real name**, and the
   Recording API produces a stored file afterwards. Speaking into the call is
   still presence (route 1) — there is no API to inject audio. → Caption
   events map to **`room.heard()`** per utterance: a platform that already
   segmented and named the speech. Google's ASR words instead of ours, names
   instead of voiceprints.

Both real integrations land on methods the contract already has. That is the
headline: the seam was drawn around the right shapes ("a platform that names
its speakers says so per utterance; a room with mixed audio pushes raw PCM").

## Contract, method by method, for a presence-based Meet adapter

| Method | Meet (presence) | Verdict |
| --- | --- | --- |
| `feed(pcm)` | decode mixed opus → resample 48k→16k s16le → feed; the adapter's job ends there | holds; diarization + identity + wake then run exactly as designed |
| `lane(init)` | impossible — no per-speaker streams exist to open | **strain**: the interface makes `lane` non-optional on `VoiceRoom` |
| `heard(utt)` | route 2 fills it; route 1 ignores it | **strain**: also non-optional |
| `mouth(play, stop, flush)` | play = publish opus frames; the play promise settles when the sender buffer drains (duration-tracked, like PacketBand); `stop` clears the buffer NOW | holds — and the "never settle at enqueue" honesty rule is exactly what WebRTC senders need too |
| `bargeIn()` | room-side semantics; adapter just obeys stop | holds |
| `onEvent` | captions/state (the face) | holds |
| `VoiceNotLoaded` | honest absence | holds |

## The three real strains found (all feed back into plan item 3)

1. **Room kind is not in the contract.** `RoomOptions` carries `streaming`
   (does this room push mixed audio) but not `call`/`meeting` — today that is
   the global `voice.mode`, which breaks the moment a call room and a meeting
   room coexist. Ruled 2026-10-13: `mode` becomes a field of `RoomOptions`,
   **optional, defaulting to `call`** — the plain voice system for a normal
   session is the common case; a module that wants meeting rooms declares it.
   Meet proves the coexistence case: the same platform can serve both kinds.
2. **Capability methods are mandatory.** `lane()` and `heard()` are required
   on `VoiceRoom`. Discord never calls `heard`; Meet (presence) can never
   provide `lane`. The type should let a room offer what its platform can
   (optional methods, or the adapter throws a typed "this platform cannot"),
   otherwise a Meet adapter has to fake methods it cannot honor.
3. **Identity ↔ name binding has no home in the contract.** Meet (presence)
   shows real names on participant tiles (DOM), while voice's identity mints
   `t1/t2` from voiceprints. Nothing in the contract lets an adapter say
   "this voiceprint IS this person" yet. Ruled 2026-10-13: **it belongs in
   voice**, regardless of which embedder tech wins the bake-off, and it is
   **completely optional** — a platform that hands out names (Discord) never
   touches it; one that shows names beside mixed audio (Meet presence) can
   enroll them. The enrollment mechanics (how many samples, threshold) ride
   with the identity-model ruling turn.

## Supporting facts

- The engine already does diarization/identity only for mixed audio — Meet
  presence is its natural customer; keeping that stack (ruled 2026-10-13) is
  what makes route 1 small.
- TTS into a WebRTC sender wants the same honesty PacketBand gives Discord
  (one continuous stream, settle-when-done-with); the pattern transfers, the
  codec plumbing does not (opus frames vs RTP opus — adapter-local either way).
- Capacity: a Meet room loads the diarizer on mixed audio — item 10's
  `voice-asr`/`voice-tts` pools gate it like everything else.

## Verdict

The glue holds where it matters (mixed input, honest mouth, barge, events) and
shows exactly three cracks — room kind in the types, optional capability
methods, and an identity-binding story. None is Discord-shaped; all three are
platform-neutral vocabulary, which is the sign the seam is in the right place.
Item 3 (rooms-as-plugin-types) should carry cracks 1 and 2; the identity
bake-off turn carries crack 3.

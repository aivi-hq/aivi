# @aivi/google-meet

aivi in a Google Meet, wearing the aivi face, with its ears open and its own
voice. No virtual camera, no OBS, no account: the meeting page's own camera
**is** the face canvas and its own microphone **is** aivi's voice, installed
before the page's scripts run — the route proven in a real meeting on
2026-10-13 (the operator's phone showed the face across the house), and the
audio both ways proven in the lab the same day.

## Use

```
aivi meet join https://meet.google.com/xxx-xxxx-xxx
aivi meet status
aivi meet leave
```

`join` asks **serve** to join: it files a one-off `meet.join` job, pokes the
host, and follows the run. Serve dismisses Meet's dialogs, kills the real
mic, types aivi's name at the waiting room, and waits for the host to
admit — one bounded wait, said once, not a poll. Once in the call the
meeting **keeps running in serve** (like a Discord connection outlives its
turns); the terminal only reports. `leave` hangs up.

In the call, aivi is in the room for real:

- **Heard**: whatever the meeting plays out loud is tapped inside the page,
  resampled to 16 kHz, and fed to a voice room — segmentation, speaker
  separation, wake and all, done by `@aivi/voice`.
- **Said**: the room's answers come back as TTS played out of the page's
  microphone; a person talking over aivi cuts the answer (barge-in) through
  the same door.
- **Seen**: the face reacts — `speaking` while an answer plays,
  `listening` when a line lands.

## Ownership

The meeting lives in serve because the voice brain (ASR, diarizer, wake,
sessions, TTS, pools) lives in serve's seat. The module claims the
operations `meet.join` {url} and `meet.leave`, holds one meeting at a time,
and hangs up when the host stops. The record is `<state>/meet.json` —
status reads it from any terminal; a dead holder's record is detected and
cleaned.

The face is not this package's — it belongs to core (`aivi face install`,
edit `<home>/face/index.html`, `npx serve` it to preview), together with
the media shim: core answers every page's camera ask with the face and
every mic ask with aivi's voice. The real devices stay covered; the operator's
room is never broadcast. This package owns Meet's buttons only.

## Config

The block `plugins.google-meet` is all defaults:

- `name` — typed at the waiting room while the host decides.
- `joinTimeoutMs` — how long the pre-join screens get.
- `askTimeoutMs` — the host's admission window.
- `mode` — `call` (closed speech prompts aivi, barge-in lives) or
  `meeting` (lines append quietly until the wake phrase).
- `agent` — the OpenCode agent the room's sessions run as.
- `headless` — default `true`: no window. `false` opens a real Chrome
  window you can watch (the debug look; also the escape hatch if a
  platform's page ever flags the headless browser again).

The meeting is **silent in the room**: the page's own speakers are muted
(aivi taps the audio before the volume control), so nobody's room becomes
the meeting's loudspeaker. `aivi meet join` then holds the call in serve;
`status` reads the record, `leave` hangs up.

## Honest edges

- Guest route only: a Meet that demands a Google sign-in is refused by
  name. Instant meetings and guest links work.
- The in-page tap is proven in the lab (element route and AudioContext
  destination route, energy measured); a real Meet's audio graph has had
  one real-meeting pass for the face — the ears' first real meeting is
  still owed its operator's verdict.
- The suite launches no browser (ruled 2026-10-13): tests cover the logic;
  the lab and real meetings are the browser evidence.

## Setup

`aivi add @aivi/google-meet` puts it in the plugin list and runs a short
wizard: it writes the block (optional — defaults answer everything) after
asking the one question that matters to the eye, whether meetings open a
visible Chrome window or run headless. It needs `@aivi/voice` for the seat
and a Google Chrome installed (or `AIVI_CHROME_PATH` set); the wizard says
plainly if voice is not configured yet. Joining needs no secret: a guest
carries nothing. The meeting lives in `aivi serve` — with it running:
`aivi meet join <url>`.

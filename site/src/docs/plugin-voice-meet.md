---
title: Voice and Meet
description: Optional speech in calls, and aivi in a Google Meet.
order: 12
group: Plugins
---

Voice is two optional pieces. `@aivi/voice` is the hearing and speech capability. `@aivi/google-meet` puts aivi in a Meet as the face on camera.

```sh
aivi add @aivi/voice
aivi add @aivi/google-meet
```

Discord voice uses the same voice capability. A room module opens a room, and the voice package supplies speaker identity, streaming speech, interruption and text to speech.

## Calls and meetings

A room declares its mode:

| Mode | Behavior |
| --- | --- |
| `call` | The conversation is the record. Speech prompts aivi, and a linked person can interrupt a spoken answer with a real word. |
| `meeting` | Every line is kept in a transcript. aivi waits for its wake phrase before it answers, and answers play to the end. |

A meeting transcript is stored in SQLite. The `aivi_voice_transcript` tool reads it back, which is how a later question can be answered from what was said.

## Google Meet

```sh
aivi meet join https://meet.google.com/xxx-xxxx-xxx
aivi meet status
aivi meet leave
```

`join` files a one-off `meet.join` job with the running host. aivi waits at the guest screen, joins when admitted, and stays in the meeting until `leave` or until the host stops. The meeting runs in the host, not in the terminal that started it.

In the call, the Meet page's own camera shows the aivi face, and its own microphone carries aivi's voice. The page's speakers are muted, so the room does not become a loudspeaker. The face reacts while aivi speaks and listens.

`plugins.google-meet` controls the name, the join and admission windows, the agent, `headless`, and the mode. `plugins.voice` carries the speech models and the room resume window.

## Honest edges

Meet's guest route works with instant meetings and guest links. A meeting that demands a Google sign-in is refused by name. The face has had a real-meeting pass. The ears' first real meeting is still owed an operator verdict.

The full pages are [Voice](https://github.com/aivi-hq/aivi/blob/main/packages/voice/README.md) and [Google Meet](https://github.com/aivi-hq/aivi/blob/main/packages/google-meet/README.md).

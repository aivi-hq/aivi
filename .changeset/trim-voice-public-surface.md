---
"@aivi/voice": minor
---

Remove three public members that nothing called: `BatchEngineRun.duration`, `HearingRoom.currentEngineState` and `VoiceTurns.busy`. A room already replays its engine state to every new `onEvent` listener, and a duration is `samples.length / 16000`.

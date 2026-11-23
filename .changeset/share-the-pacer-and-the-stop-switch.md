---
"@aivi/host": minor
---

Export `ProgressPacer` and `stopSwitch`, with their types `PacerOptions` and `StopSwitch`. `ProgressPacer` is the throttle, the render state and the one timer behind a visible progress line: a chat placeholder and a ticket's status line now share it instead of each keeping a copy. `stopSwitch` is the stop that every module running a `ChannelEngine` holds: it aborts the module's own signal and stops the engine the module builds once it is connected.

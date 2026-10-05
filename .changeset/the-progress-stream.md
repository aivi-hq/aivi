---
'@aivi/plugin': minor
'@aivi/tracker-linear': minor
'@aivi/host': patch
---

**The worker's progress stream.** While a run works, its OpenCode session
is mirrored into the agent session as **ephemeral** activities: an `action`
naming the tool being run, a `thought` for the status line. Ephemeral is
Linear's word for *replaced* — the person sees the worker's current moment,
never a trail of lines (ruled 2026-10-02: "thoughts and action types,
marked as ephemeral to prevent spamming"). The stream starts with the pair
at `ready`, pauses while a question awaits a person, resumes when the
answer lands, and falls silent before the closing. The `progress` config
(`silent`/`status`/`tools`, default `tools`) decides what it shows. The kit
Platform gains an optional `progress(conversation, line)` member —
transient by contract; platforms without a progress surface leave it
absent and their workers work in silence.

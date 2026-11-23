---
"@aivi/plugin": minor
---

Export `pollWithin`, `PollWindow` and `askAgentLane` for plugin setup flows. `pollWithin` waits for something another process writes: it looks at once, again after every pause, and ends when the read says it is done, when it throws, or when the window ends. `askAgentLane` asks what an `agent` lane adds to its kind: which OpenCode agent works it and, with a forge configured, whether that work happens on the ticket's branch.

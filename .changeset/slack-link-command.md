---
'@aivi/channel-slack': patch
---

The shared `/link` command works on Slack (`/{prefix}-link CODE`): it consumes the one-time code from `aivi link` and binds the Slack account to the person, with the host-authored confirmation or refusal. The manifest in docs/slack.md gains the command, kept current by its test.

---
'@aivi/channel-discord': patch
---

The shared `/link` command works on Discord: it consumes the one-time code from `aivi link` and binds the Discord account to the person, with the host-authored confirmation or refusal. The module describes its redemption in `linkHint` so `aivi link` shows it.

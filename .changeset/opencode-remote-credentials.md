---
'@aivi/opencode': patch
---

The plugin falls back to the client config (`~/.config/aivi.json`) for the host url and the person bearer when its options say nothing, so `aivi setup` can install it as a plain string and client sessions associate with the person without env setup. On a server home the cached bearer is ignored: host-originated sessions associate by their own identity, never the operator's.

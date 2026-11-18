---
'@aivi/browser': minor
'@aivi/channel-discord': minor
'@aivi/channel-slack': minor
'@aivi/chrome': minor
'@aivi/cli': minor
'@aivi/core': minor
'@aivi/forge-github': minor
'@aivi/github': minor
'@aivi/host': minor
'@aivi/knowledge': minor
'@aivi/opencode': minor
'@aivi/plugin': minor
'@aivi/tracker-github': minor
'@aivi/tracker-linear': minor
---

The Node floor moves from 26.1.0 to 26.12.0: `engines.node` is now `>=26.12.0 <27`. `aivi update` reads the target's `engines` and provisions a managed Node when the machine's own is below it.

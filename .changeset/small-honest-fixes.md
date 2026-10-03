---
'@aivi/core': patch
'@aivi/cli': patch
'@aivi/host': patch
'@aivi/plugin': patch
'@aivi/opencode': patch
'@aivi/browser': patch
'@aivi/channel-discord': patch
'@aivi/channel-slack': patch
'@aivi/forge-github': patch
'@aivi/tracker-linear': patch
---

The small honest fixes from the code sweep. `ToolError` and
`ConfigurationError` are defined in the kit's module contract and
re-exported by the host, so plugin packages no longer import them from
`@aivi/host`. Every durable write lands whole or not at all — temp next
door, rename over; `.env`'s temp is created 0600 so a secret never sits
world-readable. `manualSources` tells an absent install record from a
corrupt one, naming the file like the host's registry reader already did.
An interjection neither steered nor queued is said in the conversation,
never a log line alone. A lane that lost its worker while a run waited
releases its slot and says `lane-workless` instead of writing an
`undefined` agent into a run row. The redirect hook reads `git remote`
by the sub-verb: the name list and `get-url` cross nothing and pass;
rewriting them stays refused. `aivi_config read` of a corrupt
config.json names itself instead of a shapeless "Internal error". The
Linear MCP proxy caps its body at 1 MiB like every other reader. The
dreaming transcript says a *channel* names its speaker — the prefix is
the shared engine's, not one platform's. The dead `--lane`/`--unlane`
flag readers are gone; the wizard asks per lane now.

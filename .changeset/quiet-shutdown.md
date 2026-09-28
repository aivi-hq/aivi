---
'@aivi/host': patch
'@aivi/channel-slack': patch
'@aivi/cli': patch
---

Shutdown says so: `aivi serve` logs `host.stopping` the moment it takes a stop signal, so the drain that follows no longer reads as a hung terminal, and the Slack SDK's pong warnings are dropped once the module closes the socket on purpose (its errors still travel). The seeded assistant and dreamer agents now deny the `question` tool — no channel client can answer one yet, and a question in an unattended turn only hangs.

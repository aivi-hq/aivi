---
'@aivi/core': major
'@aivi/host': major
'@aivi/plugin': major
'@aivi/cli': major
'@aivi/channel-discord': major
'@aivi/channel-slack': major
'@aivi/tracker-linear': major
'@aivi/tracker-github': major
---

**One pool set: `dispatcher.pools` is now the only capacity system.**
`scheduler.resources`, `scheduler.maxConcurrent` and the per-module
`resource` names are retired — jobs, channel turns, ticket work and voice
rooms all draw the same named pools, and `scheduler` keeps job *timing*
defaults only. Plugin blocks rename `resource` to `pool`; a block that
names a pool must name one that exists, and while no pools are configured
capacity is unmoderated and any name is idle. `poolCapacities(dispatcher)`
is the one reading point the scheduler and both channel engines claim
through. `AiviServices` grows two seats: `voice` (the voice plugin's
adapter, empty until `@aivi/voice` provides one) and `dispatcher` (ticket
capacity, now visible to modules).

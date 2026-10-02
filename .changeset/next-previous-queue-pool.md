---
'@aivi/core': minor
'@aivi/host': minor
'@aivi/tracker-linear': minor
---

**The lane vocabulary of the dispatcher era, named before it is wired.**
The lane overrides are `next` and `previous` (the follower-era `complete`
and `return` die with this rename), and a lane may carry `queue: true` —
the workflow's one queue lane, fresh work waiting for the worker lane it
feeds — and `pool`, the dispatcher pool the lane's work will draw capacity
from. Both are **inert** until the dispatcher is built; naming them is
already load-validated: a second queue lane, a queue lane naming an agent,
or a queue whose next lane (by order or by `next`) works nothing fails at
config load, loudly. `writeProjectLinear` takes the written lane shape
(`ProjectLaneInput`), which is what a wizard hands before core's defaults
land.

---
'@aivi/tracker-linear': minor
---

**The wizard asks about the queue once.** After every lane has been
configured comes a single question — which lane waits with work while the
working lanes are full — with `-- None --` among the options, never a
per-lane ask. The options are only the lanes that could legally hold the
queue (one whose next works nobody would write a config that refuses to
load), and picking a lane that just chose an agent gives that agent up
out loud: the queue answer is the later word.

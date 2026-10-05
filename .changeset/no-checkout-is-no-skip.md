---
'@aivi/host': patch
---

A project with no repository is a supported state, so `projects-sync` no
longer reports it as a skip. It used to visit every project and answer
`skipped: not a git checkout`, which the hourly job logged at `warn` and
printed in its report — a supported configuration, announced as an anomaly
once an hour. `syncProjects` now looks for `source/.git` before visiting and
moves on silently beside the removed projects it already passed over, so a
no-repo project appears in neither the log nor the report. A skip is what a
person would act on: the four reasons that need a decision — local changes,
a detached HEAD, no upstream, a diverged branch — are reported as they were.

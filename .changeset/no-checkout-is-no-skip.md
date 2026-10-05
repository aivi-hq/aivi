---
'@aivi/core': patch
'@aivi/host': patch
---

A project with no repository is a supported state, and the config now says
so. `projects.<id>.sync` (default `true`) keeps the hourly `projects-sync`
job away from a project it has no business with; `aivi projects add` writes
`sync: false` when no forge cloned a checkout. The job used to visit every
project and answer `skipped: not a git checkout`, which it logged at `warn`
and printed in its report — a supported configuration announced as an
anomaly once an hour. A skip is what a person would act on: the four reasons
that need a decision — local changes, a detached HEAD, no upstream, a
diverged branch — are reported as they were.

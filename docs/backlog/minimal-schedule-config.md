# A schedule config should say frequency, nothing else

Status: **largely landed 2026-09-18** with the config shrink
(`feat(config)!`): `scheduler.timezone` is the host-wide default and a
per-job timezone wins over it; hand-written jobs may name their operation as
a bare string (`"task": "system.check"`); `cron` stayed the one voice; the
per-job `timezone`/`resource` escape hatches survived; seeded definitions and
ids were left alone ([task-registry](task-registry.md)). What is left:

- Operator tuning of *module*-seeded schedules: `HostModule.jobs` still
  returns full `Job` definitions and no `scheduler.<name>` surface exists.
  Shape it with `linear.sweep` as the first real consumer
  ([linear-worktree-lifecycle](linear-worktree-lifecycle.md)).
- The id-semantics questions (what an id is for, derived ids, collisions) went
  to [job-identity](job-identity.md).


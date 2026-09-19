# Worktree lifecycle per lane

Status: **planned (v3), partly landed.** The lane shape and the checkout
environment landed with the single-app rework (2026-09-19,
[plans/linear.md](../plans/linear.md) step 11): lanes are
`agent | null | { agent, worktree: false }`, and a `worktree: false` lane runs
its agent in the project's clean checkout with the agent file's own `edit`
deny as the only enforcement. `client.ts` gained `createComment`. What remains
of this page is the **sweep**: issue-keyed worktrees, terminal-lane removal
and staging, `linear.sweep` as a daily system job, `linear.reportChannels`.
(The issue-keyed worktree — `worktrees/PEC-123` shared across agents — is a
behaviour change from today's per-session keying; if it lands, it lands with
the sweep.)

## Rules (agreed with the owner)

- A lane says whether its work needs a worktree: lane value
  `app | null | { app, worktree? = true }`. Read-only lanes run their agent
  in the project's clean checkout; **aivi never touches agent permissions** —
  the agent file's own permissions are the only enforcement.
- The worktree belongs to the **issue**, not one delegation:
  `worktrees/PEC-123`, shared by dev/review/qa so agents inherit each other's
  state (the point). An issue moving teams mid-work loses its worktree;
  accepted.
- When the issue reaches a terminal lane (completed/canceled): clean **and**
  nothing ahead of the remote default → remove dir + branch immediately.
  Otherwise KEEP: stage in SQLite (a table, not marker files), comment on the
  Linear issue, post to configured channels, warn-log. After
  `linear.worktreeRetentionDays` (default 7) the sweep force-removes and
  notes it. Stop / HITL / lane-change keep everything: stop ≠ done.
- The sweep is its own operation `linear.sweep`, claimed by the linear
  module and seeded as a **daily system job** through `HostModule.jobs`.
  (Plan v3 had it ride the hourly `projects.sync`; the owner chose its own
  invocation so its frequency is configurable like any system job and it
  shows up uniformly in the future desktop job list. No new timers either
  way.)

## Build pieces (each was scoped small)

1. config: lane objects + per-lane merge, `worktreeRetentionDays`,
   `linear.reportChannels` (`[{module, channel}]`).
2. `DeliveryContext` widening so a module can post a notice that has no job
   run behind it: today every report the channels deliver comes from a run
   and the adapters read `context.run` to name their thread and pick a
   session. Make `run` optional, add `title?` for notices; re-entry always
   keeps its run (`ReentryContext`). **Landed with the task registry
   (2026-09-18); its live gate (a run-less thread actually posted to
   Discord) has not run yet.**
3. linear store table for staged worktrees (issue, project, path, branch,
   staged_at, reason) queried by the sweep; it never walks repos.
4. `worktree.ts`: rekey to issue identifier; `removeWorktree` (remove +
   branch -D + prune), `worktreeIsClean`, unmerged-commits check.
5. `client.ts`: `createComment` for the staged-for-removal notice.
6. `module.ts`: `worktree: false` binds the conversation to the checkout and
   skips git; the listener's terminal pass; the `linear.sweep` handler.
7. CLI `linear sweep` so cleanup is reachable without waiting for cron.
8. Tests at the real boundaries + the docs that own each fact (AGENTS.md
   bullet, configuration.md, linear.md, CONTEXT.md, plans/linear.md step,
   `npm run schema`).

## Open live gates from the lane work this builds on

- Interactive `aivi projects create` against a real repo, and a real
  `--lane`/`--unlane` write (from `59b33fd`).
- Vessel repo (tiny, disposable) as the first dogfood; example's config gains
  a triage app + lane when this lands.

# Remaining coverage and quality work

The goal is the output of `npm run agentic:verify`: 100% production
coverage and zero feedback from every tool. This note holds only what
serves that goal. Everything else is a ticket in `docs/backlog/` (see
"Off-goal findings").

## Resumption baseline

The latest full `npm run agentic:verify` (2026-11-18) exited 0: 1,203
tests passed. Production coverage is 88.88% lines, 88.92% branches and
83.6% functions. Fallow still reports 2 check findings, 6 duplicate groups,
15 health findings (2 critical, 2 high, 11 moderate), 7 refactoring targets
and 2 unconfigured-policy diagnostics. This run printed no Fallow warning;
the run before it printed the graph-cache warning ("decoded but not
reused"), so look for it again. This is not zero tool feedback.

The full output is `coverage/agentic-verify-capacity.log`; exact coverage
is `coverage/coverage-final.json`. Both are generated/ignored artifacts:
regenerate them if absent or stale. No checks or suppressions were
weakened.

At 100% lines, branches and functions, with no Fallow finding:
`packages/voice`, and in `packages/host/src/`: `scheduler.ts`,
`channel/engine.ts` and `dispatcher/leases.ts`. `dispatcher/dispatcher.ts`
is at 100% lines and functions with one branch open (see "Next batch").

## How the operator wants to work

- The goal comes first. Stay on it. Behavior work that does not serve it
  becomes a ticket, not a batch.
- Short messages, lists, only what needs the operator's attention. Use
  plain words: no labels or section names from this note. The operator
  does not read it.
- Say what the next batch is and wait for the go.
- No question tool. Put questions in the message and stop.
- Post one short status line per step.
- Anything that gets to a clean `agentic:verify` has the operator's
  blessing (2026-11-18), as long as it is not a workaround, a hack, or a
  disabled or ignored rule.
- Anything that seems wrong or requires a fix goes in a ticket; move on.
  Do not stop to ask about it, and do not fix it in passing. When such a
  fix blocks coverage, leave the lines open and point this note at the
  ticket.
- The operator's word decides. Docs and recorded decisions are not law;
  raise a disagreement, do not treat a doc as a veto.
- Never pin a suspected bug in a test to gain coverage.
- No live checks. Do not launch real CLIs, services, browsers, decoders or
  model processes, in tests or outside them. The operator owns live
  checks. `npm run agentic:verify` is allowed as it is: its smoke step
  starts the built aivi server and CLI in a temp home.
- HARD RULE: do not reach the goal by weakening the tools. No disabled or
  loosened Fallow rule, no raised threshold, no suppression comment, no
  new coverage exclusion, no lint rule turned off, and no new dependency,
  unless the operator approved that exact change first. A finding that
  cannot be fixed honestly stays reported.

## Off-goal findings

`docs/backlog/` is the tracker for now: one Markdown file per ticket.

- It is untracked on purpose. Never stage it. Do not touch `.gitignore`
  for it.
- A finding that does not help reach 100% coverage or zero Fallow
  feedback goes there: behavior rulings, design questions, docs defects,
  live checks. What serves the goal stays in this note.
- Write a ticket for a cold reader: the operator's ruling in their words,
  what the code does today, the facts with their sources, what is open.
- Do not reuse the file names that commit `059eff9` removed from that
  directory; older docs still link to them.

## Next batch

Not agreed yet. Say what it is and wait for the go.

The largest gap that needs no decision first is
`packages/tracker-github/src/module.ts`: 270 uncovered lines and 21
functions that no test calls. It has one Fallow complexity finding
(`onIssue`). `tracker.ts` in the same package has another (`dispatch`) and
the repeated status-comment reads.

Left open by the capacity-path batch (dispatcher, scheduler, channel
engine; 2026-11-18):

- `packages/host/src/dispatcher/dispatcher.ts`, `#verdict`: the boot pass
  ends a lease whose pool is gone. Not tested on purpose: the behavior is
  in question. Ticket: `docs/backlog/boot-ends-lease-whose-pool-is-gone.md`.
- `packages/host/src/orchestrator/orchestrator.ts`, lines 188-193 (the
  dispatcher callback in the constructor): they need the fix in
  `docs/backlog/orchestrator-release-rejection-is-unhandled.md` before a
  test can reach them.

## Where the uncovered lines are

From `coverage/coverage-final.json` at the baseline: 4,608 of 41,453
lines are uncovered. The largest files, under `packages/`:

| Uncovered lines | File |
| ---: | --- |
| 647 | `channel-discord/src/module.ts` |
| 270 | `tracker-github/src/module.ts` |
| 233 | `chrome/src/tab.ts` |
| 180 | `google-meet/src/cli.ts` |
| 180 | `google-meet/src/meeting.ts` |
| 171 | `google-meet/src/module.ts` |
| 150 | `chrome/src/chrome.ts` |
| 143 | `tracker-linear/src/client.ts` |
| 139 | `host/src/cli/project-setup.ts` |
| 138 | `chrome/src/connection.ts` |
| 126 | `channel-slack/src/connection.ts` |
| 116 | `host/src/orchestrator/orchestrator.ts` (and 105 branches) |
| 113 | `forge-github/src/setup-project.ts` |
| 111 | `tracker-linear/src/module.ts` |
| 105 | `channel-discord/src/voice.ts` |
| 96 | `knowledge/src/index.ts` |
| 91 | `cli/src/service.ts` |
| 90 | `core/src/face-tab.ts` |
| 69 | `host/src/server.ts` |
| 60 | `host/src/application.ts` |

Notes for these:

- `channel-discord/src/module.ts` constructs `new Client(...)` itself: it
  has no seam like Slack's `SlackConnection`. Ask before adding one.
- `tracker-github/src/module.ts`: fake services and platform adapters for
  lifecycle tests. 21 functions are never called by a test: the delivery
  (`send`, `edit`, `notice`, …), `question`, `plan`, the assistant start
  and stop, `onBrought`, `onStopSignal`, `followUp`.
- `chrome` and `google-meet`: use fake CDP, tabs and processes; keep live
  browser/platform gates separate.
- `tracker-linear/src/client.ts`, `forge-github/src/setup-project.ts` and
  `host/src/cli/project-setup.ts`: further API and prompt-flow units.

## Test approach the operator wants

- Test production behavior. Do not add tests of tests or coverage configuration.
- Do not pin a suspected bug to gain coverage. Leave the branch open and
  write a ticket for it.
- Direct unit calls with fake I/O. Existing integration tests are not the
  convention to copy; do not start an application to test one function.
- Use deferred promises to observe the boundary under test. Advance mock
  time only after the operation is waiting. Avoid sleeps, polling helpers
  and guessed microtask-flush counts.
- No test helper that is not needed.
- `packages/plugin/test/setup-fixture.ts` provides scripted prompts
  (`confirm` included) and recorded writers;
  `packages/tracker-linear/test/setup-fixture.ts` shows an OAuth listener
  faked without binding a socket.
- `packages/cli/test/setup-fixture.ts` records setup I/O and observes the
  actual timeout scheduling before advancing mock time. The identity fake
  writes the bearer and URL, like the installed server; only whoami adds
  the verified display cache.
- Voice fixtures (`packages/voice/test/*-fixture.ts`) cover every unit:
  process-shaped children, a recorded turn host, a room, the speech lane.
  `boundary.ts` is an awaitable call log: `next()` resolves with the next
  unread call, made or still to come.
- Voice gotchas:
  - One `voiceProcesses(t)` per test. Two nest the `spawn` mock and
    restore it in the wrong order; use subtests.
  - `module-fixture.ts` stubs `start`, `stop` and `alive` of the speech
    endpoints. Restore all three to run the real clients over fake
    processes.
  - A fake `runTurn` must honor its abort signal, or `turns.stop()` in
    teardown waits forever.
  - Batch and voice clients arm their timeout before they write the
    request: `await child.nextInput()` is the boundary, then tick.
  - A wrong assertion on a promise that never settles costs the whole test
    timeout. Race it against the boundary that would prove the bug.
  - SQLite rows have no prototype: map them before `deepEqual`.
  - For identity/null checks on `EngineRun`, compare as a boolean: an
    assertion that prints the whole ring can render millions of samples
    and stall the test runner.
  - `drained()` in `speech-fixture.ts` is one `setImmediate` turn. Use it
    only where nothing signals the moment: a speaking window closing behind
    its last audio, or a check that nothing more happened. Where a log line
    or a fake is reached, wait on that boundary instead.
- Host fixtures in `packages/host/test/support.ts`:
  - `TestCapacity` is the dispatcher stand-in for the scheduler and the
    channel engine. It has one slot count for all pools and one queue
    place for each service. Subclass it in a test to count asks, keep the
    registered callback, or answer a release as `pending` or as a
    rejection.
  - `recorder()` is a logger that keeps its lines. `next(event)` settles
    with the first line of that event, said already or still to come.
- Host gotchas:
  - c8 counts V8 blocks. An `if` with no `else` whose body always runs
    shows no gap. A guard's `return`, the right side of `??` or `||`, a
    ternary arm and a `catch` body are blocks of their own.
  - `t.mock.timers.enable({ apis: ['setTimeout'] })` leaves `Date.now()`
    real. The dispatcher computes a clock's delay from real time, so
    `tick(idleMs)` still fires it.
  - `void this.release(…)` in the scheduler and the engine is detached:
    `drain()` does not wait for it. Wait on its log line with
    `recorder().next(…)`, or use a stand-in whose release works at once.
  - To let "another process" act in the middle of a synchronous pass, use
    the unit's own seam: `needsCapacity` for the scheduler, a `request`
    override on the stand-in for the engine.
  - A fake dispatcher may only do what the kit contract allows
    (`packages/plugin/src/dispatcher.ts`). The shipped dispatcher never
    calls back inside a scheduler pass and never refuses the scheduler;
    the tests for those paths say so.
- When mocking a built-in used through named ESM imports, call
  `syncBuiltinESMExports()` after replacing it and after restoring it.
- Check coverage in isolation, using a separate report directory so the
  full report remains useful. For example:

  ```sh
  NODE_OPTIONS=--conditions=development node_modules/.bin/c8 \
    '--include=packages/voice/src/engine.ts' --reports-dir=coverage/targeted \
    node --test --conditions=development \
      packages/voice/test/engine.test.ts
  ```

- A bug that a test exposes becomes a ticket in `docs/backlog/`. Do not
  write the test that pins it. Dead code and guards that nothing can reach
  are removed instead: verify the callers first, and give a removed public
  member its own changeset.
- No exclusion or suppression to make a score green, and none at all
  without the operator's approval (see the hard rule in "How the operator
  wants to work").

## Coverage contracts to review

These remaining fallbacks appear unreachable through their valid callers.
Review the contract before deleting them or inventing tests for them:

- `packages/core/src/log.ts`, `configureLogging`: the fallback after
  indexing `LOG_LEVELS` with a `LogLevel`.
- `packages/forge-github/src/remote.ts`, `parseRemote`: missing-capture
  fallbacks after regex matches whose captures are required.
- `packages/host/src/api/status.ts`: the missing `finishedAt` fallback for
  recent runs. `Store.recent` requires `finished_at >= ?`, excluding null.
- `packages/core/src/config.ts`, `manualSources`: the non-Error fallback
  after JSON parsing or reading a property on the parsed manifest.

## Remaining Fallow findings

Verify actual callers and public contracts before removing these:

- `PacketBand` export in `packages/channel-discord/src/voice.ts`.
- Fallow's `Chrome`/`VersionInfo` finding is a false positive on the private
  constructor. `packages/chrome/dist/chrome.d.ts` exposes only
  `private constructor()` and contains no `VersionInfo`. Triage/report the
  analyzer defect; do not publish the private type just to silence it.

Duplicate groups to revisit:

- GitHub API test fixtures repeated across `github`, `forge-github` and
  `tracker-github`.
- Probe wait machinery in `tracker-github/src/probe.ts` and
  `tracker-linear/src/setup.ts` polls, while `AGENTS.md` bans periodic
  timers. Ask the operator how to reconcile that before factoring a
  shared polling loop.
- Progress scheduling/rendering across `host/src/channel/reporter.ts` and
  the two trackers' `runprogress.ts` files.
- Repeated status-comment reads in `tracker-github/src/tracker.ts`.

Remaining complexity findings:

- CLI: `packages/cli/src/remove.ts` (`remove`).
- Core: `packages/core/src/config.ts` (`loadConfig`).
- Discord: `packages/channel-discord/src/voice.ts` (`reconcileNow`).
- Host: `channel/turns.ts` (the turn-runner callback) and
  `cli/commands/jobs.ts` (the add callback), under `packages/host/src/`;
  also `packages/host/test/dreaming.test.ts` (`respond`).
- Knowledge: `packages/knowledge/src/index.ts` (`search`, `surveySources`).
- GitHub tracker: `tracker.ts` (`dispatch`), `module.ts` (`onIssue`),
  `probe.ts` (the agent-event `read`), `setup.ts` (`setup`) and
  `setup-project.ts` (`askLanes`), under `packages/tracker-github/src/`.
- Linear tracker: `packages/tracker-linear/src/setup-project.ts` (`askLanes`).
- Meet: `packages/google-meet/src/meeting.ts` (`driveJoin`).

Fallow also recommends splitting `jobs.ts`, `reports.ts`,
`channel/{router,progress,context}.ts` under `packages/host/src/` based on
coupling and complexity density. Review whether a split helps the design;
do not split a small file just to improve a metric. Hotspot suggestions to
"add tests" to test files are not evidence of production coverage gaps.
The same rule flags any small helper that three or more files import and
that averages a branch every three lines: keep shared test helpers free of
branches instead of merging files to dilute the metric.

High-risk health work includes `driveJoin` in
`packages/google-meet/src/meeting.ts`: its CRAP score uses actual zero
coverage. By contrast, the reported CRAP for the anonymous callback in
`packages/host/src/channel/turns.ts` is estimated. Check `coverage_source`
and the Istanbul function map before adding tests for an estimated score;
c8 can omit anonymous function names. The temporary CRAP threshold and its
reason are documented in `.fallowrc.jsonc`.

## Tool feedback that still needs attention

- A zero exit from `agentic:verify` is not zero Fallow feedback. Inspect
  `check`, `dupes`, `health` and `workspace_diagnostics` separately.
- Fallow reports architecture boundaries and rule packs as unconfigured.
  The operator ruled "decide later" (2026-11-18): leave both diagnostics
  and do not disable those checks.
- `packages/host/test/events.test.ts` still uses a polling `until` helper
  and real sleeps. Replace them with observed events and controlled time
  when working on that area.
- `packages/cli/test/cli.test.ts` still has three CLI-entry subprocess cases.
  Move those to direct `run` calls with fake machine I/O when working on
  command routing; keep the package smoke gate separate.

# Remaining coverage and quality work

## Resumption baseline

The latest full `npm run agentic:verify` exited 0: 1,163 tests passed.
Production coverage is 88.63% lines, 88.18% branches and 83.45% functions.
Fallow still reports 2 check findings, 6 duplicate groups, 18 health
findings, 7 refactoring targets and 2 unconfigured-policy diagnostics. It
also printed the entry-point graph-cache invalidation warning; this is not
zero tool feedback.

The full output is `coverage/agentic-verify-voice-rulings.log`; exact
coverage is `coverage/coverage-final.json`. Both are generated/ignored
artifacts: regenerate them if absent or stale. No checks or suppressions
were weakened.

`packages/voice` is at 100% lines, branches and functions, with no Fallow
finding in the package. What is left there are the operator questions below.

## Next batch

Start with the dispatcher batch the operator ruled on: it is written out
under "Next batch: the dispatcher" in the voice section below (rules A and
B, with a hard requirement on elicitations). Read "How the operator wants
to work" there first: it holds the hard rule against weakening checks.
Wait for the operator's word before building.

After that, continue toward 100% production coverage, then zero feedback
from all tools.
Read `coverage/coverage-final.json` for exact gaps; regenerate it if absent or
stale. Keep this note as an open-work list, not a completion log.

Useful starting points:

- `packages/channel-discord/src/module.ts` and
  `packages/tracker-github/src/module.ts`: the largest remaining module
  gaps. Fake services and platform adapters for lifecycle tests. The
  Discord module constructs `new Client(...)` itself: it has no seam like
  Slack's `SlackConnection`. Ask before adding one.
- `packages/chrome/src/{tab,chrome,connection}.ts` and
  `packages/google-meet/src/{cli,meeting,module}.ts`: large gaps. Use fake
  CDP, tabs and processes; keep live browser/platform gates separate.
- `packages/tracker-linear/src/client.ts`,
  `packages/forge-github/src/setup-project.ts` and
  `packages/host/src/cli/project-setup.ts`: further API and prompt-flow units.

## Voice: operator rulings (2026-11-18) and what is still open

Every ruling the operator gave is built and committed; the commits carry
`fix(voice)` subjects and one changeset each. What follows is still open.

How the operator wants to work:

- No question tool. Put questions in the message and stop.
- Post one short status line per step.
- Ask before changing behavior, unless the intent is obvious.
- The operator's word decides. Docs and recorded decisions are not law;
  raise a disagreement, do not treat a doc as a veto.
- Never pin a suspected bug in a test to gain coverage.
- HARD RULE: do not reach the goal by weakening the tools. No disabled or
  loosened Fallow rule, no raised threshold, no suppression comment, no
  new coverage exclusion, no lint rule turned off, and no new dependency,
  unless the operator approved that exact change first. A finding that
  cannot be fixed honestly stays reported.

Built, with a point to confirm:

- Spoken clauses end at `. , ; : ! ? …` followed by a space or a line
  break. The operator confirmed: commas stay a cut.
- `engine/mlx-tts.py` now always ends a streamed sentence. It passed
  `python3 -m py_compile` only: no python test exists and the live gate
  was not run.
- `drained()` in `speech-fixture.ts` stays for five checks: a speaking
  window closing (no signal exists for it) and "nothing more happened".
  The operator forbids a helper that is not needed; these are needed.

Lease items (the operator: leases decide capacity, so nothing about them
is "harmless" by default):

- Built: voice's own note of a held lease (`voice_state` key
  `lease:<room>`) is written before the session is prepared and forgotten
  once recovery returned the lease. Capacity is counted from
  `dispatcher_leases`, never from that note; `turns-recover.test.ts` proves
  with the real host dispatcher that the slot is free after recovery.
- A graceful shutdown already ends voice's active turns: `VoiceTurns.stop`
  interrupts the session, cuts the wait and returns the slot (see
  `turns.test.ts`). Only a crash leaves a turn behind; then voice recovery
  calls `dispatcher.release`, which frees an active lease at once and does
  not stop its session. The operator ruled where that is fixed: see B.

Next batch: the dispatcher, ruled by the operator (2026-11-18). Not
started. It is host code (`packages/host/src/dispatcher/`): a new area.

A. Resuming a session after the config changed. The operator's rule, in
   their words: try recovering the lease (pool and model) for the session;
   if either fails, warn and try again with the current config; if that
   also fails, it is an error. Do not check pool and model separately,
   and do not look the model up first: just try the session, the error
   says it is gone. A recent config change is the operator's
   responsibility.
   - Today `Dispatcher.request` answers `{ refused: 'pool-gone' }` when
     the session's recorded pool is not configured, and a resumed session
     keeps the model it was created with. `LeaseStore.record` is
     `INSERT OR IGNORE`: moving a session to the configured pool needs an
     update of `dispatcher_sessions`.
   - Callers that handle `pool-gone` today: `host/src/channel/engine.ts`
     (waits and warns), `host/src/scheduler.ts` (unreachable: jobs never
     resume), `voice/src/turns.ts` (logs `turns.refused` with a hint that
     fits only `waiting`). The kit type is in
     `packages/plugin/src/dispatcher.ts`. After the change that refusal
     and its handlers are dead code.
   - An unknown configured pool already throws in `request`, and config
     load rejects an unknown `plugins.<id>.pool`.
   - To settle while building: the dispatcher grants slots but callers run
     the turns, so a model that is gone shows up as the caller's failed
     turn. Find where "try again with the current config" lives for the
     model. `packages/host/src/channel/model.ts` (`switchModel`) already
     changes a session's model.
B. Releasing a lease means making sure no turn is still running on its
   session. That is the dispatcher's job: it guards capacity. Not voice's.
   Today `Dispatcher.release` stops nothing unless the lease is already
   `expiring`; `expire` has the stop-and-confirm path.
   - "Stopped" is about a turn, not about the session. The operator: an
     open elicitation is not a running session; there is no turn and no
     LLM is busy. So the elicitation keep-alive in `docs/orchestrator.md`
     ("a release, not an expiry: nobody is killed, the session keeps its
     open form") does not conflict: there is nothing to stop.
   - HARD REQUIREMENT from the operator: a running turn may be ended; an
     open elicitation must never be. It is reactivated by user input, an
     external signal. This works today and must not break.
   - So, before touching `release`:
     1. Verify, do not assume, that OpenCode's active set
        (`client.session.active`, what `#spent` reads) does not list a
        session that only waits on an elicitation. If it does, the check
        needs a narrower signal than that set. Do not build until this is
        known.
     2. Write the guard test first: an elicitation keep-alive that ends
        with a release sends no interrupt and leaves the session able to
        take the answer. The keep-alive lives in
        `packages/host/src/orchestrator/orchestrator.ts`; its tests are in
        `packages/host/test/orchestrator-walk.test.ts`. That test must
        pass before and after the change.
   - Cost to mention: one read of OpenCode's active set per release.
   - Voice recovery keeps calling `release`; nothing changes in voice.

Reviewed, no change:

- `module.ts`: a room `stop()` that rejects would skip the other rooms and
  the engines. The shipped room cannot reject; nothing changed.
- `engine.ts`: a caller-supplied `source()` that throws escapes from the
  stderr handler and `start()` never settles. Programmatic seam only.

## Test approach the operator wants

- Test production behavior. Do not add tests of tests or coverage configuration.
- Do not pin a suspected bug to gain coverage. Leave the branch open and
  ask the operator what is intended.
- Direct unit calls with fake I/O. Existing integration tests are not the
  convention to copy; do not start an application to test one function.
- Use deferred promises to observe the boundary under test. Advance mock
  time only after the operation is waiting. Avoid sleeps, polling helpers
  and guessed microtask-flush counts.
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

- Fix clear bugs exposed by tests. Commit each bug fix clearly with a
  specific patch changeset. Bring ambiguous behavior to the operator.
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
- Host: `dispatcher/dispatcher.ts` (`provide`), `scheduler.ts`
  (`dispatchQueued`), `channel/engine.ts` (`tick`), `channel/turns.ts`
  (the turn-runner callback) and `cli/commands/jobs.ts` (the add callback),
  all under `packages/host/src/`; also
  `packages/host/test/dreaming.test.ts` (`respond`).
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

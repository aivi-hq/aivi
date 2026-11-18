# Remaining coverage and quality work

## Resumption baseline

The latest full `npm run agentic:verify` exited 0: 1,152 tests passed.
Production coverage is 88.63% lines, 88.17% branches and 83.55% functions.
Fallow still reports 2 check findings, 6 duplicate groups, 18 health
findings, 7 refactoring targets and 2 unconfigured-policy diagnostics. That
run printed no Fallow warning; a standalone `npx fallow` may still print the
entry-point graph-cache invalidation warning.

The full output is `coverage/agentic-verify-voice-followup.log`; exact
coverage is `coverage/coverage-final.json`. Both are generated/ignored
artifacts: regenerate them if absent or stale. No checks or suppressions
were weakened.

`packages/voice` is done except for the open questions below: 100% lines
and functions, 99.9% branches, and no Fallow finding in the package.

## Next batch

Continue toward 100% production coverage, then zero feedback from all tools.
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

## In progress: operator rulings on voice (2026-11-18)

Resume here. The operator answered the open voice questions. Work the
"todo" items in order. Each behavior change: a failing test first, its own
commit, its own patch changeset (see `.changeset/`). Then run
`npm run agentic:verify` once, refresh the baseline above and commit.

How the operator wants to work:

- No question tool. Put questions in the message and stop.
- Post one short status line per step.
- Ask before changing behavior, unless the intent is obvious.
- The operator's word decides. Docs and recorded decisions are not law;
  raise a disagreement, do not treat a doc as a veto.
- Never pin a suspected bug in a test to gain coverage.

Done and committed:

- `543705a` An answer whose text block opened but never streamed is spoken
  whole (`sawText` is set by a delta, not by the start event).
- `7693bb4` A mark ends a spoken clause only when whitespace follows it; a
  mark at the end of the text so far waits. The comment now says `Mr.` is
  cut. All marks (`. , ; : ! ? …`) still end a clause: the operator said
  "`.` followed by space or `\n`" — tell them commas were kept and ask if
  only `.` is wanted.

- `3531412` typographic closing quotes; `01044dd` no `flush` after a
  barge; `57566a5` a room closed while its engine loads stays quiet;
  `6eb962c` the first event shown to a watcher is guarded; `13a377a`
  `voice.lane.partial` when the engine died mid-utterance; `7e5c6fe`
  `slice` before the stream began is null; `ba0b230` setup summary keeps
  transcription on.
- `abf44b6` the wake phrase stays in the quoted sentence, `stripWake` is
  gone; `8f13509` a held lease is noted before its session is prepared;
  the commit after it forgets a room's lease note once recovery returned
  it (proved against the real host dispatcher in `turns-recover.test.ts`).
- Ruled "leave as it is": a room of its own after end of file.

Todo, ruled otherwise:

- Wake phrase: do not strip it. The meeting prompt quotes the line as it
  was said. Delete `stripWake` (`wake.ts`, the export in `index.ts`, its
  test in `wake.test.ts`) and update the meeting tests in `room.test.ts`.
  Changeset: behavior change plus a removed export.
- Setup self-check: use `schema.parse(block)` instead of `safeParse` plus
  the unreachable throw, in `packages/{voice,browser,google-meet}/src/setup.ts`.
  This is a refactor: no changeset. It closes voice's last open branch.
- `engine/mlx-tts.py`: in streaming mode always send a final reply, also
  when the model yields nothing or ends without a final chunk. Check with
  `python3 -m py_compile`; no python test exists, say so.
- `drained()`: the operator has no rule but forbids a helper that is not
  needed. It is needed in two cases: state with no signal (a speaking
  window closing) and "nothing more happened" checks. Replace its first
  use in the mute test of `speech.test.ts` with a boundary on the
  `voice.room.mute` log; explain the rest to the operator.

Lease items (the operator: leases decide capacity, so nothing about them
is "harmless" by default):

- What lingers after recovery is voice's own note (`voice_state` key
  `lease:<room>`), not a dispatcher lease. Capacity is counted from
  `dispatcher_leases`. Todo: forget the note once its release was
  attempted (`VoiceTurns.recover` gets a `forget(label)` callback; the
  module passes `label => store.setRoomLease(label, null)`). Prove it with
  the real host `Dispatcher` and `LeaseStore` over `new Store(':memory:')`
  (see `packages/host/test/dispatcher.test.ts` for the construction): after
  recovery `dispatcher.held()` is 0 and the note is gone.
- Todo: persist the held lease before the session is prepared. Today
  `rememberLease` runs after `provide`, so a crash during session creation
  hides the lease from recovery. Call it first in `VoiceTurns.run`.
- Ask the operator: recovery releases the slot at once and does not stop
  the old session. `aivi serve` restarts OpenCode at start only with
  `opencode.lifecycle: own` (the default). With `discover`, `ensure` or
  `opencode.url`, OpenCode outlives aivi: an old turn may still generate
  while its slot is granted again. Boot order: modules start (voice
  recovery) before `dispatcher.reconcile()`. Should recovery interrupt the
  room's session first?

Open, ask the operator before building:

- Removed pool. Ruling: when a session resumes and its pool is no longer
  configured, warn and continue on the configured pool with the same
  session; a configured pool that does not exist is a hard error (config
  load already rejects an unknown `plugins.<id>.pool`). Not built. Two
  things to confirm first:
  1. Scope. Channels and tickets resume sessions too and wait today
     (`pool-gone` in `packages/host/src/dispatcher/dispatcher.ts`, handled
     in `channel/engine.ts`; the scheduler branch is unreachable because
     jobs never resume). Build it in the dispatcher for every service
     (recommended: the dispatcher owns the session-to-pool record), or in
     voice only?
  2. Model. A resumed session keeps the model it was created with. Is
     that right when its pool, and maybe that model's endpoint, is gone?
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
    only for state with no boundary of its own (a speaking window closing
    behind its last audio). The operator has not ruled on it yet.
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
- Use exclusions or suppressions only when necessary, not to make a score
  green.

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
- The setup self-check "The … block aivi writes does not load its own
  schema; this is a bug." in `packages/voice/src/setup.ts`,
  `packages/browser/src/setup.ts` and `packages/google-meet/src/setup.ts`.
  The wizard builds the block itself, so the throw cannot be reached. It
  is the one uncovered branch in voice. Ask the operator: keep the guard,
  or let `schema.parse` throw.

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

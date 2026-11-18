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

## Voice: open questions for the operator

Each item was confirmed by reading or by experiment. None is fixed and no
test pins the questioned behavior. Ask before changing any of them.

Speaking the answer (`packages/voice/src/speech.ts`):

- A text block that opens (`session.text.started`) but whose deltas never
  arrive is never spoken, and nothing is logged. `sawText` is set by the
  start event alone, so `finish` speaks only the empty tail. The comment
  says an answer that did not stream goes out whole.
- A mark at the end of the text received so far counts as a clause end.
  `3.` and `5 procent.` in two deltas are spoken as two clauses. The
  comment says `3.5` survives uncut.
- The comment says `Mr.` survives uncut. `Mr. Smith is here.` is cut after
  `Mr.`: a period before a space is a clause end.
- The closing-quote set holds `"` twice and no typographic `”`.
- `flush` runs on the barge path when the barge is noticed at the next
  chunk. The kit contract (`packages/plugin/src/voice.ts`) says never.
  Both mouths tolerate it today.

Rooms and turns:

- `turns.ts`: a `pool-gone` refusal is logged at info with the hint meant
  for `waiting`. The line waits until the pool is configured again or the
  session leaves the resume window; with `resumeMinutes: false`, forever.
- `room.ts`: a file/mic room stopped while its engine still loads logs
  `voice.engine.start-failed` and shows state `failed`.
- `room.ts`: `onEvent` replays the engine state to a new listener outside
  the guard that later events get. A listener that throws on that first
  event throws out of `onEvent` and stays registered.
- `room.ts`: after its file ends, a room of its own keeps state `ready`
  and sends `heard()` and `feed()` to the ended engine.
- `lanes.ts`: an engine that dies mid-utterance, before `end()`, leaves a
  partial line without the `voice.lane.partial` warning.
- `module.ts`: a room `stop()` that rejects would skip the other rooms and
  the engines. The shipped room has no rejecting path; nothing changed.
- `store.ts`/`turns.ts`: a `lease:<room>` row released at restart stays
  until that room's next turn, and every restart releases it again. Lease
  ids are random, so this is harmless.

Engine and setup:

- `engine.ts`: `slice` with a negative start returns NaN samples, not
  null. Only a malformed `act` event can ask for one.
- `engine.ts`: a caller-supplied `source()` that throws escapes from the
  stderr handler and `start()` never settles. Only the programmatic seam.
- `setup.ts`: a no to "Download the transcription model now?" reads
  "transcription off" in the summary. ASR stays configured and downloads
  on first audio.
- `wake.ts`: `stripWake` leaves a leading comma: `Hey assistant, help me!`
  becomes `, help me!`. An existing test pins that result.
- `engine/mlx-tts.py` (python, outside coverage): a generator that yields
  nothing sends no final reply, so the client waits its full timeout. A
  chunk without `is_final_chunk` counts as final.

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

# Remaining coverage and quality work

## Resumption baseline

The latest full `npm run agentic:verify` exited 0: 1,023 tests passed.
Production coverage is 87.88% lines, 86.38% branches and 82.00% functions.
Fallow still reports 5 check findings, 8 duplicate groups, 23 health
findings and 2 unconfigured-policy diagnostics. It also printed an
entry-point graph-cache invalidation warning; this is not zero tool feedback.

The full output is `coverage/agentic-verify-voice.log`; exact coverage is
`coverage/coverage-final.json`. Both are generated/ignored artifacts:
regenerate them if absent or stale. No checks or suppressions were weakened.

## Next batch

Continue toward 100% production coverage, then zero feedback from all tools.
Read `coverage/coverage-final.json` for exact gaps; regenerate it if absent or
stale. Keep this note as an open-work list, not a completion log.

Useful starting points:

- `packages/channel-discord/src/module.ts` and
  `packages/tracker-github/src/module.ts`: the largest remaining module
  gaps. Fake services and platform adapters for lifecycle tests.
- `packages/chrome/src/{tab,chrome,connection}.ts` and
  `packages/google-meet/src/{cli,meeting,module}.ts`: large gaps. Use fake
  CDP, tabs and processes; keep live browser/platform gates separate.
- `packages/tracker-linear/src/client.ts`,
  `packages/forge-github/src/setup-project.ts` and
  `packages/host/src/cli/project-setup.ts`: further API and prompt-flow units.

Voice follow-up:

- `packages/voice/src/engine.ts`: finish direct process/decoder units using
  `packages/voice/test/process-fixture.ts`. Check source-startup exceptions
  in the ready-marker callback and source cleanup when the engine exits.
- `packages/voice/src/module.ts`: the lazy STT/TTS owners still cache a
  successfully loaded endpoint after its process later dies. Add a real
  protocol-boundary regression before changing that recovery path.
- Check shutdown after a room's `stop` rejects: every other room and engine
  must still get its cleanup attempt.
- `VoiceTurns.recover` currently logs `turns.recovered` even when the
  dispatcher answers `{pending: lease}`. That answer keeps capacity held;
  it is not proof of recovery. Review stale persisted lease cleanup too.

## Test approach the operator wants

- Test production behavior. Do not add tests of tests or coverage configuration.
- Direct unit calls with fake I/O. Existing integration tests are not the
  convention to copy; do not start an application to test one function.
- Use deferred promises to observe the boundary under test. Advance mock
  time only after the operation is waiting. Avoid sleeps, polling helpers
  and guessed microtask-flush counts.
- `packages/plugin/test/setup-fixture.ts` provides scripted prompts and
  recorded writers; `packages/tracker-linear/test/setup-fixture.ts` shows
  an OAuth listener faked without binding a socket.
- `packages/cli/test/setup-fixture.ts` records setup I/O and observes the
  actual timeout scheduling before advancing mock time. The identity fake
  writes the bearer and URL, like the installed server; only whoami adds
  the verified display cache.
- Voice fixtures observe actual process writes, startup promises and engine
  events. Use them instead of launching sidecars. For identity/null checks
  on `EngineRun`, compare identity as a boolean: an assertion that prints
  the whole ring can render millions of samples and stall the test runner.
- When mocking a built-in used through named ESM imports, call
  `syncBuiltinESMExports()` after replacing it and after restoring it.
- Check coverage in isolation, using a separate report directory so the
  full report remains useful. For example:

  ```sh
  NODE_OPTIONS=--conditions=development node_modules/.bin/c8 \
    '--include=packages/voice/src/engine.ts' --reports-dir=coverage/targeted \
    node --test --conditions=development \
      packages/voice/test/engine-protocol.test.ts
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

## Remaining Fallow findings

Verify actual callers and public contracts before removing these:

- `PacketBand` export in `packages/channel-discord/src/voice.ts`.
- Fallow's `Chrome`/`VersionInfo` finding is a false positive on the private
  constructor. `packages/chrome/dist/chrome.d.ts` exposes only
  `private constructor()` and contains no `VersionInfo`. Triage/report the
  analyzer defect; do not publish the private type just to silence it.
- `BatchEngineRun.duration` in `packages/voice/src/batch.ts`.
- `HearingRoom.currentEngineState` in `packages/voice/src/room.ts`.
- `VoiceTurns.busy` in `packages/voice/src/turns.ts`.

The voice package exports these classes from its package root. That is a
published API; an absent in-repo caller alone does not justify deleting a
member. Confirm the intended public surface before removals.

Duplicate groups to revisit:

- GitHub API test fixtures repeated across `github`, `forge-github` and
  `tracker-github`.
- Probe wait machinery in `tracker-github/src/probe.ts` and
  `tracker-linear/src/setup.ts` polls, while `AGENTS.md` bans periodic
  timers. Ask the operator how to reconcile that before factoring a
  shared polling loop.
- Voice engine stdout/exit handling across `batch.ts`, `engine.ts`, `tts.ts`.
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
- Voice: `turns.ts` (`run`), `setup.ts` (`setup`), `store.ts` (`identify`),
  `speech.ts` (`cutClauses`) and the stdout callback in `batch.ts`, under
  `packages/voice/src/`.
- Meet: `packages/google-meet/src/meeting.ts` (`driveJoin`).

Fallow also recommends splitting `jobs.ts`, `reports.ts`,
`channel/{router,progress,context}.ts` under `packages/host/src/` based on
coupling and complexity density. Review whether a split helps the design;
do not split a small file just to improve a metric. Hotspot suggestions to
"add tests" to test files are not evidence of production coverage gaps.

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
  Ask which policies should be measured; do not disable those checks just
  to silence the diagnostics.
- `packages/host/test/events.test.ts` still uses a polling `until` helper
  and real sleeps. Replace them with observed events and controlled time
  when working on that area.
- `packages/cli/test/cli.test.ts` still has three CLI-entry subprocess cases.
  Move those to direct `run` calls with fake machine I/O when working on
  command routing; keep the package smoke gate separate.
- `packages/voice/test/voice.test.ts` still has legacy child-program and
  real-wait cases. Replace those with the process/lane fixtures when covering
  the remaining voice boundaries; live audio/model gates remain separate.

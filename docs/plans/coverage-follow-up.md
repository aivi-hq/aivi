# Remaining coverage and quality work

The goal is the output of `npm run agentic:verify`: 100% production
coverage and zero feedback from every tool. This note holds only what
serves that goal. Everything else is a ticket in `docs/backlog/` (see
"Off-goal findings").

## Resumption baseline

The latest full `npm run agentic:verify` (2026-11-18, after the registry
pass) exited 0: 1,550 tests passed. Coverage, from Node's report: 91.66%
lines, 91.23% branches and 89.75% functions. 2,924 lines are uncovered, in
210 files, and 100 files are at 100% on all three. Node counts anonymous
functions, which c8 did not, so the function figure is stricter than the
figures from before the move to Node's coverage.

Five rows of that table are wrong, because a test mocks the file with
`mock.module` (see "Module mocks" in `docs/testing.md`). The code under them
is covered; the report is not. `host/src/cli/registry.ts` reads 8.80% (197
lines; its own test file gives 100% of lines, branches and functions),
`host/src/cli/context.ts` reads 15.96% (79 lines; 100% without the wizard
test), `google-meet/src/meeting.ts` reads 229 uncovered lines (100% from its
own test file), `core/src/index.ts` reads 73.33% (4 lines) and
`github/src/index.ts` has 2 phantom lines. Without the three big ones the
table has 2,419 uncovered lines. Which rows are wrong changes from run to
run. Check a row of a mocked file as `docs/testing.md` says before you spend
time on it.

Fallow 3.43.2, with its type-aware companion, reads the V8 folder
`coverage/v8` and reported 7 check findings, 5 duplicate groups, 13 health
findings (1 critical, 1 high, 11 moderate), 22 refactoring targets and 2
diagnostics. See "Remaining Fallow findings". This is not zero tool
feedback. The run printed these warnings:

- Fallow's graph-cache warning ("Graph cache decoded but not reused:
  resolver, entry points, or plugins changed"). It comes and goes between
  runs.
- One `ExperimentalWarning` for each of the five test files that use module
  mocks (the register in `docs/testing.md`).
- One line after Fallow's JSON: "[W] Exit code 0: gates error-severity-findings
  (2 at or above error), health-findings (13 at or above error) failed, but
  bare fallow does not enforce them in --format json." It says what a gated
  run would fail on.
- `npm notice` lines: the pack listing that `pack-smoke` prints. That is its
  normal output.

The full output is `coverage/agentic-verify-units.log`. The raw coverage is
`coverage/v8`, which Fallow reads; `npm run test:cov` clears and rewrites
it. Both are generated/ignored artifacts: regenerate them if absent or
stale. No checks or suppressions were weakened.

At 100% lines, branches and functions, with no Fallow finding:
`packages/voice`, `packages/chrome` and `packages/google-meet` (all
files); in `packages/core/src/`: `face-tab.ts` and `face-page.ts`; in
`packages/channel-slack/src/`: `connection.ts`; in `packages/host/src/`:
`scheduler.ts`, `channel/engine.ts`, `dispatcher/leases.ts` and
`cli/registry.ts`; in `packages/tracker-github/src/`: `tracker.ts` and
`delivery.ts`. `dispatcher/dispatcher.ts` is at 100% lines and functions
with one branch open (see "Next batch").

`packages/tracker-github/src/module.ts` is at 96.27% lines, 97.27%
branches and 95.31% functions. What is open is stop handling that nothing
can reach (see "Left open by the tracker-github pass").

At 100% lines since the plugin command pass (branches not checked):
`google-meet/src/cli.ts`, `tracker-github/src/cli.ts` and `index.ts`,
`tracker-linear/src/cli.ts`, `client.ts` and `index.ts`,
`host/src/cli/project-setup.ts` and `forge-github/src/setup-project.ts`.

## How the operator wants to work

- The operator is the product owner and a consultant, not the designer
  (2026-11-18): "use what I say as advice". Make the choice yourself and say
  what you chose and why. Do not hand a design question back to them. They
  decide product direction; everything else is yours to answer for. When
  they say go, go.
- The goal comes first. Stay on it. Behavior work that does not serve it
  becomes a ticket, not a batch.
- Unit tests only. The operator has said it five times (2026-11-18): "We're
  testing units, not e2e. e2e is a mess to do properly and the architecture
  currently does not lend itself to it. Mock its dependencies and make sure
  that the UNIT does what it should do." Never run a real home, config,
  registry, plugin, shell, browser or service to reach a unit. Never change
  `src`, or the shape of a test, to avoid a mock: mocks are fine, even when
  they make the coverage report misread a file. Before a test, ask what the
  unit reaches, and mock that.
- Short messages, lists, only what needs the operator's attention. Use
  plain words: no labels or section names from this note. The operator
  does not read it. They do not always read your reasoning either: if it
  matters, say it in the reply.
- Say what the next batch is. The operator says go.
- No question tool. Put questions in the message and stop.
- Post one short status line per step.
- Anything that gets to a clean `agentic:verify` has the operator's
  blessing (2026-11-18), as long as it is not a workaround, a hack, or a
  disabled or ignored rule.
- Anything that seems wrong goes in a ticket; move on. Do not stop to ask
  about it. A bug that is simple to fix is fixed in the batch, with a test
  that failed first and a changeset (the operator, 2026-11-18: "Bug? Fix if
  simple, move to a ticket in docs/backlog otherwise"). A behavior question,
  or a fix that needs a ruling, is a ticket: leave the lines open and point
  this note at it.
- The operator's word decides. Docs and recorded decisions are not law;
  raise a disagreement, do not treat a doc as a veto.
- Never pin a suspected bug in a test to gain coverage.
- Change files with the `edit` and `write` tools. No scripted edits
  (`python`, `sed`, heredocs): the operator sees no diff for them, and a
  script can change nothing without saying so (the operator, 2026-11-18).
  The shell is for running things and for `git`, `mv` and `rm`.
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

The operator's word (2026-11-18): keep going for coverage until nothing is
left that needs their decision. Done so far: chrome, google-meet, the face
tab and page, the Slack connection and the plugin registry. In this order:

- `packages/knowledge/src/index.ts` (96 lines, 24 branches): a fake QMD SDK
  through `createKnowledgeService(loaded, loader, log)`, and `warmKnowledge`.
  Two existing tests there run the real `@tobilu/qmd` (`knowledge.test.ts`,
  tests 2 and 3). They are integration tests; leave them, and add the unit
  tests beside them. `search` (high) and `surveySources` are Fallow
  complexity findings: refactor them after they are covered.
- Small config files with a gap: `channel-slack/src/config.ts` (lines
  76-80) and `channel-discord/src/config.ts` (lines 95-101) are the
  `plugin.createModule` factory: it imports `./module.ts` lazily and builds
  the module with its directory resolved against the home. Mock `./module.ts`
  and check what it is called with. `browser/src/config.ts` has 20 lines
  open. They looked covered while a host test ran the real Slack plugin;
  that run is gone, so the gap shows now.
- The `cli` package: `service.ts` (91 lines), `add.ts` (58), `main.ts` (53),
  `link.ts` (47), `runtime.ts` (42), `update.ts` (30), `remove.ts` (27;
  Fallow finding), `exec.ts` (23), `uninstall.ts`, `upgrade.ts`.
- `packages/tracker-linear/src/module.ts` (96 lines, 52 branches): the twin
  of the GitHub module. Its test starts a real orchestrator and a fake
  OpenCode server; `packages/tracker-github/test/module-decisions.test.ts`
  is the same subject as units over fakes, for comparison. Linear's own
  copies of two bugs fixed in the GitHub module are tickets:
  `docs/backlog/linear-closing-can-be-said-twice.md` and
  `docs/backlog/failed-module-start-leaves-its-registrations.md`. Then
  `tracker.ts` (58), `work.ts` (22), `mcp.ts` (13).
- The rest of `packages/tracker-github/src/`, in the same package and the
  same style: `setup-project.ts` (43 lines, 32 branches; `askLanes` is a
  Fallow finding), `client.ts` (34 lines, 23 branches; `githubClient` is the
  default tracker's connection), `runprogress.ts` (33 lines; three duplicate
  groups run through it, see "Remaining Fallow findings"), `probe.ts` (17
  lines), and a few branches in `projects.ts` (4) and `work.ts` (3).
- `packages/host/src/orchestrator/orchestrator.ts` (100 lines, 100
  branches): lines 188-193 wait for a small, clear fix. Under the
  operator's rule it is fixed with a test:
  `docs/backlog/orchestrator-release-rejection-is-unhandled.md`. The
  dispatcher's twin bug is
  `docs/backlog/lease-callback-that-throws-escapes-the-drain.md`. Then
  `server.ts` (69), `application.ts` (60), `api/host-tools.ts` (59),
  `cli/plugin-setup.ts` (34), `runtime.ts` (33), `store.ts` (30),
  `cli/commands/knowledge.ts` (28) and the rest of the host tail.
- `packages/channel-slack/src/module.ts` (40 lines).
- `core/src/brand.ts` (30 lines, no function called).
- Needs a ruling first: `channel-discord/src/module.ts` (643 lines) and
  `voice.ts` (105): see "Code to refactor before it can be unit-tested". A
  module mock of `discord.js` may reach them; nobody has checked how much
  of the client a fake needs.

Left open by the tracker-github pass (`module.ts` and `tracker.ts`;
2026-11-18):

- `packages/tracker-github/src/module.ts`, stop handling that nothing can
  reach from the GitHub adapter: `stopAssistant`, `stopOrphans` and the
  loop in `stopDeleted` (no assistant conversation is ever bound with an
  issue), `onStopSignal` and the `signal === 'stop'` check in `onPrompted`
  (GitHub sends no signal), and the `issue.archived` checks in `onBrought`
  and `stopOrphanRun` (GitHub never reports it). Not tested on purpose:
  reviving or removing them is a ruling. Ticket:
  `docs/backlog/github-module-stop-handling-nothing-reaches.md`.
- `stopOrphanRun`, the `run.sessionId` fallback: one branch arm. A person
  who takes the ticket back while the run is still preparing does not stop
  it. Ticket:
  `docs/backlog/taking-the-ticket-back-during-preparation-does-not-stop-the-run.md`.
- Host: a render stage that throws synchronously fails the run, not the
  log. Ticket:
  `docs/backlog/render-stage-that-throws-synchronously-fails-the-run.md`.

Left open by the capacity-path batch (dispatcher, scheduler, channel
engine; 2026-11-18):

- `packages/host/src/dispatcher/dispatcher.ts`, `#verdict`: the boot pass
  ends a lease whose pool is gone. Not tested on purpose: the behavior is
  in question. Ticket: `docs/backlog/boot-ends-lease-whose-pool-is-gone.md`.
- `packages/host/src/orchestrator/orchestrator.ts`, lines 188-193 (the
  dispatcher callback in the constructor): they need the fix in
  `docs/backlog/orchestrator-release-rejection-is-unhandled.md` before a
  test can reach them.

Left open by the plugin command pass (2026-11-18):

- `packages/host/src/cli/project-setup.ts`: every line is covered. Four
  small functions are never called: the default `connect` and `sleep` of
  `listLaneAgents`, and the `print` and `agents` that the wizard hands a
  contributor. Reach them with mocks (the operator, 2026-11-18): a module
  mock of `../opencode.ts` for `connectOpenCode`, a mock of `print` from
  `@aivi/core`, and mock time for the one-second `sleep`. Add each use to
  the register in `docs/testing.md`. Do not add a seam to `src` for them.
- `packages/forge-github/src/setup-project.ts`: every line is covered.
  Open branches: line 53 (a listing error that is not an `Error`) and
  lines 73 and 89 (an answer that names no repository). The prompt's own
  `validate` refuses such an answer first, so 73 and 89 look unreachable:
  decide whether to remove them.
- `packages/channel-slack/src/cli.ts`, lines 36-49: the `manifest` prompt
  for an unconfigured home. `cliFixture` passes the real prompts: give it
  a `prompts` option and set `process.stdin.isTTY` to reach these 13
  lines.
- `packages/channel-discord/src/cli.ts`, lines 25-27: `register` calls
  Discord. Not for a unit test.

## Code to refactor before it can be unit-tested

The operator's rule (2026-11-18): code that cannot be tested as a unit is
written down here, and the work moves on. It is refactored later to make
it testable. Do not cover it through a real setup. A refactor is a batch
like any other: say what it is and wait for the go.

- `packages/channel-discord/src/module.ts` (643 lines): it constructs
  `new Client(...)` itself.
  - To make it testable: a connection handed in, like Slack's
    `SlackConnection`. A module mock of `discord.js` may reach it without
    that; nobody has checked how much of the client a fake needs.

The project wizard and the forge's git steps were on this list. Module
mocks reached them without a refactor (see `docs/testing.md`).

## Where the uncovered lines are

From the table that `npm run test:cov` prints (its last column lists the
uncovered lines of each file): 2,924 lines are uncovered, in 210 files; 2,419
without the three misread rows (see "Resumption baseline"). The largest
files, under `packages/`:

| Uncovered lines | File |
| ---: | --- |
| 643 | `channel-discord/src/module.ts` |
| 105 | `channel-discord/src/voice.ts` |
| 100 | `host/src/orchestrator/orchestrator.ts` |
| 96 | `knowledge/src/index.ts` |
| 96 | `tracker-linear/src/module.ts` |
| 91 | `cli/src/service.ts` |
| 69 | `host/src/server.ts` |
| 60 | `host/src/application.ts` |
| 59 | `host/src/api/host-tools.ts` |
| 58 | `cli/src/add.ts` |
| 58 | `tracker-linear/src/tracker.ts` |
| 53 | `cli/src/main.ts` |
| 47 | `cli/src/link.ts` |
| 43 | `tracker-github/src/setup-project.ts` |
| 42 | `cli/src/runtime.ts` |
| 40 | `channel-slack/src/module.ts` |
| 35 | `tracker-github/src/module.ts` |
| 34 | `host/src/cli/plugin-setup.ts` |
| 34 | `tracker-github/src/client.ts` |
| 33 | `host/src/runtime.ts` |
| 33 | `tracker-github/src/runprogress.ts` |

Notes for these:

- `channel-discord/src/module.ts` constructs `new Client(...)` itself: it
  has no seam like Slack's `SlackConnection`. Try a module mock of
  `discord.js` first, as a class (see the Slack SDK mocks in
  `channel-slack/test/connection.test.ts`); a seam in `src` only if that is
  not enough.

## Test approach the operator wants

- Test production behavior. Do not add tests of tests or coverage configuration.
- Do not pin a suspected bug to gain coverage. Leave the branch open and
  write a ticket for it.
- Direct unit calls with fake I/O. Existing integration tests are not the
  convention to copy; do not start an application to test one function.
- The operator's words (2026-11-18): "We're writing unit tests so we test
  the units. Otherwise you are testing clack etc, which is a waste of time
  and energy." And: "We are testing what would happen based on user
  inputs. This does not require a real setup." So: prompts are mocks with
  scripted answers. Never the real clack, never a real wizard run, never a
  spawned git, never a real config load to reach one function.
- "If the code … can't be tested, this is something we document so we can
  move on and refactor them later to make them more testable." Such code
  goes in "Code to refactor before it can be unit-tested". Do not reach it
  through a real setup instead.
- The operator on mocks (2026-11-18): "Using mocks is the go-to solution
  when writing unit tests in basically every single programming
  language." A module that a unit imports itself (`@clack/prompts`,
  `runGit`, `context.ts`) is replaced with `mock.module`. The test scripts
  pass `--experimental-test-module-mocks`: "go with the flag for now", and
  "every use of it must be accounted for". Read `docs/testing.md` first:
  the rules, the Node version facts and the register of every use.
  - A mocked file can be misread by the coverage report (the code is
    covered; the table is wrong): the report holds two entries for the one
    path and shows the one it reads last. Measured 2026-11-18, it showed
    229 phantom lines on one file and 197 on another in a full run. Mocks
    are fine to use; do not avoid one because of it. To read the true
    number, run the package's tests without the mocking file: the steps are
    in `docs/testing.md`.
- The operator on a recording object that a test file keeps by hand
  (2026-11-18): it "reads like a custom mock. E.g. jest has
  .toHaveBeenCalled and you are maintaining a custom object." The
  runner's own equivalent is `mock.fn()` with `.mock.calls` and
  `.mock.callCount()`. Two test files keep such an object (`scene`):
  `packages/host/test/project-wizard.test.ts` and
  `packages/forge-github/test/setup-project.test.ts`.
- Time: see "Time" in `docs/testing.md`. One test takes under 20 ms. Pass a
  short duration as an option instead of faking a clock, and make a long
  hardcoded one an option (the operator, 2026-11-18). Use mock time only when
  the code gives no way to shorten the wait; then advance it only after the
  operation is waiting. Use deferred promises to observe the boundary under
  test. Avoid sleeps, polling helpers and guessed microtask-flush counts.
- The operator on what a unit test is (2026-11-18): "You are testing a unit.
  You are testing if it does what you expect it to do. You mock what the
  underlying engine would return and then verify behavior. You do not need a
  'fake document'. You need targeted mocks." Mock what is non-trivial; a
  tiny utility stays real: a judgement call. "I am not a fan of test-only
  code": code that is hard to reach moves to the file where it belongs, and
  production code imports it. A pretend browser, DOM or clock is the
  mistake: check what the unit sends or returns, with literal equality.
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
  - Coverage counts V8 blocks. An `if` with no `else` whose body always runs
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
- Check coverage in isolation: run one test file with Node's coverage,
  limited to the file you work on. It prints the table for that file only.
  For example:

  ```sh
  NODE_OPTIONS=--conditions=development node --test \
    --experimental-test-module-mocks --conditions=development \
    --experimental-test-coverage --test-coverage-include-all \
    '--test-coverage-include=packages/voice/src/engine.ts' \
    packages/voice/test/engine.test.ts
  ```

- A bug that a test exposes: if the fix is simple, write the test that
  fails first, fix it, and add a changeset; if it needs a ruling or is
  large, it becomes a ticket in `docs/backlog/`. Never write the test that
  pins the bug. Dead code and guards that nothing can reach are removed
  instead: verify the callers first, and give a removed public member its
  own changeset. Code that is dead only because a ruling is open stays, and
  gets a ticket.
- No exclusion or suppression to make a score green, and none at all
  without the operator's approval (see the hard rule in "How the operator
  wants to work").

Fixtures and gotchas from the plugin command pass (2026-11-18):

- `packages/plugin/test/cli-fixture.ts`: `cliFixture(factory, home)` plays
  a plugin's commands against a recorded context. `home` is
  `{ plugins, stateDirectory, store, onPoke }`. It returns
  `{ printed, said, pokes(), run(...line) }`. An action that rejects makes
  `run` reject.
- Fallow reports a duplicate group at 3 occurrences. Three similar test
  files make a new finding. Write one table-driven test instead; that is
  why the inbox test sits in the kit's tests (`plugin/test/cli.test.ts`)
  and finds each adapter by name.
- The kit cannot import its dependents statically. Its tests reach them
  with `await import(spec)` where `spec` is a string value.
- Fixtures cross packages by relative path: `../../plugin/test/…`.
- Never replace `process.stdout.write` in a test. The test runner reports
  over the same pipe, and one test's result was lost that way. Code that
  prints straight to the terminal is not ready for a unit test: list it
  for a refactor.
- `mock.module` exists only with `--experimental-test-module-mocks`. The
  `test` and `test:cov` scripts pass it; a targeted run must pass it too.
- `githubApp()` keeps one connection for the whole process. Replace it
  through the `@aivi/github` module mock
  (`forge-github/test/setup-project.test.ts`).
- `LinearClient` takes `options.fetch`: script it with a function, no
  socket (`scripted()` in `tracker-linear/test/client.test.ts`).
- A wait loop on `sleep`: enable mock `Date` and `setTimeout`, settle a
  promise when the sleep is scheduled, then tick past the deadline
  (`clock()` in `google-meet/test/cli.test.ts`).

Fixtures and gotchas from the tracker-github pass (2026-11-18):

- `packages/tracker-github/test/module-decisions.test.ts` starts the module
  over fakes with no module mock. `world(t)` builds the fakes and owns the
  teardown order: the modules a test started stop first, then the store
  closes. `t.after` hooks run in the order they were registered, so a
  store closed by an earlier hook breaks the module's stop. `start(world)`
  returns the registered tracker stages, the event sink and the wake
  listener.
- The host's real `ChannelEngine` runs over a dispatcher whose pool is
  always full (`request` answers `{ refused: 'full' }`). The engine then
  asks for every waiting turn and never starts one. `asked()` is what it
  asked for, and the offline notice that a stop sends to the queued
  conversations goes out through the module's own delivery.
- `mock.method(realInstance, 'method', impl)` answers the I/O of a real
  class and leaves its pure helpers real: `GithubPlatform`'s conversation
  words (`idFor`, `parts`, `ticketOf`) stay its own.
- `mockImplementationOnce(impl, onCall)`: `onCall` is the invocation
  number. Two calls without it aim at the same invocation, and the later
  one wins.
- A log line is said before the attempt that said it has unwound. A test
  that acts right after `recorder().next(event)` can meet that attempt
  still in flight, and a second wake then joins it. Start each wake from a
  settled state: one wake per test.
- A stage hook returns `void | Promise<void>`: wrap it for `assert.rejects`
  (`async () => h.work.ready(run)`). A run with no session is
  `runOf({ sessionId: undefined as never })` under
  `exactOptionalPropertyTypes`.
- `recorder()` from `packages/host/test/support.ts` can be imported by
  another package's tests by relative path.

Fixtures and gotchas from the chrome, google-meet, core and Slack passes
(2026-11-18):

- The code that runs inside a browser page is in `page.ts` files:
  `chrome/src/page.ts`, `google-meet/src/page.ts` and
  `core/src/face-page.ts`. Tests call those functions with the few globals
  they touch: `inPage` and `element` in `packages/chrome/test/in-page.ts`
  (google-meet imports them by relative path).
- `Tab`, `Chrome` and `CdpConnection` are tested with targeted mocks: the
  `WebSocket` is a tiny class, `Chrome` mocks spawn, fetch, fs, `existsSync`
  and the static `CdpConnection.open`; `packages/chrome/test/connection-stub.ts`
  is the stub connection. `Chrome.launch` is static: mock it with
  `t.mock.method(Chrome, 'launch', …)`.
- `driveJoin` (`google-meet/test/meeting.test.ts`) is tested with a tab stub
  and "sleeping advances time": `setTimeout` answers at once and moves a
  mocked `Date` on, so no test waits.
- A fake path under `/home` is a trap on macOS: it is an automount point,
  and every read of it stalls for about 30 ms. Fake paths go under the temp
  directory, or are plain strings the unit never reads.
- The Slack SDK is mocked by classes (`channel-slack/test/connection.test.ts`):
  the unit builds `WebClient` and `SocketModeClient` with `new`.

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

New with Fallow 3.43.2 (2026-11-18). Each needs a look; none is changed yet:

- Unused dev dependencies in the root `package.json`: `@opencode/client` and
  `commander`. `scripts/` is ignored by Fallow (see `.fallowrc.jsonc`) and
  may use them: check before removing. Do not hide them with
  `ignoreDependencies` without the operator.
- Unlisted dependency `@aivi/host`: imported by
  `packages/plugin/test/cli.test.ts` (line 79), the kit's test that reaches
  its dependents by `await import(spec)`.
- Unlisted binary `opencode`: run by `packages/cli/src/setup.ts` and
  `uninstall.ts`. It is an external program, not an npm dependency.
- Duplicate export aliases: `contributor` and `default` are one value
  exported twice in `packages/tracker-github/src/setup-project.ts` and
  `packages/tracker-linear/src/setup-project.ts`.
- 14 of the 22 refactoring targets are change coupling ("changes with X in N
  commits without an import"), mostly a source file and its test; 7 say to
  split a high-impact file (`jobs.ts`, `reports.ts`, `channel/router.ts`,
  `channel/progress.ts`, `channel/context.ts`, `chrome/src/page.ts` and
  `google-meet/src/page.ts`); 1 is `driveJoin`. They are suggestions, not
  defects. The two `page.ts` files hold the code that runs in a browser
  page, on purpose (`docs/testing.md`): leave them.
- The new `fallow-type-aware` dev dependency is required: without it Fallow
  warns on every run and falls back to conservative findings.

Duplicate groups to revisit:

- GitHub API test fixtures repeated across `github`, `forge-github` and
  `tracker-github`.
- Probe wait machinery in `tracker-github/src/probe.ts` and
  `tracker-linear/src/setup.ts` polls, while `AGENTS.md` bans periodic
  timers. Ask the operator how to reconcile that before factoring a
  shared polling loop.
- Progress scheduling/rendering across `host/src/channel/reporter.ts` and
  the two trackers' `runprogress.ts` files.

Remaining complexity findings:

- CLI: `packages/cli/src/remove.ts` (`remove`).
- Core: `packages/core/src/config.ts` (`loadConfig`).
- Discord: `packages/channel-discord/src/voice.ts` (`reconcileNow`).
- Host: `channel/turns.ts` (the turn-runner callback) and
  `cli/commands/jobs.ts` (the add callback), under `packages/host/src/`;
  also `packages/host/test/dreaming.test.ts` (`respond`).
- Knowledge: `packages/knowledge/src/index.ts` (`search`, `surveySources`).
- GitHub tracker: `probe.ts` (the agent-event `read`), `setup.ts`
  (`setup`) and `setup-project.ts` (`askLanes`), under
  `packages/tracker-github/src/`.
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
coverage. Fallow reads the V8 folder `coverage/v8` that `npm run test:cov`
writes, so every function is measured, anonymous callbacks included. The
temporary CRAP threshold is 350 (`.fallowrc.jsonc`): at the default limit
of 30 the same coverage gives 68 health findings instead of 13, most of
them functions no test calls yet. It goes back to 30 when that gap is
closed.

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

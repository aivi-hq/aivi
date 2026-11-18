# Testing

How aivi's unit tests are written, and the register of module mocks. How to
run them is in [AGENTS.md](../AGENTS.md#build-and-test).

## A unit test tests the unit

- Unit tests only. No integration test and no end-to-end test: the
  architecture does not lend itself to them, and the live gates (OpenCode,
  Discord, Chrome) cover what a mock cannot (the operator, 2026-11-18).
- Mock what the unit reaches. Do not run the real collaborator, a real home,
  a real plugin or a real registry to get out of a mock. Do not change
  `src` or the shape of a test to avoid a mock. When the unit imports its
  collaborator itself, `mock.module` is the tool.
- A test calls one unit and answers what the unit reaches: the prompts, a
  client, git, a process, files, the network, the loaded config, the plugin
  registry. A mock returns what the real thing would return.
- Its subject is what the unit does with those answers: what it sent, what
  it returned, what it threw. Check it with literal equality (`deepEqual`)
  where you can. What clack draws, what git moves and what a real home loads
  belong to other units or to the live gates.
- Mock what is not trivial. A tiny pure helper stays real. Which is which is
  a judgement call (the operator, 2026-11-18).
- Do not rebuild the engine. No pretend browser, no pretend DOM, no pretend
  protocol server. A targeted mock is an object literal with only the
  members the unit touches.
- A unit that takes its collaborators as arguments gets fakes as
  arguments. A unit that imports them gets a module mock.
- No code in `src` that only a test uses. When a test cannot reach a
  function, move it to the file where it belongs by what it is, and let
  production code import it from there. Example: the code that runs inside a
  browser page is in `packages/chrome/src/page.ts`, the code that runs in
  Node is in `tab.ts`.

## Time

- One test takes under 20 ms in total. It is a guideline: use judgement.
- Prefer a short duration over a fake clock. When the code takes a duration
  as an option, the test passes 1–5 ms and a real timer fires.
- When a long duration is hardcoded (a grace period, a poll interval), make
  it an option with the same default, so that a test can shorten it.
- Use mock time only when the code gives no way to shorten the wait. A real
  wait of more than a few milliseconds is the last resort.

## What a mock can reach

Checked on Node 26.13.1, with scratch test files:

- Each test file runs in its own process (not a thread). A mock in one file
  cannot touch another file.
- The tests of one file share that process and run one after another.
  `t.mock` is undone when its test ends.
- Inside one file a mock can still leak, in three ways:
  - A global set by hand. Remove it in `t.after`.
  - A Node built-in imported by name (`spawn`, `readFile`, `existsSync`).
    `t.mock` restores the property, but the named import keeps the mock
    until `syncBuiltinESMExports()` runs again. Call it after replacing the
    built-in and after restoring it, as `packages/voice/test/process-fixture.ts`
    does.
  - `mock.module` serves every test in the file, by design (see below).

## Gotchas

- Mock a property once per test. A second `t.mock.property` of the same
  property in one test leaves the process hanging when the test ends
  (checked on Node 26.13.1: it never exits). Mock it once and change the
  object the mock holds.
- A mock of a child process says `exit` after `kill` returns, as a real child
  does. A mock that says it inside `kill` runs before the unit has registered
  its listener, and the unit waits for ever.
- A collaborator that the unit builds with `new` (an SDK client) is mocked by a
  class, not by `mock.fn(function …)`. `biome check --write` rewrites a function
  expression into an arrow function, and an arrow cannot be constructed
  (`WebClient is not a constructor`).
- A CommonJS package under `mock.module`: name the exports the unit imports.
  Spreading the real module brings `__esModule` along, and the mock cannot
  redefine it.
- Node loads some globals on first use: the first `new WebSocket` or read of
  `WebSocket` costs about 25 ms, and the first `Response` about 15 ms. The
  first test of a file that touches them is that much slower. It is not the
  cost of the test.
- A fake path under `/home` is a trap on macOS: `/home` is an automount
  point, and every read of it stalls for about 30 ms (checked on
  2026-11-18, a `faceInjection` read of `/home/...`). Put a fake path under
  the temp directory, or keep it a plain string that the unit never reads.
- Run a test file you are not sure of under a time limit
  (`perl -e 'alarm 60; exec @ARGV' node --test …`). A hang leaves nothing to
  read.

## Module mocks

`mock.module` replaces a module that the unit imports itself. It is an
experimental Node API ("Stability: 1.0 - Early development"). The `test`
and `test:cov` scripts enable it with `--experimental-test-module-mocks`.
The operator allows it sparingly (2026-11-18): every use is in the register
below.

A use follows these rules:

- Call `mock.module(specifier, { exports })`. `exports.default` is the
  default export; every other key is a named export. `namedExports` and
  `defaultExport` are deprecated: Node 26.13.1 prints a
  `DeprecationWarning` for them and a later version removes them.
- Register the mock at the top of the test file, then load the unit with
  `await import(...)`. A unit that was loaded before the mock keeps the
  real module.
- One mock serves every test in the file.
- To replace part of a module, spread the real one:
  `{ exports: { ...real, runGit } }`.
- Add the use to the register in the same commit.

A mocked first-party file does two kinds of damage to the coverage report. The
code is not wrong; the report is:

- Node builds a mock from generated source. Its script has the real file's
  path plus `?node-test-mock=N`, and **every dynamic `import()` of the
  mocked module makes a new one** (checked in the raw V8 data of a full run:
  `browser/src/module.ts` had four entries, one per test that built the
  module). Node reads the real file for the line count, so each entry is a
  copy of the whole real file, and nearly all of it counts as uncovered.
- Damage to the `all files` line (the one `npm run test:cov` ends on): each
  copy is added to the total. On 2026-11-18 a full run held 14 such entries
  for first-party files, about 5,000 lines, and the line read 85.78% while
  the rows of the table added up to 93.99%. A controlled change proved it:
  the Slack and Discord plugin tests and the registry test imported their
  mocked module 3, 2 and 2 times; with one import each, and the same
  assertions, the line went from 85.78% to 89.82%.
- Damage to a row: when a mock entry and the real entry share a path, the
  report shows the one it reads last. That depends on the order in which the
  test processes end, so it changes from run to run. In one full run
  `google-meet/src/meeting.ts` read 8.40% (true 100%),
  `channel-slack/src/module.ts` 8.01% (true 93.59%) and
  `tracker-linear/src/setup-project.ts` 9.12% (true 97.19%); the next run
  read them right and misread others (`host/src/cli/registry.ts` 8.80%,
  `context.ts` 15.96%). A third-party package that is mocked costs nothing:
  its files are not in the report.
- What to do when you write a mock of a first-party file:
  - Make the unit load it once. Table-driven cases that each import it again
    add a copy each; one case is enough when the others only re-test a
    helper that has its own tests.
  - Prefer a mock of a small file.
  - Do not avoid the mock because of this. Mocks are the way to test a unit
    (the operator, 2026-11-18).
- The honest overall figure is the sum over the rows of
  `file length × (100 − line %) / 100`, with the rows of mocked files taken
  from a run without the mocking test. At the end of 2026-11-18 it was about
  94.7%; the `all files` line read 89.82%.
- To read the true number of a file in the register: run the tests of its
  package with `--test-coverage-include=<that file>`, once with and once
  without the test file that mocks it. The run without it is the number to
  trust, and the gap that remains in it is real.
- The line cannot be made right from the tests. A change to how `test:cov`
  reports needs the operator: see the ticket
  `docs/backlog/coverage-total-counts-copies-of-mocked-files.md`.

Node version:

- The floor is `engines` in `package.json`: `>=26.1.0 <27`.
- The Node docs list the `exports` option from v26.1.0 on (checked at
  v26.1.0, v26.12.0, v26.13.0 and v26.13.1). The tests have run on 26.13.1
  only.
- A test file that uses a module mock prints one `ExperimentalWarning`.
- On a Node upgrade: read the `mock.module` entry in the test runner docs
  of the new version, then run the files in the register.

### Register

| Test file | Module replaced | What the unit reaches through it |
| --- | --- | --- |
| `packages/host/test/project-wizard.test.ts` | `@clack/prompts` | The wizard's own questions and its last line: `text`, `select`, `isCancel`, `outro`, `cancel` |
| `packages/host/test/project-wizard.test.ts` | `packages/host/src/cli/context.ts` | The loaded config, the composed schema, the home store |
| `packages/host/test/project-wizard.test.ts` | `packages/host/src/cli/registry.ts` | The project contributors of the configured plugins |
| `packages/host/test/registry.test.ts` | `@aivi/forge-github/setupProject` | The forge's project contributor: its role and its `setup` |
| `packages/host/test/registry.test.ts` | `@aivi/tracker-linear/setupProject` | The tracker's project contributor: its role and its `setup` |
| `packages/knowledge/test/default-sdk.test.ts` | `@tobilu/qmd`: `createStore` and `extractSnippet` | QMD's store and its snippet cutter, for a service that is handed no SDK |
| `packages/forge-github/test/setup-project.test.ts` | `@aivi/github`: `githubApp` and `runGit`, the rest is the real module | The GitHub App's grant and token, and git |
| `packages/browser/test/plugin.test.ts` | `packages/browser/src/module.ts` | The module's constructor, `createBrowserModule` |
| `packages/channel-discord/test/plugin.test.ts` | `packages/channel-discord/src/module.ts` | The module's constructor, `createDiscordModule` |
| `packages/channel-slack/test/plugin.test.ts` | `packages/channel-slack/src/module.ts` | The module's constructor, `createSlackModule` |
| `packages/google-meet/test/module.test.ts` | `@aivi/core`: `openFaceTab`, the rest is the real module | The face tab the meeting opens: its tab, ears, mouth and close |
| `packages/google-meet/test/module.test.ts` | `packages/google-meet/src/meeting.ts` | The button trail: `driveJoin` and `driveLeave` |
| `packages/channel-slack/test/connection.test.ts` | `@slack/web-api`: `WebClient` | The Slack Web API: auth, chat, reactions and users |
| `packages/channel-slack/test/connection.test.ts` | `@slack/socket-mode`: `SocketModeClient`, with the real `LogLevel` | The Socket Mode client: its events, start and disconnect |

The register is complete when it lists every match of
`grep -rn "mock.module(" packages/*/test`.

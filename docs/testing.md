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
and `test:cov` scripts enable it through `node.config.json`
(`experimental-test-module-mocks`). A run that does not read that file, such
as a bare `node --test`, has no `mock.module`. The operator allows it
sparingly (2026-11-18): every use is in the register below.

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

Coverage and mocks:

- Node builds a mock from generated source. Its script has the real file's
  path plus `?node-test-mock=N`, and every dynamic `import()` of the mocked
  module makes a new one (the default is `cache: false`). Node reads the real
  file for the line count, so each entry is a copy of the whole real file,
  and nearly all of it is uncovered.
- Node leaves these entries out of its report, but only when no
  `--test-coverage-include` glob is given. It checks the include globs
  first, and a path that matches one is kept before the mock marker is
  looked at (Node 26.13.1 and `main`, read from the source on 2026-11-18).
  **`node.config.json` has no include glob. Do not add one.** `test:cov` had
  `packages/*/src/**`, and a full run held 17 phantom entries for first-party
  files, about 5,000 lines: `all files` read 85.78% while the rows added up
  to 93.99%, and a mocked file's row could show a phantom
  (`channel-slack/src/module.ts` read 8.01%, true 93.59%). With the same
  tests and no include glob, the line reads 94.96% and every row is true.
- `test-coverage-exclude` says what stays out instead: `packages/*/dist/**`,
  `packages/*/test/**`, `scripts/**` and the files named there. Node's glob
  matcher has no negation, so the list names what to leave out. A new
  top-level folder with code shows as a row at 0% until it is added to the
  list. Any exclude glob replaces Node's default exclusion of test files,
  which is why `packages/*/test/**` is in the list.
- A mocked third-party package costs nothing: its files are not in the
  report.
- Fallow reads the raw V8 folder, which still holds the mock entries. With
  and without them it reported the same health findings at the same scores
  (checked 2026-11-18).
- Mocks are the way to test a unit. The report is no reason to avoid one
  (the operator, 2026-11-18).
- To read one file's number, run the tests of its package with the config
  and `--experimental-test-coverage`, and pick the row. The report lists
  every file (`test-coverage-include-all`), so a file the run did not load
  shows 0%:

  ```sh
  NODE_OPTIONS=--conditions=development node --config-file=node.config.json \
    --test --conditions=development --experimental-test-coverage \
    packages/chrome/test/tab.test.ts | grep ' tab.ts '
  ```

  Ticket with the full record:
  `docs/backlog/coverage-total-counts-copies-of-mocked-files.md`.

Node version:

- The floor is `engines` in `package.json`: `>=26.1.0 <27`.
- The Node docs list the `exports` option from v26.1.0 on (checked at
  v26.1.0, v26.12.0, v26.13.0 and v26.13.1). The tests have run on 26.13.1
  only.
- A test file that uses a module mock prints one `ExperimentalWarning`.
- The scripts read `node.config.json` through `--config-file`, the stable
  name from v26.12.0 (before that, `--experimental-config-file`, which stays
  as an alias). The option `test-coverage-include-all` needs v26.7.0.
  `engines` was not raised to match.
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

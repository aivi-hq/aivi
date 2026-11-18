# Testing

How aivi's unit tests are written, and the register of module mocks. How to
run them is in [AGENTS.md](../AGENTS.md#build-and-test).

## A unit test tests the unit

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
- Run a test file you are not sure of under a time limit
  (`perl -e 'alarm 60; exec @ARGV' node --test …`). A hang leaves nothing to
  read.

## Module mocks

`mock.module` replaces a module that the unit imports itself. It is an
experimental Node API ("Stability: 1.0 - Early development"). The `test`
and `test:cov` scripts enable it with `--experimental-test-module-mocks`.
The operator allows it sparingly (2026-11-18): every use is in the register
below.

**Not for a file of ours.** Do not `mock.module` a file under
`packages/*/src`, or a workspace package that resolves to one (`@aivi/core`,
`@aivi/github`). The coverage report of that file stops being true, and how
wrong it is changes from run to run:

- Node builds the mock from generated source, under the real file's path plus
  `?node-test-mock=N`. The report ends up with two entries for one path and
  shows whichever it reads last, which depends on the order in which the test
  processes end.
- Measured on 2026-11-18, with the same tests: `packages/google-meet/src/meeting.ts`
  read 100% of its lines with the default concurrency and 8.40% with
  `--test-concurrency=1`. In the full run `meeting.ts` read 8.40% and
  `packages/core/src/index.ts` fell from 100% to 73.33% of its lines, after two
  tests mocked them. Fallow reads the same data.
- Mock what the file reaches instead: a method on a class
  (`t.mock.method(Chrome, 'launch', …)`), a global, a Node built-in or a
  third-party package. The real collaborators then run on stubs at the
  boundary: `packages/google-meet/test/module.test.ts` runs the real face tab
  and the real button trail on a stub tab.

A third-party package (`@slack/web-api`, `@clack/prompts`) is fine to mock: it
has no file under `packages/`, so there is no coverage entry to overwrite.

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
| `packages/forge-github/test/setup-project.test.ts` | `@aivi/github`: `githubApp` and `runGit`, the rest is the real module | The GitHub App's grant and token, and git |
| `packages/channel-slack/test/connection.test.ts` | `@slack/web-api`: `WebClient` | The Slack Web API: auth, chat, reactions and users |
| `packages/channel-slack/test/connection.test.ts` | `@slack/socket-mode`: `SocketModeClient`, with the real `LogLevel` | The Socket Mode client: its events, start and disconnect |

The rows for `context.ts`, `registry.ts` and `@aivi/github` break the rule
above: they mock a file of ours. The coverage numbers of `packages/host/src/cli/context.ts`,
`packages/host/src/cli/registry.ts` and `packages/github/src/index.ts` are not
to be trusted until those two test files stop mocking them (the plan lists it).

The register is complete when it lists every match of
`grep -rn "mock.module(" packages/*/test`.

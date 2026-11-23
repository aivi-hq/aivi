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

## A stuck test

A stuck test fails fast. Three things see to it:

- `--test-timeout` (5 s in `node.config.json`, 8 s in `test:cov`) ends a test
  that awaits something that never comes.
- A test process still alive 10 s after its last test fails, and the message
  names what holds it open (`Timeout`, `TCPServerWrap`, `ProcessWrap`). A
  test that starts a server, a timer or a process ends it, in `t.after`. A
  host the test builds is ended with its `AbortController`: the dispatcher and
  the orchestrator disarm their clocks on it.
- The runner fails after 5 minutes (`AIVI_TEST_LIMIT_MS` moves it) and kills
  every process under it. That is what ends a test that never yields (a
  synchronous loop), which no timer in its own process can.

Both live in `scripts/test-guard.cjs`, loaded with `--require` in the `test`
scripts. It is a `--require`: the runner does not run `--import` modules, and
with `NODE_OPTIONS` set (the scripts need it) Node leaves the `nodeOptions`
of `node.config.json` out. `test-force-exit` is not set: it ends a test
process before the pipe to the runner is flushed, and 6 tests of one file
went unreported in a full run (reproduced with 3000 trivial tests and a slow
runner: 36–41 of them lost, 3 runs of 3; none lost without it).

`test:cov` fails below 100% lines, branches and functions
(`--test-coverage-*=100`): the check is on the exact total, so 100 means every
line, branch and function of every file in the report. The flags live in the
script and not in `node.config.json`, so a run of one file, which has to read
the config for the mock flag, does not fail on the files it did not load.

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
as a bare `node --test`, has no `mock.module`. Mocks are the go-to way to
test a unit, and there is no limit on how many a test file uses: use one
wherever it makes sense (the operator, 2026-11-19). What the operator asked
to use sparingly (2026-11-18) is experimental *flags*; this is the one flag
the tests use. Every use of `mock.module` is in the register below.

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
- One block is left out in the source instead: the `import.meta.main` entry at
  the end of `packages/host/src/server.ts`, between `/* node:coverage disable */`
  and `/* node:coverage enable */` (the operator, 2026-11-19). It is the file
  launchd and systemd run; no in-process test reaches a process entry, and
  `scripts/smoke.mjs` runs it live. It is the only such comment pair. Do not
  add another without asking.
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
    --require=./scripts/test-guard.cjs --test --conditions=development \
    --experimental-test-coverage packages/chrome/test/tab.test.ts | grep ' tab.ts '
  ```

  Ticket with the full record:
  `docs/backlog/coverage-total-counts-copies-of-mocked-files.md`.

Node version:

- The floor is `engines` in `package.json`, in the root and in every
  package: `>=26.12.0 <27`. The scripts read `node.config.json` through
  `--config-file`, the stable name from v26.12.0 (before that,
  `--experimental-config-file`, which stays as an alias). The option
  `test-coverage-include-all` needs v26.7.0.
- The Node docs list the `exports` option of `mock.module` from v26.1.0 on
  (checked at v26.1.0, v26.12.0, v26.13.0 and v26.13.1). The tests have run
  on 26.13.1 only.
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
| `packages/browser/test/transport.test.ts` | `@modelcontextprotocol/sdk/client/index.js`: `Client` | The MCP client the transport drives: connect, list tools, call a tool, close |
| `packages/browser/test/transport.test.ts` | `@modelcontextprotocol/sdk/client/stdio.js`: `getDefaultEnvironment`, `StdioClientTransport` | The stdio child process of the MCP server: its parameters, its stderr listener and its close |
| `packages/channel-discord/test/cli.test.ts` | `packages/channel-discord/src/index.ts` | The package door that `register` calls: `registerDiscordCommands` |
| `packages/channel-discord/test/commands.test.ts` | `discord.js`, named exports | The gateway client and REST that the module logs in and registers its slash commands through |
| `packages/channel-discord/test/module.test.ts` | `discord.js`, named exports | The gateway client and REST: login, events, channels and application commands |
| `packages/channel-discord/test/module.test.ts` | `packages/channel-discord/src/voice.ts` | The voice watcher the module starts: `watchVoice`, as a spy |
| `packages/channel-discord/test/voice-encoder.test.ts` | `@discordjs/opus` | An `OpusEncoder` that always fails (the real one cannot fail on a good frame), reached through `createRequire` |
| `packages/channel-discord/test/voice-player.test.ts` | `@discordjs/voice`: `createAudioPlayer`, `createAudioResource`, `entersState` and `joinVoiceChannel`, the rest is the real module | The voice connection and the audio player that the room's mouth plays through |
| `packages/channel-slack/test/module.test.ts` | `@aivi/host`: `ChannelEngine` and `createTurnRunner`, the rest is the real module | The engine the module builds, ticks, stops and asks to stop a turn, and the turn runner it wraps with reactions |
| `packages/cli/test/default-io.test.ts` | `packages/cli/src/mount.ts` | The installed server's modules, through `importApp`: `context`, `pluginSetup`, `pluginRemove` and `writeEditorSchema` |
| `packages/cli/test/link-io.test.ts` | `@clack/prompts`: `select` and `isCancel` | The question `aivi link` asks on a terminal |
| `packages/cli/test/main-routes.test.ts` | `packages/cli/src/add.ts`: `add`, the rest is the real module | The command `aivi add` hands its arguments and options to |
| `packages/cli/test/main-routes.test.ts` | `packages/cli/src/link.ts`: `link`, the rest is the real module | The command `aivi link` hands its arguments to |
| `packages/cli/test/main-routes.test.ts` | `packages/cli/src/mount.ts`: `mountAppCommands`, the rest is the real module | The installed app's commands that mount onto the tree |
| `packages/cli/test/main-routes.test.ts` | `packages/cli/src/remove.ts`: `remove`, the rest is the real module | The command `aivi remove` hands its arguments and options to |
| `packages/cli/test/main-routes.test.ts` | `packages/cli/src/service.ts`: the seven `service…` verbs, the rest is the real module | The verbs the `service` command dispatches to |
| `packages/cli/test/main-routes.test.ts` | `packages/cli/src/setup.ts`: `setup`, the rest is the real module | The command `aivi setup` hands its arguments and the home to |
| `packages/cli/test/main-routes.test.ts` | `packages/cli/src/update.ts`: `updateServer`, the rest is the real module | The command `aivi update` hands its options to |
| `packages/cli/test/update.test.ts` | `packages/cli/src/runtime.ts`: `ensureNode`, the rest is the real module | The managed Node that an update provisions |
| `packages/host/test/apicli-channels-command.test.ts` | `packages/host/src/cli/context.ts` | The CLI context: the loaded config, the home and the store |
| `packages/host/test/apicli-channels-command.test.ts` | `packages/host/src/cli/registry.ts` | The plugin registry that the channel commands list |
| `packages/host/test/apicli-channels-command.test.ts` | `@aivi/channel-slack/cli` | A package's own command factory, which the channels command loads by name |
| `packages/host/test/apicli-exec-door.test.ts` | `ws`: `WebSocketServer` | The exec door's WebSocket server |
| `packages/host/test/apicli-exec-door.test.ts` | `node-pty`: `spawn` | The pseudo-terminal that the door runs commands in, reached through the door's default loader |
| `packages/host/test/apicli-identity.test.ts` | `@clack/prompts`: `intro`, `outro`, `cancel`, `select`, `text` and `isCancel` | The questions of `server create` and of signing in |
| `packages/host/test/apicli-identity.test.ts` | `@aivi/core`: `clientConfigPath`, `installFace`, `installPrompts`, `loadConfig` and `writeConfigBlock`, the rest is the real module | The client record, the CLI's face and prompts, and the config it writes |
| `packages/host/test/apicli-identity.test.ts` | `@aivi/host`: the `Store` class, the rest is the real module | The people store |
| `packages/host/test/apicli-knowledge-command.test.ts` | `packages/host/src/cli/context.ts` | The CLI context: the loaded config, the store, the poke and the printer |
| `packages/host/test/apicli-knowledge-command.test.ts` | `@aivi/plugin/api` | The host client the command talks to |
| `packages/host/test/apicli-knowledge-command.test.ts` | `@aivi/knowledge`: `warmKnowledge` | The knowledge warm-up |
| `packages/host/test/apicli-people-command.test.ts` | `packages/host/src/cli/context.ts` | The CLI context: the loaded config, the store and the printer |
| `packages/host/test/apicli-people-command.test.ts` | `@aivi/plugin/api` | The host client the command talks to |
| `packages/host/test/apicli-people-command.test.ts` | `@clack/prompts`: `confirm` and `isCancel` | The confirmation question of the people commands |
| `packages/host/test/apicli-people-command.test.ts` | `packages/host/src/cli/identity.ts`: `readClientConfigToken` | The token of the signed-in client |
| `packages/host/test/apicli-plugin-setup.test.ts` | `@clack/prompts`: `intro`, `outro` and `cancel` | The setup flow's own opening and closing lines |
| `packages/host/test/apicli-plugin-setup.test.ts` | `packages/host/src/cli/context.ts`: `context` and `withStore` | The loaded config and the store |
| `packages/host/test/apicli-plugin-setup.test.ts` | `@aivi/channel-discord/setup` | A package's own setup entry, which `pluginSetup` loads by name |
| `packages/host/test/apicli-plugin-setup.test.ts` | `@aivi/core`: `print`, `upsertEnvFile` and `writeConfigBlock`, the rest is the real module | The printer, the `.env` writer and the config-block writer |
| `packages/host/test/apicli-projects-command.test.ts` | `packages/host/src/cli/context.ts` | The CLI context: the loaded config, the home and the store |
| `packages/host/test/apicli-projects-command.test.ts` | `packages/host/src/cli/project-setup.ts`: `runProjectSetup` | The project wizard |
| `packages/host/test/apicli-projects-command.test.ts` | `@aivi/core`: `removeProject` and `purgeProject`, the rest is the real module | The project removal on disk |
| `packages/host/test/apicli-prompts-command.test.ts` | `packages/host/src/cli/context.ts`: `home` and `print` | The home and the printer |
| `packages/host/test/apicli-schema-cache.test.ts` | `packages/host/src/cli/registry.ts`: `loadComposedConfig` and `pluginRegistry` | The composed config and the plugin registry that the editor schema is built from |
| `packages/host/test/apicli-serve-logging.test.ts` | `@aivi/core`: `configureLogging` and `isTty`, the rest is the real module | The logging set-up and the terminal test |
| `packages/host/test/apicli-serve-logging.test.ts` | `packages/host/src/cli/commands/channels.ts`: `registerChannels`, as a no-op | The channel commands that `serve` also registers |
| `packages/host/test/apicli-server-command.test.ts` | `packages/host/src/cli/context.ts` | The CLI context: the loaded config, the home and the store |
| `packages/host/test/apicli-server-command.test.ts` | `packages/host/src/server.ts`: `startServer` | The server the command starts |
| `packages/host/test/apicli-server-command.test.ts` | `packages/host/src/cli/schema-cache.ts`: `writeEditorSchema` | The editor schema rebuilt on start |
| `packages/host/test/apicli-server-command.test.ts` | `@aivi/host`: `connectOpenCode` and `status`, the rest is the real module | The OpenCode connection and the status call |
| `packages/host/test/process-application.test.ts` | `packages/host/src/opencode.ts`: `connectOpenCode` and `restartOpenCode` | OpenCode discovery and restart |
| `packages/host/test/process-application.test.ts` | `packages/host/src/api/app.ts`: `createApp` and `serveApp` | The HTTP app, with a listener that never binds |
| `packages/host/test/process-application.test.ts` | `packages/host/src/api/exec.ts`: `attachExec` | The exec door |
| `packages/host/test/process-application.test.ts` | `packages/host/src/orchestrator/orchestrator.ts` | The orchestrator: its constructor options, tools, `leaseEnded`, `recover`, `runBySession`, `tracker` and `wake` |
| `packages/host/test/process-runtime.test.ts` | `packages/host/src/dreaming.ts`: `dream` | The dreaming run that an operation starts |
| `packages/host/test/process-server.test.ts` | `packages/host/src/application.ts`: `runHost` | The host that the server command starts |
| `packages/host/test/process-server.test.ts` | `packages/host/src/cli/context.ts`: `context`, `home` and `withStore` | The loaded config, the home and the store |
| `packages/host/test/process-server.test.ts` | `packages/host/src/cli/registry.ts`: `buildModules` and `loadComposedConfig` | The modules and the composed config |
| `packages/host/test/process-server.test.ts` | `@aivi/knowledge`: `createKnowledgeService` | The knowledge service |
| `packages/host/test/project-wizard.test.ts` | `@aivi/core`: `print`, the rest is the real module | The printer the wizard hands a contributor |
| `packages/host/test/project-wizard.test.ts` | `packages/host/src/opencode.ts`: `connectOpenCode` | The OpenCode connection behind the lane agents |
| `packages/host/test/wtree-git-process.test.ts` | `node:child_process`: `execFile`, the rest is the real module | The promisified `execFile` behind `gitIn`, `realGit` and `globalGitConfig` |
| `packages/tracker-github/test/connection.test.ts` | `@aivi/github`: `githubApp`, the rest is the real module | The home's one GitHub App connection, which `githubClient` and the wizard's default `productionClient` are handed |
| `packages/tracker-github/test/plugin.test.ts` | `packages/tracker-github/src/module.ts`: `createGithubModule` | The module that `plugin.createModule` builds lazily |
| `packages/tracker-linear/test/module-decisions.test.ts` | `@aivi/host`: `ChannelEngine`, the rest is the real module | The engine the module builds: a subclass of the real engine records the delivery, the pool and the options it is handed |

The register is complete when it lists every match of
`grep -rn "mock.module(" packages/*/test`.

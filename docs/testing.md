# Testing

How aivi's unit tests are written, and the register of module mocks. How to
run them is in [AGENTS.md](../AGENTS.md#build-and-test).

## A unit test tests the unit

- A test calls one unit and answers everything the unit reaches: the
  prompts, a client, git, the loaded config, the plugin registry.
- Its subject is what the unit does with a person's answers and with its
  collaborators' answers. What clack draws, what git moves and what a real
  home loads belong to other units or to the live gates.
- A unit that takes its collaborators as arguments gets fakes as
  arguments. A unit that imports them gets a module mock.

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

A mock of a file under `packages/*/src` costs that file its 100%:

- Node builds the mock from generated source. It holds an
  `if (…) { throw … }` block that nothing enters. c8 maps that block onto
  the real file by its URL, so the file shows one uncovered branch near its
  first lines, in a comment or an import.
- Isolated on `packages/host/src/index.ts` (2026-11-18): a test file that
  mocks it shows the branch; the same code run by a test file that does not
  mock it shows none. The full report shows the same mark on
  `packages/host/src/cli/context.ts`, `packages/host/src/cli/registry.ts`
  and `packages/github/src/index.ts`, the files the register replaces.
- A module outside `packages/*/src` (`@clack/prompts`) has no such cost.
- For a module of ours, give the unit a parameter whose default is the real
  thing (`githubTracker(config, connect = githubClient)` in
  `packages/tracker-github/src/module.ts`) and pass a fake. Use a mock only
  when no seam can be made.

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

The register is complete when it lists every match of
`grep -rn "mock.module(" packages/*/test`.

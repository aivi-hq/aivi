# 1 · One CLI (local, primary)

Status: **landed 2026-09-27** in two shippable halves (recon below), both on
`refactor/single-cli-command`; only the D22 dev-home nuke remains. Depends:
nothing — this lands first. Unlocks: everything.
Goal: one user-facing `aivi`. Machine commands built in; every other command
loaded **in-process** from the installed app and mounted. `forward.ts` deleted,
`@aivi/app` deleted, the ctrl+c class dead at the root.

## The two halves (execution order)

The whole phase is one commit-shaped design, but it lands as two commits a
session can each finish green. Mechanics first, burial second:

- **Half 1 — the mount.** The CLI imports the installed app's CLI in-process
  and mounts its subtree on the CLI's own commander tree; `forward.ts`,
  `OWN`/`goesToApp`/`HELP_FORMS` and the `forwardIdentity`/`forwardSetup`
  spawn-relays die; the identity and plugin-setup steps become direct
  function calls into the installed code. `@aivi/app` stays where it is,
  gaining only a `registerCommands(program)` export (tree + logging hook;
  the banner and `--version` stay in its own `main`, so the CLI root keeps
  its own voice). End state: one help tree, no spawn relay, every test green.
  Mount target is `@aivi/app/dist/cli.js` for now; Half 2 repoints the path.
- **Half 2 — the move and burial.** `packages/app/src/*` relocates to
  `packages/host/src/cli/` (subpath export `./cli`); setup installs
  `@aivi/host` into `<home>/app` instead of `@aivi/app`; the plist, `update`,
  `install`'s refusal list, dev scripts, root tsconfig references and the
  packaging test repoint; `packages/app` is deleted.

Recon (2026-09-27, verified against the tree):

- **No dependency cycle**: `@aivi/knowledge` depends only on `@aivi/core` +
  qmd and never imports `@aivi/host`, so host can gain the command surface
  (which imports knowledge) cleanly. Channel packages and `@aivi/tracker-linear`
  arrive only through dynamic `import()` and resolve from `<home>/app`'s
  `node_modules` whatever package hosts the call site.
- **`@aivi/app` consumers to rewire in Half 2** (line anchors predate
  half 1 — grep for `@aivi/app` instead of trusting them): `setup.ts`
  (installs `@aivi/app` into the appDir; installed check); `service.ts:30`
  (plist `ProgramArguments` target); `update.ts` (updates the server
  package by name, reads its `package.json`/`engines`); `install.ts`
  (refuses `@aivi/app` as a plugin); `mount.ts` (Half 1's import path and
  its `No aivi server installed` error — both become `@aivi/host`); root
  `package.json` script `aivi`; `scripts/smoke.mjs:16` (spawns
  `packages/app/dist/cli.js` directly — `npm run check` smokes the host
  through it); `tsconfig.build.json` reference;
  `packages/cli/test/cli.test.ts` fixtures; `packages/app/test/cli.test.ts`
  relocates to `packages/host/test/` (it spawns `../src/cli.ts`).
  `pack-smoke.mjs` names only the CLI — untouched.
- **Machine-vs-operator decision without an OWN set**: commander already
  knows — the mounted tree's top-level command names are the machine set
  (`program.commands.map(c => c.name())`). Operator-or-unknown first args
  trigger the mount before parsing; machine commands never import app code,
  which is rule 1 below.

## The mechanism

`@aivi/cli`'s static code is the machine commands only (`setup`, `install`,
`update`, `upgrade`, `uninstall`, `service`, `link`, `version`). Home
resolution is unchanged (`AIVI_HOME` → client-config `home` → error). When an
operator command is invoked and the home is local, the CLI does what
[channels.ts](../../../packages/app/src/commands/channels.ts) already does for
plugins — a dynamic import and a mount — one level up:

```ts
// packages/cli/src/mount.ts (new, ~50 lines)
const cliPath = join(appDir, 'node_modules', '@aivi', 'host', 'dist', 'cli.js');
if (!existsSync(cliPath))
  throw new Error(`No aivi server installed at ${appDir}. Run \`aivi setup\` first.`);
const { registerCommands } = await import(pathToFileURL(cliPath).href);
registerCommands(program, ctx); // the same subtree mount plugins use
```

Three rules, and they are the whole design:

1. **Lazy import, never at startup.** App code loads only when an operator
   command actually runs. A broken app install (mid-upgrade, bad build) must
   still let `aivi update` and `aivi service` work, because machine commands
   never touch app code. This is the one property the two-binary split bought,
   and laziness keeps it.
2. **One commander tree, one help.** No `OWN` set, no `goesToApp`, no
   `HELP_FORMS`, no `aivi help X` forwarding special case. What is mounted is
   what help shows (state-based visibility arrives in
   [remote-exec.md](remote-exec.md)).
3. **Missing install = the mount-time error above**, the same sentence today's
   `appCliPath()` throws at spawn time (`forward.ts:13`).

## Deleted by this phase

- [forward.ts](../../../packages/cli/src/forward.ts) entirely (the `spawnSync`
  relay with `stdio: 'inherit'` + `AIVI_HOME` env injection).
- The `OWN`/`goesToApp`/`HELP_FORMS` dispatch in `main.ts:37-61,195-205`.
- `forwardIdentity` (`setup.ts:431-445`): the stdout-piped one-JSON-object
  contract between `aivi setup` and the hidden `server create` command. The
  identity step becomes a **direct function call** into the installed code;
  `server create` and `plugin setup` stop being hidden CLI commands.
- `@aivi/app` as a package: its command registrations move to
  `packages/host/src/cli/` exported as `@aivi/host/cli`; `serve` lives there
  too; the package's bin, README, and changeset membership die.

## `@aivi/host` gains `./cli`

The command surface (`status`, `jobs …`, `runs …`, `people …`, `projects …`,
`knowledge …`, channel subtrees) and `serve` become a subpath of host, because
they need `Store` and the composition anyway. `serve` keeps building modules
from configuration exactly as today (the if-chain is replaced in
[phase 3](plugin-registry.md), not here).

launchd is **unchanged plumbing**: the plist's `ProgramArguments` is a file
path (`service.ts:54` records `[nodePath, <appDir>/…/cli.js, serve]`), and a
file path needs no bin declaration. After this phase it points at
`<appDir>/node_modules/@aivi/host/dist/cli.js serve`. One bin on PATH: `aivi`.

## The ctrl+c receipt (why this phase is the fix)

Measured by the operator on 2026-09-27: `npm run aivi:cli -- serve` (the
relayed path) busts the terminal on ctrl+c — the screen fills with orphaned
terminal *answers* (`OSC 11 rgb:…`, `CSI 63;1R`, `CSI ?62;22;52c`) and input
stops working; `npm run aivi serve` (direct) exits clean. Something outside
node_modules asks those questions (grepped: no OSC/DA/CPR querier in
`@logtape/*`, `@clack/*`, or any dependency; the OpenCode service child runs
`stdio: ["ignore","ignore","pipe"]`) — probably the shell or terminal stack.
Whatever it is, ctrl+c on the relay hits a three-process foreground group
where the thin CLI dies instantly while the app's graceful shutdown
(`server.ts:35`) keeps the group alive, and the answers orphan. This phase
deletes the relay, so the class has no habitat. The mystery querier is **not**
claimed as ours and is not this phase's job.

## Client config

`~/.config/aivi.json` keeps every field, including `nodePath` and `appDir` —
only their consumer changes from "where to spawn" to "where to import from":

- `appDir` is where the code lives that local mode imports (default
  `${home}/app`).
- `nodePath` exists for machines with no global node satisfying aivi's
  `engines` range; setup uses it for the launchd plist and for anything it
  must exec.

## Machine commands and the packaging test

`packages/cli` stays statically standalone this phase (no `@aivi/*` imports —
that edge arrives only with `@aivi/plugin` in
[phase 2](plugin-contract.md)). The test
[packaging.test.ts](../../../packages/cli/test/packaging.test.ts) keeps its
soul with new wording: *every static import is a declared dependency; app and
host code arrives only through dynamic import from `appDir`.*

Dev scripts converge: `npm run aivi:cli` (global CLI sources) becomes the
primary dev entry for everything; `npm run aivi` stays as the direct
server-machine shortcut (`node packages/host/dist/cli.js serve …` once phase
1 lands).

## Poke, unchanged

Commands still write shared state directly and ring
`POST /v1/wake` best-effort (`context.ts:34`). The host's loop
(`application.ts:211`: `await wake.wait(store.nextDue(), …)`) treats a wake as
"re-check the queue": one query recomputes the next due instant across enabled
jobs and runs whatever is due; channel engines tick on the same wake. No
diffing, no per-job timers, no polling — and the HTTP door is only how an
outside process rings. Performance is noise: one loopback POST per write
command. Local mode keeps it exactly; relayed commands (phase 4) ring the
same bell because they run on the server anyway.

## Checklist

Half 1 — the mount:

- [x] `packages/app/src/cli.ts` — export `registerCommands(program)`: the
      command registrations, `--log-level`/`--log-format` and the logging
      preAction hook move under it; `main()` keeps program creation, version,
      banner and parsing, so the app's own bin is behavior-identical.
- [x] `packages/cli/src/mount.ts` — lazy dynamic import + mount; error text
      when the install is missing; `AIVI_HOME`/`appDir` set for the import.
- [x] Delete `forward.ts`, the OWN/goesToApp/help dispatch, `forwardIdentity`
      and `forwardSetup`; `setup`/`install` call the installed functions
      directly (identity step, `plugin setup` step).
- [x] Rewrite `packaging.test.ts` wording; lifecycle tests at the real
      boundary: mount with a present install, with a missing install, and with
      a broken install (machine commands still run).
- [x] Docs: [operations.md](../../operations.md) had no forward sentence to
      change; `packages/cli/README.md` command table and
      `packages/app/README.md` intro reworded; changeset `@aivi/cli` minor.

Half 1 landed 2026-09-27 on `refactor/single-cli-command`. What differed
from the plan while landing:

- Both entries gained an `import.meta.main` guard: importing the app's
  `dist/cli.js` must not start a second parse; the bins still run themselves
  (launchd, pack-smoke and the app tests spawn them directly).
- The logging hooks are hung on each command `registerCommands` adds, never
  on the receiving tree's root — commander passes `(hookedCommand,
  actionCommand)`, so the old root hook could never see `serve` and
  `state/logs/aivi.log` was dead code; per-command hooks fix that and leave
  a host tree's machine commands untouched. A `postAction` hook flushes
  logging in the mounted case; the flush is skipped when an action throws
  (known gap: buffered log lines can be lost on the error path).
- The machine-vs-operator decision reads `program.commands` after the
  machine tree is built — the tree itself is the set, no constant.
- `SetupIo.forwardIdentity(args…)` became `createIdentity(step, home,
  appDir)`: structured step, async, object answer — the JSON-over-stdout
  contract is gone. `InstallIo.forwardSetup` became `setupPlugin`: a stop is
  `process.exitCode` marked (the app's `pluginSetup` says its own words and
  never rejects); a hard failure is a rejection, and `install` says
  "Nothing was restarted." for both.
- `pack-smoke.mjs`'s no-home assertion still holds verbatim; only its
  "forward path" sentence was reworded.
- Live check on the dev home (a workspace-linked install, so the new code
  ran): `aivi jobs list` answered from the store in-process, `aivi --help`
  and `aivi help jobs` show one merged tree, `version`/`--version` stay the
  CLI's. Known cosmetic: `--log-level`/`--log-format` now appear in the CLI
  root's options (declared on the receiving tree's root);
  [remote-exec.md](remote-exec.md) owns state-based help trimming.

Half 2 — the move and burial:

- [x] `packages/host/src/cli/` — move `commands/*`, `context.ts`, `identity.ts`,
      `plugin-setup.ts`, `help.ts` bodies; subpath export `./cli`; host gains
      `@aivi/knowledge`, `commander`, `@clack/prompts` deps and the tsconfig
      references `@aivi/app` carried.
- [x] Setup installs `@aivi/host` (+ plugins) into `<home>/app`; plist
      `ProgramArguments`, `update.ts`, `install.ts`' refusal, `mount.ts`'s
      import path and the dev scripts repoint at `@aivi/host/dist/cli.js`.
- [x] Delete `packages/app` (bin, README, changeset membership, root tsconfig
      reference, workspace package).
- [x] `packages/app/test/cli.test.ts` relocates into `packages/host/test/`.
- [x] [CONTEXT.md](../../../CONTEXT.md) package list; changesets: **deferred
      by the operator** (see what differed) — `@aivi/app` major (removed),
      `@aivi/host` minor, fixed group come back at the end of the refactor.
- [ ] No migration (D22): `rm -rf dev` after the phase lands, `aivi setup`
      again — the dev home exists to be nuked. **Parked by the operator to
      the end of the refactor** (with the changesets): a fresh `setup` wants
      an interactive terminal, and one nuke at the end covers every
      shape-changing phase instead of one per phase.

Half 2 landed 2026-09-27 on `refactor/single-cli-command`. What differed
from the plan while landing:

- **The tsconfig references were a cycle, so the host's build is split.**
  Half 2 gives host dynamic `import()`s of `@aivi/browser`,
  `@aivi/channel-discord`, `@aivi/channel-slack` and `@aivi/tracker-linear` (the
  `serve` if-chain and `projects add --linear`), and all of those packages
  import `@aivi/host` — so host cannot reference them in *one* project
  (`error TS6202`). The split is build-plumbing only: `tsconfig.build.json`
  is the engine (`src` minus `src/cli.ts`/`src/cli`, refs core), new
  `tsconfig.cli.build.json` is the command surface (refs core, knowledge,
  the four plugins). Both emit into the same `dist/`; root `build` and the
  host's `prepack` build both. Zero source changes, all types stay real.
  Phase 3 (plugin-registry) kills the if-chain and the plugin references
  retire, so the split can collapse back to one project there.
- **No changeset in the half-2 commit, by the operator** ("changesets aren't
  needed. We're not doing a release yet. Keep these until the end of the
  refactor"). The pending `.changeset/*.md` files — including the ones
  naming `@aivi/app` (`one-cli-mount`'s `@aivi/app: minor` among them) —
  stay untouched for now; sorting them out (app's removal as a major,
  host minor, the `fixed` group) is end-of-refactor work.
- `mount.ts`'s three import sites repoint as a group: the mount
  (`dist/cli.js` — unchanged name, new package dir), setup's identity step
  (`dist/identity.js` → `dist/cli/identity.js`), install's plugin-setup step
  (`dist/context.js`/`dist/plugin-setup.js` → `dist/cli/…`). The
  `No aivi server installed` error text is verbatim.
- Docs repointed in the same commit: CONTEXT package list, README table
  (app row gone), architecture's composition-root sentence (host's `./cli`
  now), operations/people setup-plumbing wording, getting-started and
  dev/README `--app-spec` (`file:../../packages/host`), host and cli
  READMEs. `pack-smoke.mjs` stayed untouched as the recon predicted.
- **Half 2's verification is the suite, not a fresh home.** `npm run check`
  (typecheck + tests + schema:check + smoke + pack:smoke) is green, and the
  mount is tested at both ends: the host's `test/cli.test.ts` spawns the
  real command surface, the CLI's tests mount it onto the machine tree.
  The dev home is now stale by design (D22): its `app` link points at the
  deleted package and `@aivi/host` is not in `dev/app/node_modules`, so
  operator commands with `AIVI_HOME=dev` answer `No aivi server installed
  at dev/app` while machine commands still work. Recreate it in a real
  terminal at the end of the refactor — the command the dev home's own
  README carries (`npm run aivi:cli -- setup --use this-machine` with the
  local `file:` app and plugin specs) — which then proves the fresh record,
  the identity step through `dist/cli/identity.js`, and the sign-in end to
  end.

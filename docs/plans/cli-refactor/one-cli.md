# 1 · One CLI (local, primary)

Status: planned. Depends on: nothing — this lands first. Unlocks: everything.
Goal: one user-facing `aivi`. Machine commands built in; every other command
loaded **in-process** from the installed app and mounted. `forward.ts` deleted,
`@aivi/app` deleted, the ctrl+c class dead at the root.

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
   [visibility.md](visibility.md)).
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

- [ ] `packages/host/src/cli/` — move `commands/*`, `context.ts`, `identity.ts`
      bodies; export `registerCommands(program, ctx)` + the `serve` command;
      subpath export `./cli`.
- [ ] `packages/cli/src/mount.ts` — lazy dynamic import + mount; error text
      when the install is missing.
- [ ] Delete `forward.ts`, the OWN/goesToApp/help dispatch, `forwardIdentity`;
      `setup`/`install` call the mounted functions directly (identity step,
      `plugin setup` step).
- [ ] Delete `packages/app`; setup installs `@aivi/host` (+ plugins) into
      `<home>/app`; plist `ProgramArguments` points at the host dist path.
- [ ] Rewrite `packaging.test.ts` wording; lifecycle tests at the real
      boundary: mount with a present install, with a missing install, and with
      a broken install (machine commands still run).
- [ ] Scripts and docs in the same commits: [operations.md](../../operations.md)
      (CLI/forward sentences, service section), `packages/cli/README.md`
      (one command table), `packages/app/README.md` deleted,
      [CONTEXT.md](../../../CONTEXT.md) (package list, plans row).
- [ ] No migration (D22): `rm -rf dev` after the phase lands, `aivi setup`
      again — the dev home exists to be nuked.
- [ ] Changesets: `@aivi/app` major (removed), `@aivi/cli` minor, `@aivi/host`
      minor (fixed group).

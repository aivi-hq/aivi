# The CLI refactor (epic)

Status: planned (designed 2026-09-27, one long session; nothing built yet).
Goal: one `aivi` binary, one command source, plugins as plain commander
subtrees with a registered list, and remote operator access over the existing
aivi port — with the two-binary `forward` deleted, not relocated.

This is the plan of record and it supersedes
`docs/plans/operator-api.md` (deleted with this epic; the rejection
is recorded under [D2](#decision-register)). It is written to be picked up in
separate sessions: each phase is a document with its own checklist, and each
decision has one owner document. Nothing here is built until its phase lands;
until then the code and [operations.md](../../operations.md) describe today.

## Why

- The forward is local-only plumbing pretending to be transport:
  `spawnSync(node, [<appDir>/node_modules/@aivi/app/dist/cli.js, ...argv],
  { stdio: 'inherit', env + AIVI_HOME })` ([forward.ts](../../../packages/cli/src/forward.ts)).
  It never crossed a network, and remote access was still missing.
- Measured on 2026-09-27: `npm run aivi:cli -- serve` (relayed) busts the
  terminal on ctrl+c — orphaned OSC-11/CPR/DA answers, then nothing works;
  `npm run aivi serve` (direct) exits clean. The querier is not in any
  dependency (grepped `@logtape/*`, `@clack/*`, the OpenCode service spawn —
  it runs `stdio: ["ignore","ignore","pipe"]`); it lives outside node_modules.
  Either way the relay is the bug's habitat, and this plan deletes the relay.
- Two bins both named `aivi`, two help trees, and command bodies trapped
  behind an argv byte-contract made building a command abnormal.
- The remote requirement, stated by the operator: **the aivi port is the only
  way in.** People must be able to restart aivi and add a person from their
  laptops; they must not get shell access to the server.

## End state

One user-facing binary. One command mechanism for host and plugins alike.

| Package | Role |
| --- | --- |
| `@aivi/cli` | the only bin: machine commands built in; operator commands mounted in-process from the home install, or relayed to a remote host |
| `@aivi/host` | the resident program: Store, scheduler, API, module composition — plus `./cli`, the command surface `serve` composes and the CLI mounts (absorbs `@aivi/app`) |
| `@aivi/core` | vocabulary only: config envelope, shared types, logging, output. No clack, no commander, no plugin names |
| `@aivi/plugin` | the kit: setup/CLI/module contracts, prompt rule, `./api` client; kind subpaths (`./channel`, later `./tracker`) |
| `@aivi/knowledge`, `@aivi/browser`, `@aivi/channel-discord`, `@aivi/channel-slack`, `@aivi/tracker-linear` | plugins: main entry `{ moduleId, configSchema, createModule }`, `./cli`, `./setup` |
| `@aivi/opencode` | the OpenCode-side plugin (unchanged shape; imports `@aivi/plugin/api`) |

`@aivi/app` is deleted. `aivi <cmd>` in the three process states:

| State | Decided by | Operator commands |
| --- | --- | --- |
| `fresh` | no client config, no home here | none yet — help is `setup` (and `version`, `upgrade`) |
| `local` | home on this machine | in-process: dynamic `import()` of `@aivi/host/cli` from `<appDir>`, then the plugin list. Works with the host down, as today |
| `remote` | client config `url`, home elsewhere | relayed over the aivi port as a PTY byte stream |

## Phases (each is its own session)

| # | Document | Lands | Depends on |
| --- | --- | --- | --- |
| 1 | [one-cli.md](one-cli.md) | one bin; `forward.ts`, `forwardIdentity`, and `@aivi/app` deleted; host gains `./cli` | — |
| 2 | [plugin-contract.md](plugin-contract.md) | `@aivi/plugin` kit; plugins export `(ctx) => Command`; `ask` wrappers die; `@aivi/tracker-linear` rename | 1 |
| 3 | [plugin-registry.md](plugin-registry.md) | `aivi-plugins` list in `<home>/app/package.json`; per-plugin zod schemas; `state/cache/schema.json`; the hardcoded `serve` if-chain dies | 2 |
| 4 | [remote-exec.md](remote-exec.md) | `/v1/exec` websocket relay + server-side PTY; operator gate; person id + token pairing; announce-before-disconnect | 1 (2 makes it smaller) |
| 5 | [visibility.md](visibility.md) | three process states × two small command sets, commander-native | starts with 1 (fresh/local help), completes with 4 |

Phases 1–3 are the local CLI; 4 is the bolt-on. Nothing in 4 may constrain 1–3:
local execution is the primary path and stays direct and optimal.

## Decision register

Each decision lives in one document; this table is the index.

| # | Decision | Why | Owner |
| --- | --- | --- | --- |
| D1 | Remote access means the aivi port only; no shell accounts on the server | operator requirement: restart aivi and add people remotely, never roam the machine | [remote-exec](remote-exec.md#requirements) |
| D2 | The wire carries terminal bytes; commands are **not** remapped to JSON operations | the planned `POST /v1/ops/<name>` dispatcher is rejected: it would version, schema, and hand-roll every command (spinners, prompts) a normal process already gives; bytes are version-independent by construction | [remote-exec](remote-exec.md#transport) |
| D3 | Transport is a websocket upgrade on the existing HTTP server, not an embedded ssh2 server | the zero-install ssh story is dead (every remote person installs the CLI for `aivi setup` anyway); ssh2 would add a second port, host keys, a password daemon, and still need node-pty for PTY | [remote-exec](remote-exec.md#transport) |
| D4 | One bin; `@aivi/app` deleted; host exports `./cli`; launchd execs a file path | the daemon entry is a plain process, not a relay; two bins/two helps were accidents of the bootstrap split | [one-cli](one-cli.md) |
| D5 | One command mechanism: `(ctx) => Command`, everywhere | plugins already mount as data objects (`PluginCliCommand`) and pull the whole host runtime package for it; commander directly gives full expressiveness and one vocabulary | [plugin-contract](plugin-contract.md) |
| D6 | Shared kit is `@aivi/plugin` with subpaths (`./api`, `./channel`, later `./tracker`), not a package per plugin kind | per-kind packages would hold only types; subpaths give the namespaces with zero ceremony | [plugin-contract](plugin-contract.md#the-kit) |
| D7 | Plugin config schemas move from core to the plugins; core keeps core fields | core stopped knowing module names; zod composes (already a core dep) | [plugin-registry](plugin-registry.md) |
| D8 | The plugin list lives in `<home>/app/package.json` as `aivi-plugins`, array shape, disable by `["<pkg>", false]` tuple | that file is aivi-owned and already the install record; config.json then validates against a closed, complete schema. Array so the 99% case never writes `: true`; disabling is a debug op | [plugin-registry](plugin-registry.md#the-list) |
| D9 | Enablement flips: listed and not `false` enables; a config block configures, nothing more | replaces "presence of a validated block enables its module"; both error directions get sharper | [plugin-registry](plugin-registry.md#enablement) |
| D10 | The editor schema is generated into `<home>/state/cache/schema.json` on install events; the repo `schemas/` and the `npm run schema` gate are retired | composition moved to the home, so the build-time gate has nothing to check; `state/cache/` is the home's derived, rebuildable place | [plugin-registry](plugin-registry.md#editor-schema) |
| D11 | Visibility is three per-process states × two small sets (client-side, refuse-relay), rendered with commander's own `helpVisibility` | no per-command boolean grid; the transport already encodes the "server running" axis; no network probe at help time | [visibility](visibility.md) |
| D12 | The relayed child runs on a server-side PTY (`node-pty`); a non-TTY local stdout requests a non-PTY two-pipe session instead | clack, spinners, masked passwords, `isTTY`-driven formatting all work untouched; `aivi status \| jq` still gets JSON (ssh vs `ssh -t` semantics) | [remote-exec](remote-exec.md#protocol) |
| D13 | Commands that stop the host **announce before disconnecting** (print `server restarting…` to stdout, then do it); no retry, no close-reason vocabulary, no resume | it is two commands and one log line — not worth an entire mechanism; the next command discovers a host that did not come back | [remote-exec](remote-exec.md#restart--a-log-line-not-a-mechanism-decision-d13) |
| D14 | `uninstall` refuses the relay | it deletes the home and kills the relay's own parent; a footgun worth refusing | [visibility](visibility.md#the-sets) |
| D15 | The relay injects the operator's bearer into the child env (`AIVI_OPERATOR_BEARER`); the name joins the fixed token names scrubbed from task scripts' env | `whoami`/association must name the remote human, never the server's own client-config token | [remote-exec](remote-exec.md#attribution) |
| D16 | Opening an exec channel requires the `operator` role | a PTY that can run `people create` and `service` is shell-shaped; the roles store (2026-09-21) gets its first real customer | [remote-exec](remote-exec.md#security) |
| D17 | `poke` (`POST /v1/wake`) stays exactly as is | the host sleeps until `store.nextDue()`; a wake means "re-check the queue", one cheap query, no diffing; HTTP is only the cross-process door for the bell | [one-cli](one-cli.md#poke-unchanged) |
| D18 | OpenCode tools ride the existing `ToolRegistry` (`GET /tools` / `POST /tools`); moving knowledge to an optional plugin is a claims move, not new machinery | the OpenCode plugin already hardcodes no aivi tool and registers whatever the list answered at load | [plugin-registry](plugin-registry.md#follow-ups) |
| D19 | `nodePath` and `appDir` stay in the client config | `appDir` is where code is imported from in local mode; `nodePath` covers machines whose global node misses the `engines` range (and the launchd plist needs it) | [one-cli](one-cli.md#client-config) |
| D20 | Package naming: `@aivi/<kind>-<name>` | `@aivi/github` would be ambiguous (repo hub vs issue tracker); `tracker-linear` says what it is | [plugin-contract](plugin-contract.md#renames) |
| D21 | The client config carries `person.id` next to `person.token`; the host validates the **pair** on bearer resolution | guessing one high-entropy value is a search; guessing a matching person + token pair is a product of searches — one comparison multiplies the brute-force cost | [remote-exec](remote-exec.md#person-id--token-pairing) |
| D22 | No install migration, pre-1.0: `./dev` exists to be nuked — after shape-changing phases, `rm -rf dev` and `aivi setup` again | there are no existing installs; `dev/` is exactly the thing you delete | [one-cli](one-cli.md) |

## Deletion ledger (the whole epic)

Gone: `packages/cli/src/forward.ts`; the `OWN`/`goesToApp`/`HELP_FORMS`
dispatch and the `aivi help X` special case; `forwardIdentity` and the
stdout-piped JSON contract with `server create`; `@aivi/app` (bin, README,
changeset member); the hardcoded four-plugin if-chain in `serve`
(`server.ts:23-30`); `PluginCliCommand`/`PluginCliSubcommand` and the
`run(ctx, args, options)` relay in all three channel packages; the `ask`
wrappers in the CLI ctx (the setup contract already dropped them —
"two clacks animating one terminal mangle each other", measured 2026-09-27);
`discordConfigSchema`/`linearSchema`/`browserConfigSchema` in core; the repo
`schemas/` + `scripts/schema.mjs` + its `npm run check` gate; plugin →
host runtime imports; core's `@clack/prompts` dependency.

Added: the dynamic mount in the CLI (~50 lines); the `aivi-plugins` loop in
`serve`; `@aivi/plugin` (mostly moved code, not new); the exec relay endpoint
(~200) and the client relay (~150) — the only genuinely new feature.

## Deliberately out of scope

- Making `serve` itself remote (the server is the thing being driven).
- A second config format for remote homes; the home is the home.
- Mid-command reconnect, resume, or output replay — a dropped link is a
  clean error, like ssh.
- Install migration for existing homes (D22): `./dev` gets nuked, everything
  else does not exist yet.
- Per-command metadata beyond the two small sets; no boolean grids.
- TLS on the aivi port (the bearer already travels plain HTTP today; the
  non-loopback bind warning is the stated risk). Rate-limiting the whole
  front door stays an idea in
  [request-rate-limiting](../../backlog/request-rate-limiting.md); phase 4
  brings only its own small throttle at the exec door.

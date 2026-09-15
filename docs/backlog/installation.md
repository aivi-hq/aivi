# Installation, updates, and running as a service

Status: needed before anyone else installs aivi. Decide the distribution
channel first; the rest follows from it.

## Goal

A developer who has never heard of aivi (or OpenCode) can get a running
installation on a Mac (later Linux) from a short page of instructions, keep it
updated, and run it unattended.

Owner's requirements (2026-09-14):

- No `npm ci && npm run build` on the target machine. Install and update must
  be as easy as Hermes/OpenClaw: an install script, then `aivi update`.
- Everything scoped under `~/.aivi/` (config, `.env`, state, logs).
- An interactive first run: when `opencode` v2 is missing, ask whether aivi
  should install it; if declined, exit with "OpenCode v2 is a hard requirement
  and must be on your PATH".
- Projects are git repositories checked out on the server. aivi's config lists
  them (knowledge sources, later Linear mapping); plugins must not need their
  own copies of that config. Agents work inside those checkouts.

## What the install must produce

1. OpenCode v2 installed and its background service running (`opencode service`).
2. aivi installed with its native dependencies (QMD → `better-sqlite3`,
   `node-llama-cpp`, tree-sitter; Chrome DevTools MCP for browser control).
3. An `aivi.json`, a `.env` with secrets, at least one agent directory
   (librarian) with the aivi plugin configured.
4. aivi running at login and restarting on failure (launchd on macOS,
   systemd user unit on Linux).
5. A way to update and to roll back.

## Options for distribution

| Option | Pros | Cons |
| --- | --- | --- |
| npm package (`npm i -g aivi`) | Familiar; `npm update -g`; dist-tags give channels (`latest`, `next`) | Needs Node preinstalled; native deps compile or need prebuilds; global installs are fragile |
| GitHub Releases + install script (`curl … \| sh`), like OpenCode itself | Self-contained tarball per platform; channels via release tags/prereleases; `aivi upgrade` can check GitHub | We build and host binaries; need a bundler (Node SEA or bun-style single executable) and prebuilt native modules |
| Homebrew tap | Mac-native, handles updates | Formula maintenance; Linux later needs another path |
| Both npm and Releases | npm for developers, script for operators | Two pipelines |

Leaning: **GitHub Releases as the source of truth, published from CI on tags**,
with an install script and an `aivi upgrade` command that follows a configured
channel (`stable` = latest release, `main` = latest prerelease built from the
default branch). Optionally also publish to npm from the same workflow.

## Open questions

- Single executable or a Node-based tarball? Node's SEA cannot bundle native
  addons; a tarball with a pinned Node (or requiring Node ≥ 26) is simpler.
- How much of OpenCode installation does aivi do? "Express install" could run
  OpenCode's installer and `opencode service start`; the default should only
  verify and print instructions.
- Where config and state live for an installed copy: done (2026-09-15).
  The CLI reads one home, `~/.aivi/` or `AIVI_HOME` (`aivi.json` or
  `aivi.local.json`, `.env`, `state/`); there is no config-path option.
  `aivi init` should write a starter config and a librarian agent directory
  there.
- Service management is optional: `aivi serve` is a plain foreground process.
  `aivi service install|start|stop|status|logs` wrapping launchd/systemd is a
  convenience for unattended machines, mirroring OpenCode's `service` command.
- Update safety: schema migrations are forward-only today; rollback means
  restoring the SQLite file. Should `aivi upgrade` snapshot state first?
- Verifying downloads: checksums/signatures for release assets.
- Plugin distribution: the OpenCode plugin must be installable in a
  developer's own OpenCode (`opencode plugin add …`), independent of the host
  install. That argues for publishing `@aivi/opencode` to npm.

## First step

Write `docs/install.md` as the target user experience (commands a newcomer
types, in order), then build the pieces that make that page true.

## Research

Gathered 2026-09-14 from the sources named below; OpenCode facts are from the v2 docs only
(`/v2/docs/cli/service` and `/v2/docs/service` return 404, so service behaviour comes from
`/v2/docs/cli` and `/v2/docs/troubleshooting`).

### OpenCode v2 install and upgrade — https://opencode.ai/v2/docs/, https://opencode.ai/v2/install, https://opencode.ai/v2/docs/cli, https://opencode.ai/v2/docs/troubleshooting

- Supported installs: `npm install -g @opencode/cli` (trusted postinstall picks the
  platform binary), bun/pnpm/yarn equivalents, `curl -fsSL https://opencode.ai/v2/install | bash`,
  Docker `ghcr.io/anomalyco/opencode:<version>`. Homebrew, AUR, Windows package
  managers and standalone binaries are explicitly not supported.
- The install script is fully non-interactive: no prompts, `set -euo pipefail`, flags
  `--version <v>` (or `VERSION=` env), `--binary <path>`, `--no-modify-path`. It puts the
  binary at `~/.opencode/bin/opencode`, writes an `opencode2` shim next to it, appends a
  PATH line to the shell rc unless `--no-modify-path`, and honours `GITHUB_ACTIONS`.
- Version resolution: `https://opencode.ai/update/api/beta/cli/npm` returns
  `{version, package}`; the script then downloads `@opencode/cli-<os>-<arch>[-baseline][-musl]`
  straight from `registry.npmjs.org` as a `.tgz`. Re-running the script is the upgrade path
  for curl installs (it prints the installed version, then overwrites). No signature or
  checksum verification is performed beyond HTTPS.
- Another tool can therefore install or upgrade OpenCode non-interactively by running that
  script with `--no-modify-path` and an optional `--version`, then `opencode service start`.
  Whether a first-party `opencode upgrade` subcommand exists in v2 was not confirmed on the
  pages read; verify with `opencode --help` locally before relying on it.
- Service: one shared background server per user, started on demand; `opencode service
  status|start|stop|restart`, `opencode api get /api/status`. Registration in
  `~/.local/state/opencode/service.json`, DB `~/.local/share/opencode/opencode.db`, log
  `~/.local/share/opencode/log/opencode.log`; `opencode debug paths <selector>` prints them.
- `opencode uninstall [--dry-run|--keep-config|--keep-data|--force]` stops services and
  removes shared data; curl installs delete the binary manually.

### OpenCode v2 plugin distribution — https://opencode.ai/v2/docs/plugins

- Plugins are declared in `opencode.json(c)` `plugins: [...]` as npm names (version, tag or
  range), `{package, options}` objects, or local paths; arrays from `~/.config/opencode/`,
  `./`, and `./.opencode/` merge lowest to highest precedence. Auto-discovery also loads
  `.opencode/plugins/` and `~/.config/opencode/plugins/`.
- CLI for global package plugins: `opencode plugin add <spec>`, `plugin list [--builtin]`,
  `plugin check`, `plugin update [pkg]`, `plugin remove <spec>`. `add` accepts npm specs and
  npm-compatible Git specs (`github:acme/plugin`, `git+ssh://…#main`,
  `github:acme/plugins#main::path:packages/opencode-plugin`), including private repos via
  existing Git credentials. Tarball and alias targets are rejected.
- Server startup loads cached package plugins immediately, installs missing packages in the
  background, checks unpinned npm/Git plugins for updates; exact versions and full commit
  hashes stay pinned. Config changes reload; layout changes need `opencode service restart`.
- Implication for `@aivi/opencode`: it depends on `@aivi/host` and `@aivi/core` by version,
  so a Git spec alone will not resolve them; the plugin and its workspace dependencies have
  to be on npm.

### Hermes Agent — https://hermes-agent.nousresearch.com/docs/getting-started/installation, https://hermes-agent.nousresearch.com/docs/getting-started/updating

- `curl -fsSL https://hermes-agent.nousresearch.com/install.sh | bash` (flags such as
  `--skip-browser`). Only prerequisite is `git`; the script installs uv, Python 3.11,
  Node 26 (downloaded as `.tar.xz` when a compatible system Node is missing), ripgrep, ffmpeg.
- Layout: source checkout at `~/.hermes/hermes-agent/`, venv inside it, launcher symlink
  `~/.local/bin/hermes`, all data/config in `~/.hermes/` (`config.yaml`, `.env`, `auth.json`,
  `logs/`, `state-snapshots/`).
- `hermes update` = pre-update state snapshot (`updates.pre_update_backup: quick|full|off`),
  `git pull origin main`, syntax check with `git reset --hard <pre-pull-sha>` on failure,
  `uv pip install -e ".[all]"`, config migration prompts, drain-first gateway restart via
  systemd/launchd, receipts in `~/.hermes/logs/update_receipts/`, output mirrored to
  `~/.hermes/logs/update.log`, SIGHUP ignored.
- Channels are branches: `hermes update --branch <name>`; `--check` previews, `--plan` dry-runs.
  Rollback is `git checkout <tag|sha>` + reinstall. Install method is auto-detected from the
  layout; Docker/Nix installs refuse `hermes update` and print the right command.

### OpenClaw — https://docs.openclaw.ai/, https://docs.openclaw.ai/install, https://docs.openclaw.ai/install/updating

- `curl -fsSL https://openclaw.ai/install.sh | bash` (`--no-onboard`, `--install-method git
  --version main`) detects OS, installs Node (26 on macOS, 24 LTS on Linux) if missing,
  installs the `openclaw` npm package, launches onboarding. A second script,
  `install-cli.sh`, keeps Node and OpenClaw under a local prefix (`~/.openclaw`).
- Manual path is a plain global npm install: `npm install -g openclaw@latest
  --allow-scripts=openclaw` (npm 12 blocks lifecycle scripts by default), or pnpm/bun with
  their trust flags. Config lives at `~/.openclaw/openclaw.json`.
- Service: `openclaw gateway install` writes a LaunchAgent (macOS) or systemd user unit
  (Linux); `openclaw gateway status|restart`, `openclaw doctor`, `openclaw health`.
- `openclaw update` detects install type (npm/pnpm/bun/git), stages the candidate, runs a
  canary boot on copied state on a temporary port while the old Gateway keeps serving, then
  swaps, migrates, restarts and verifies; `--dry-run`, `--json`, `update status`, `update repair`.
  Failed verification rolls the package back automatically; crossing a state-schema bump
  needs a pre-update backup.
- Channels are npm dist-tags and Git: `--channel stable|beta|extended-stable|dev`; the choice
  is persisted as `update.channel`. `dev` switches to a moving GitHub `main` checkout.

### Node SEA — https://nodejs.org/api/single-executable-applications.html

- Stability 1.1; `node --build-sea sea-config.json` (v25.5+) builds the executable directly,
  CommonJS or ESM main, optional snapshot/code cache, embedded assets.
- Inside a SEA, `require`/`import` only reach built-ins; filesystem modules need
  `module.createRequire()`. Native addons work only by embedding each `.node` file as an
  asset, writing it to a temp file and `process.dlopen()`-ing it. Every addon here
  (better-sqlite3, sqlite-vec, node-llama-cpp, tree-sitter grammars) would need that shim,
  and node-llama-cpp also ships a `llama.cpp` shared-library tree.
- CI-tested only on Windows, macOS arm64 (x64 skipped) and glibc Linux; macOS binaries must
  be re-signed. Judgement: high effort, brittle for this dependency set.

### Native addons in the dependency tree — https://github.com/WiseLibs/better-sqlite3/releases, https://github.com/withcatai/node-llama-cpp, `package-lock.json`

- `@tobilu/qmd` 2.8.3 pulls `better-sqlite3 ^13.0.3`, `node-llama-cpp 3.20.0`, `sqlite-vec 0.1.9`
  (platform packages for darwin/linux arm64+x64, windows-x64), and `tree-sitter-{go,python,
  rust,typescript}` grammars via `node-gyp-build` (prebuilds in the tarball, compile
  fallback). All are `optional` in the lockfile.
- better-sqlite3 13.0.0 (2026-07) moved to N-API; prebuilt binaries ship inside the npm
  package (no `prebuild-install`) and work across Node versions; unmatched platforms compile
  via node-gyp. 12.10.0 added Node 26 prebuilds.
- node-llama-cpp: pre-built bindings for macOS (Metal), Linux and Windows, with a fallback to
  downloading a `llama.cpp` release and building with `cmake` (no node-gyp/Python);
  `NODE_LLAMA_CPP_SKIP_DOWNLOAD=true` disables the fallback.
- Net: on darwin-arm64 and linux-x64/arm64 a plain `npm install` on the target should need
  no compiler, provided lifecycle scripts are allowed for these packages. Whether QMD's
  postinstall downloads embedding models was not checked.

### Distribution options compared

| Option | Effort now | Update path | Native addons |
| --- | --- | --- | --- |
| npm publish + install script that runs `npm install` into `~/.aivi` | Low: flip `private`, add a publish workflow | dist-tags (`latest`, `next`) via `npm view`; versioned dirs + symlink swap | Prebuilds fetched by npm on the target; compile fallback if missing |
| GitHub Releases per-platform tarball (node_modules + pinned Node) | Medium: matrix build, tar, checksums, release notes | Releases API `releases/latest` vs prerelease tag; same swap | Baked in at CI; must build per OS/arch and keep Node ABI in sync |
| Node SEA single binary | High | Same as tarball | Manual `dlopen` shim per addon; llama.cpp libs outside the binary |
| Homebrew tap | Medium; formula per release | `brew upgrade` | Formula would still `npm install`; Linux needs another path |

Self-update patterns seen: resolve the target (npm dist-tag or GitHub Releases API, channels
via tags/prereleases), install into a fresh directory, verify by running the new binary,
atomically switch a `current` symlink, restart the service, keep N previous directories for
rollback, snapshot state before schema-changing updates, write a receipt/log.

launchd basics for later (general knowledge, not fetched this pass): a user agent is a
plist in `~/Library/LaunchAgents/` with `Label`, `ProgramArguments` (absolute paths; agents
do not inherit the shell PATH), `RunAtLoad`, `KeepAlive`, `WorkingDirectory`,
`StandardOutPath`/`StandardErrorPath`, `EnvironmentVariables`; managed with `launchctl
bootstrap gui/$UID <plist>`, `bootout`, `kickstart -k`, `print`. OpenClaw and Hermes use
this shape on macOS and a systemd user unit on Linux.

## Recommendation

Publish to npm, install with a script into `~/.aivi/`, update by installing the next
version beside the current one and swapping a symlink. This is the OpenClaw shape
(npm as artifact store, local prefix, channels = dist-tags) with the Hermes layout
(everything under one dot-directory). No per-platform build matrix, bundler or SEA
work; npm downloads the N-API prebuilds.

### Plan

1. Make the workspace publishable: `private: false` on all `@aivi/*` packages, `files:
   ["dist", "server.js"]`, `publishConfig.access: public`; rename the CLI package to `aivi`.
   `@aivi/knowledge` keeps `@tobilu/qmd` optional so an install without compilers succeeds.
2. Release workflow: on tag `v*` run `npm ci && npm run check`, then
   `npm publish -ws --provenance` with dist-tag `latest` for `vX.Y.Z` and `next` for
   `vX.Y.Z-<pre>`. The install script and `docs/install.md` ship from the same tag.
3. `install.sh` (`curl -fsSL <raw url>/install.sh | bash`):
   - create `~/.aivi/{bin,node,versions,state,logs,agents}`; never overwrite `aivi.json`/`.env`;
   - ensure Node 26: use `node` on PATH if it satisfies `>=26 <27`, else download the
     official nodejs.org tarball for `darwin-arm64|darwin-x64|linux-x64|linux-arm64` into
     `~/.aivi/node/` (as Hermes does); no Homebrew, no sudo;
   - `npm install --prefix ~/.aivi/versions/<v> --omit=dev aivi@<v>` with lifecycle
     scripts allowed for `better-sqlite3`, `node-llama-cpp`, `tree-sitter-*`, `@tobilu/qmd`;
   - write `~/.aivi/bin/aivi` (execs `~/.aivi/node/bin/node
     ~/.aivi/current/node_modules/aivi/dist/cli.js "$@"`), point `~/.aivi/current` at the
     new version, add `~/.aivi/bin` to the shell rc unless `--no-modify-path`;
   - flags `--version`, `--channel stable|next`, `--no-modify-path`, `--install-opencode`,
     `--no-onboard`; then run `aivi init` unless `--no-onboard`.
4. `aivi init` (TTY-aware): check `opencode --version` for major 2. If absent and stdin is
   a TTY, ask "Install OpenCode v2 now? [Y/n]"; on yes run
   `curl -fsSL https://opencode.ai/v2/install | bash -s -- --no-modify-path` (optionally
   `--version` pinned to the tested release) then `opencode service start`; on no, or when
   not a TTY without `--install-opencode`, exit 1 with "OpenCode v2 is a hard requirement
   and must be on your PATH". Then write `~/.aivi/aivi.json` (projects, knowledge sources,
   `host.auth.mode: token`), `~/.aivi/.env` (0600, generated `AIVI_TOKEN`), and
   `~/.aivi/agents/librarian/opencode.jsonc` listing `"@aivi/opencode@<same version>"`.
5. `aivi doctor`: Node version, OpenCode major 2 + `opencode service status`, plugin present
   (`opencode plugin list`), native modules load, `~/.aivi` permissions, service unit state.
6. `aivi service install|start|stop|status|logs` (macOS first): plist
   `~/Library/LaunchAgents/ai.aivi.host.plist` running `~/.aivi/bin/aivi
   ~/.aivi/aivi.json serve` with `KeepAlive`, `RunAtLoad`, logs in `~/.aivi/logs/`, explicit
   `PATH` containing `~/.opencode/bin` and `~/.aivi/node/bin`. Linux: systemd user unit
   plus a `loginctl enable-linger` hint.

### File layout under `~/.aivi/`

```
~/.aivi/
  aivi.json            config (projects, knowledge sources, modules)
  .env                 secrets, 0600
  bin/aivi             launcher on PATH
  node/                private Node 26 (absent when system Node 26 is used)
  current -> versions/0.3.0
  versions/0.2.1/      previous release kept for rollback
  versions/0.3.0/node_modules/aivi/...
  agents/librarian/    OpenCode project dir: opencode.jsonc, AGENTS.md
  state/               SQLite queue/knowledge indexes, host.json (url + token, 0600)
  logs/                serve.log, update.log, receipts/
```

### What a newcomer types

```sh
curl -fsSL https://raw.githubusercontent.com/<org>/aivi/main/install.sh | bash
# answers: install OpenCode v2? [Y] -> writes ~/.aivi/aivi.json, .env, agents/librarian
aivi doctor
aivi service install      # or: aivi serve (foreground)
opencode ~/.aivi/agents/librarian
```

Later: `aivi update`, `aivi update --channel next`, `aivi rollback`, `aivi service logs`.

### How `aivi update` works

1. Read `update.channel` from `~/.aivi/aivi.json` (default `stable`); resolve the target
   with `npm view aivi@latest version` (or `@next`). `--check` stops here; an equal version
   is a no-op unless `--force`.
2. Snapshot `~/.aivi/state/*.db` and `aivi.json` to `~/.aivi/state/snapshots/<ts>/`
   (schema migrations are forward-only, so this is the rollback for state).
3. `npm install --prefix ~/.aivi/versions/<target> --omit=dev aivi@<target>`; on failure
   delete the directory, leave `current` untouched, exit non-zero.
4. Verify: run the new tree's `cli.js --version` and `config check` against the live config.
5. Stop the service, `ln -sfn` a temp link then `mv -T` over `current` (atomic), start the
   service, probe the host API; on probe failure re-point `current` to the previous version
   and start again. Keep the two most recent `versions/`; write
   `~/.aivi/logs/receipts/<ts>.json` and mirror output to `logs/update.log`.
6. Run `opencode plugin update @aivi/opencode` and remind about project-scoped pins.

`aivi rollback` is step 5 in reverse plus a state restore prompt when the snapshot's
schema version differs.

### How `@aivi/opencode` reaches developers

- Same npm publish. A developer runs `opencode plugin add @aivi/opencode@^0.3` (global) or
  adds `"@aivi/opencode"` to a project's `opencode.jsonc`; OpenCode installs and later
  updates it (`opencode plugin update`). Pin exact versions in `~/.aivi/agents/*` so the
  host-managed agents move in lock-step with `aivi update`.
- The plugin must not carry its own copy of aivi's configuration: at `setup()` it reads
  `~/.aivi/state/host.json` (url + token, written by `aivi serve`, 0600), falling back to
  `AIVI_URL`/`AIVI_TOKEN` env for remote hosts. Everything else (projects, sources) comes
  from the host API at call time.
- Git specs (`opencode plugin add 'github:<org>/aivi#main::path:packages/opencode'`) only
  work once `@aivi/host` and `@aivi/core` for that version exist on npm.

### Defer

- GitHub Releases tarballs with bundled Node and `node_modules` (only if npm-on-target proves
  unreliable), Node SEA, Homebrew tap, Windows, checksums beyond npm provenance, an
  OpenClaw-style canary boot, an auto-update timer, chat-triggered `/update`.

### Uncertainties to verify before writing `docs/install.md`

- Whether OpenCode v2 has an `opencode upgrade` subcommand; the pages read only show
  re-running the installer or the package manager. Check `opencode --help` on 2.0.3.
- Whether `@tobilu/qmd`'s postinstall downloads models or needs compilers on a clean macOS
  without Xcode CLT; test the script in a fresh user account and on Ubuntu without
  `build-essential`.
- npm 12 lifecycle-script policy: confirm the flag (`--allow-scripts=<pkg>` per OpenClaw's
  docs) and that Node 26's bundled npm applies it to `--prefix` installs.
- How OpenCode installs plugin packages (bun or npm) and that a plugin with pure-JS
  dependencies avoids native builds inside OpenCode's cache; only a local directory plugin
  has been verified so far (docs/opencode.md).
- The swap replaces `current` while `serve` may hold files open: the plan stops the service
  first; confirm launchd `KeepAlive` does not restart it mid-swap.

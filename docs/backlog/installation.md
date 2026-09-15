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
- Where config and state live for an installed copy: decided, `~/.aivi/`
  (`aivi.json`, `.env`, `state/`), the Hermes/OpenClaw convention. The CLI
  already loads `~/.aivi/.env`. `aivi init` should write a starter config and
  a librarian agent directory there.
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

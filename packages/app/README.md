# @aivi/app

The installed server: the `aivi` binary that composes configured modules
and launches the host. The thin CLI (`@aivi/cli`) forwards every operator
command here. `aivi serve` starts the host with Discord, Slack, and
Linear modules; the other commands talk to the running host or the SQLite
store directly.

## Entrypoint

`dist/cli.js` — the `aivi` bin the CLI installs into the home.

## Commands (run inside the app)

`serve`, `status`, `config check`, `jobs …`, `runs …`, `people …`,
`projects …`, `sources`, `knowledge search|index`, `discord …`,
`slack …`, `linear …`.

## Docs

[operations](../../docs/operations.md) ·
[architecture](../../docs/architecture.md)

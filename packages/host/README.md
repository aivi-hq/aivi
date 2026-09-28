# @aivi/host

The engine: lifecycle, HTTP API, scheduler, SQLite store, capacity leases,
OpenCode connection, session driver, dreaming, the channel module contract
(shared inbox, engine, turn runner), and report routing. One process, one
truth. It parses no argv: `./cli` is the command surface the `@aivi/cli` bin
collects, and `./server` is the boot — what the `serve` command runs
in-process, and what launchd/systemd run directly.

## Exports

| Path | Contents |
| --- | --- |
| `@aivi/host` | `runHost`, `Store`, scheduler, session driver, channel machinery, operations registry |
| `@aivi/host/cli` | the command surface the CLI collects: `serve`, `status`, `jobs`/`runs`, `people`, `projects`, `knowledge`, the channel subtrees — and `registerCommands`, the mount `@aivi/cli` hangs them on |
| `@aivi/host/server` | the server boot: loads configured modules and launches `runHost`; run the file directly (no argv) or call `startServer()` |
| `@aivi/host/client` | `createHostClient` — the HTTP client the OpenCode plugin and CLI use to reach the host |

## Key contracts

- **Module**: claims operation names at `start`, provides `jobs(config)` to
  seed scheduled work, receives a `HostServices` bag.
- **Channel module**: implements `ChannelModule` (gateway, routing, sending,
  commands); the host owns the inbox, bindings, engine, and turn runner.
- **Operations**: named functions claimed exactly once at composition; the
  scheduler fires `invocation` tasks by name.

## Docs

[architecture](../../docs/architecture.md) ·
[operations](../../docs/operations.md) ·
[channels](../../docs/channels.md)

# @aivi/host

The engine: lifecycle, HTTP API, scheduler, SQLite store, capacity leases,
OpenCode connection, session driver, dreaming, the channel module contract
(shared inbox, engine, turn runner), and report routing. One process, one
truth.

## Exports

| Path | Contents |
| --- | --- |
| `@aivi/host` | `runHost`, `Store`, scheduler, session driver, channel machinery, operations registry |
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

# @aivi/core

Shared foundation: config and access-policy schemas, knowledge kinds,
module contracts, and the logger. Every other aivi package depends on this
one.

## Exports

| Path | Contents |
| --- | --- |
| `@aivi/core` | Config schema (zod), logger, contracts (`HostModule`, `HostServices`, `Store`, `ChannelModule`, `Person`, `Job`, `Run`, …) |
| `@aivi/core/kinds` | Knowledge source kinds (`doc`, `decision`, `memory`, `conversation`) |

## Dependencies

`zod` for schemas, `croner` for cron expressions, `@logtape/*` for
structured logging.

## Docs

[configuration](../../docs/configuration.md) ·
[architecture](../../docs/architecture.md)

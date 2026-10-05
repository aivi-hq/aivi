---
'@aivi/core': minor
'@aivi/cli': minor
'@aivi/host': minor
'@aivi/opencode': minor
---

**The client record moves to `~/.config/aivi/config.json`.** One
`aivi.json` file among unrelated tools' files became a directory of its
own, which is also where a plugin's secrets can live out of every
agent's reach (the forge's .pem placeholder now names it). The path is
now one fact in core — `clientConfigPath()` — that the host and the
OpenCode plugin share; the CLI keeps its own computation, because the
CLI may not import core (the packaging test is that wall). `AIVI_CONFIG`
and `XDG_CONFIG_HOME` precedence is untouched. No migration: fresh
homes write the new path and nothing reads the old one.

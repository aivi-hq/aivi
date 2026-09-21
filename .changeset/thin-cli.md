---
'aivi': minor
---

New: the thin `aivi` CLI. `aivi server create` writes the home structure,
checks Node, installs `@aivi/app` plus chosen `--plugin` packages into
`<home>/app`, records the installation in `~/.config/aivi.json`, then hands
identity setup to the installed app's own `server create`. Every other
command forwards into the installed app with `AIVI_HOME` set; the CLI never
imports host code. `update` and `upgrade` arrive with the first release.

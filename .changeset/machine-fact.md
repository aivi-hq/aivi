---
'@aivi/cli': minor
'@aivi/host': minor
'@aivi/plugin': minor
---

The CLI stays in its lane: it resolves the one machine fact — a home here, or none — once per run, shows it in the help header (`home: ~/.aivi` / `home: none`), and injects it into every command provider: `registerCommands(program, machine)` and the new `PluginCliContext.machine`. Providers decide membership themselves: a machine without a home registers only what it can do there (`setup`, `upgrade`, `uninstall` — the exit ramp exists wherever the CLI is), and a typed command it does not have is honestly `unknown command`. Nothing is hidden after the fact anymore. The logging options `--log-level`/`--log-format` moved off the root onto `serve`, the command that actually logs, so a provider never pollutes commands that are not its own.

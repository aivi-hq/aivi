---
"@aivi/cli": minor
"@aivi/app": minor
---

One command tree: the thin CLI now mounts the installed app's operator
commands **in-process** — a dynamic import of the app's `registerCommands`
onto the CLI's own commander tree — instead of spawning the app's CLI per
command. `aivi --help` shows machine and operator commands together, ctrl+c
hits one process instead of a three-process group, and the identity and
plugin-setup steps are direct calls into the installed code. Machine
commands still never load app code: a half-installed or broken app install
shows the machine help with a one-line notice, and `aivi update` and the
service commands still work. `@aivi/app` gains the `registerCommands`
export and runs its own bin only when executed directly; its logging hooks
now hang on each operator command, so the machine commands a host tree
builds are untouched by them — and `aivi serve` finally gets the
`state/logs/aivi.log` file its documentation always promised (the old
root-registered hook could never see the action's name).

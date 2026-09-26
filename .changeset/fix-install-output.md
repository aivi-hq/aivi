---
"@aivi/app": patch
---

`aivi install discord|slack|browser` no longer dumps the setup result object to the terminal before the closing line. The plugin setup command is interactive (it requires a terminal and `aivi install` reads only its exit status and the module's own state), so its outro is the only human output; the machine-readable record it printed is unconsumed and was rendered as a raw `util.inspect` object on a terminal.

---
'@aivi/core': minor
'@aivi/app': minor
'@aivi/browser': minor
'@aivi/cli': minor
---

The browser is now an opt-in install, not core. The `browser` block no longer prefaults: a fresh home has no browser and the plugin never sees an `aivi_browser` tool. `aivi install browser` puts `@aivi/browser` into the server home and its `./setup` writes the launch block; a configured block with a missing package names the command that fixes it.

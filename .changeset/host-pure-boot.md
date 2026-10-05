---
'@aivi/host': patch
'@aivi/cli': patch
---

The host went pure: it parses no argv. `@aivi/host/server` is the boot — it loads the modules from the plugin list and runs `runHost`, and launchd/systemd units now point at `dist/server.js` with no `serve` argument; the `serve` command calls the same boot in-process. `@aivi/host/cli` exports `registerCommands` alone: what the host *provides*, while `@aivi/cli` is the one that *collects* — commander lives in exactly one tree, the bin's, on every path. The host's self-boot entry and its `rootBanner` are gone; the banner belongs to the bin alone.

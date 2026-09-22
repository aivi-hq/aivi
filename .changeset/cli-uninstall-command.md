---
'@aivi/cli': minor
---

`aivi uninstall` deletes what aivi created on this machine and then the CLI itself. It is not interactive: it prints the absolute paths it would delete — the home, the client config, the background service, aivi's OpenCode plugin, and this CLI with the install method that answers for it — and deletes nothing until `--confirm`. Only a home with a `config.json` in it is ever deleted, so a wrong `AIVI_HOME` or a stale `home` field deletes nothing. The service goes before the home, `opencode plugin remove @aivi/opencode` goes with it, and `opencode-attribution` stays unless `--with-attribution`. `aivi upgrade` and `aivi uninstall` read one install-method table (npm today), so they can never disagree about what is installed.

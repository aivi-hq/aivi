---
'@aivi/cli': minor
'@aivi/app': minor
'@aivi/core': minor
'@aivi/channel-discord': minor
'@aivi/channel-slack': minor
---

`aivi install discord|slack|NPM-SPEC` adds a plugin to the server home and lets it configure itself, replacing the manual config entry for the channels. npm installs the package into `<home>/app` (`--save-exact`, so `aivi update` carries it along), then the plugin's own `./setup` entry runs: it prints how to create the platform app, asks for the tokens (hidden), verifies each against the platform before anything is written — Discord's application id is derived from the bot, Slack's tokens answer `auth.test` and `apps.connections.open` — and writes its `modules.*` block into `config.json` and its secrets into `.env` (0600, never echoed; a write that leaves the config unloadable is restored). Then aivi restarts and the command ends in a verified truth: the module's own state from `/v1/status` ("Discord is running."). An already configured module is never clobbered, a foreground server is never restarted behind the operator's back, and a package without a `./setup` export is still installed, told as having no setup command. The contract is one subpath — any package exporting `./setup` with a default function installs this way; the plumbing (`aivi plugin setup SPEC`, not person-facing) and the write helpers (`writeConfigBlock`, `upsertEnvFile`) live in the app and core packages.

---
'@aivi/core': minor
'@aivi/host': minor
'@aivi/tracker-linear': minor
'@aivi/forge-github': minor
'@aivi/cli': minor
---

**Self-knowledge — the assistant knows the installation and can change it.**
A fifth knowledge kind, `manual`: core's `loadConfig` reads the `aivi-plugins`
list in `<home>/app/package.json` and indexes every listed package's `docs/`
directory as a knowledge source, in place — no copying, so the file keeps its
one owner and `aivi upgrade` refreshes the words along with the code. A
disabled plugin's docs still index; the package tag lives in the source id
(`manual:<package>`). `@aivi/host` ships `configuration.md` in its own docs
and the Linear and GitHub forge chapters now live with the plugins whose
schemas they own.

`aivi_config` is the doing side: read the live `config.json` as written,
write one block validated against the composed closed schema (a refusal
restores the previous bytes and says why), or remove one. The answer says
how the change lands. The gate is the claim — `host.agentConfigEdits`, on by
default; `false` and the tool is simply absent.

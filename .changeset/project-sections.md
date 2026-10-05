---
'@aivi/core': minor
'@aivi/host': minor
'@aivi/plugin': minor
---

Plugins can now contribute **project-section schemas**. A plugin's
`./config` declaration carries optional `projectSchema` and
`projectDefaultsSchema`; the registry feeds them to
`composeConfigSchema`, which keys them by module id under every project
entry and under `projectDefaults` — the same closure the top-level
`plugins` record already got. A project section no registered plugin
contributes is an unrecognized key, said by the composed schema and by
the editor hint alike; a contributing section is validated and filled by
its own plugin's defaults. Core keeps the core vocabulary of a project
(`enabled`, `knowledge`) and reads nothing inside a contributed
section — plugins read their own sections back with a cast, the
`plugins.<id>` pattern one level down.

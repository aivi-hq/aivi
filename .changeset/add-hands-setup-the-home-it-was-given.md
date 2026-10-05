---
'@aivi/cli': patch
---

`aivi add` broke on Saturday's lazy-home change: the flow imported the
host context's `home`/`configPath` through an `importApp` assertion that
still called them strings, and handed `pluginSetup` the getter functions —
`aivi add browser` died with `The "path" argument must be of type string…
Received function configPath`. The assertion is honest now and the paths
come from the home `add` was already given: `pluginSetup` receives strings
derived from `options.home`, the way `remove` always did.

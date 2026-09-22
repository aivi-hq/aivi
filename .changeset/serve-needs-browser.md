---
'@aivi/app': patch
---

Declare `@aivi/browser` as a dependency: `serve` imports it on the default path (skipped only with `browser: false`), so a fresh `npm install @aivi/app` died with `Cannot find package '@aivi/browser'` before the host ever listened. The monorepo's workspace links hid the gap; an installed home does not have them.

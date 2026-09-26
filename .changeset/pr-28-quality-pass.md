---
"@aivi/app": patch
"@aivi/browser": patch
"@aivi/channel-discord": patch
"@aivi/channel-slack": patch
"@aivi/cli": patch
"@aivi/core": patch
"@aivi/host": patch
"@aivi/knowledge": patch
"@aivi/linear": patch
"@aivi/opencode": patch
---

A quality pass with no behavior change (PR #28, merged without its changesets): the largest flows in the host, the CLI, core and the adapters were split into named steps, and the coverage run now measures the test files too. `@aivi/host` gained `zod` as an explicit dependency, and every package's `exports` map carries a `development` condition that resolves to sources for the test and typecheck commands — installs keep running `dist/` untouched, as before.

---
"@aivi/cli": patch
---

Preserve an existing `app/.npmrc` when running setup in a populated home. Setup now writes the default npm configuration only when that file is missing, instead of replacing the operator's registry and install settings.

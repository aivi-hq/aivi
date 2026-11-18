---
"@aivi/core": patch
---

Fix `brandBanner` and `brandStyle` throwing on a colour terminal. `brandStyle` documents that a brand colour can be named (`'primary'`, `'remote'`, `'muted'`…), but it passed the name straight to `styleText`, which accepts only hex codes and its own formats and threw `ERR_INVALID_ARG_VALUE`. `brandBanner` names its colours, so it threw on every stream that could show colour. A brand colour name now resolves to its hex; names that `styleText` knows (`'bold'`) and hex codes written out pass through as before.

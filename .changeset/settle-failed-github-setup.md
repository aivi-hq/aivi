---
"@aivi/tracker-github": patch
---

Stop GitHub setup's progress spinner when webhook verification or the request-diary store fails. The original error still propagates and no configuration is written, but the installer no longer leaves its progress animation running after the failure.

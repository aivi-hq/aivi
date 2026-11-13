---
"@aivi/tracker-github": patch
---

Fix GitHub setup's webhook check so any correctly signed delivery to the configured endpoint counts as proof and completes the check immediately. Previously, non-installation events were logged but ignored by the result, so setup could falsely report that nothing arrived.

---
"@aivi/cli": patch
---

Report the supported scripted setup forms when a required prompt has no interactive terminal. This failure now reaches the CLI's error handler with its instructions, instead of being treated as a cancelled answer and reduced to a generic “Setup stopped” message.

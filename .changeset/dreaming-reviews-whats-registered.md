---
'@aivi/core': patch
'@aivi/host': patch
---

Dreaming reviews every registered channel by default. `origins` lost its
hardcoded `["discord"]`: the schema default is now the empty list, and
the dreaming operation fills it at run start with the channel modules
actually registered — a Slack-only home reviews Slack without a config
edit. A home with no channel module and no named origins fails the run
saying so, instead of confidently reviewing nothing.

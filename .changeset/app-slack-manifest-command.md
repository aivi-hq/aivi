---
'@aivi/app': patch
---

`aivi slack manifest [--prefix PREFIX]` prints the whole Slack app manifest as JSON, ready to paste into Slack's app setup. The prefix comes from `--prefix`, else the configured module's `commandPrefix`, else an interactive prompt (a script without a configured module is told what to pass). The display name is the persona from `identity.name`.

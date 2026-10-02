---
'@aivi/host': patch
---

`/context` now shows what OpenCode has loaded: every plugin beyond OpenCode's built-ins, with version and source target (`aivi (v0.3.1): file:/…`), so a missing or failed aivi plugin is visible from Discord and Slack. The render also moved to three bounded OpenCode calls — the session object, `session.context` (the effective context, the same read the TUI's display makes) and the plugin list — replacing the full-transcript paging walk it used to do on every `/context`; lifetime totals come from the session object, and the message/answer counts, which only the walk could give, are gone.

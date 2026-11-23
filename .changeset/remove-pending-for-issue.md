---
'@aivi/host': patch
---

Remove `ConversationStore.pendingForIssue`. Its only callers were the GitHub and Linear trackers' code that was meant to stop an assistant turn when its ticket changed. That code never ran: it looked conversations up by issue, and an assistant conversation is bound without one.

---
'@aivi/plugin': minor
'@aivi/tracker-linear': minor
---

**A delegated ticket is not eligible, and early deaths are visible.**
The walk now leaves out tickets that already have a delegate (ruled
2026-10-02): someone already speaks for them, and re-delegating to the
user a ticket already has is a mutation no-op — Linear makes no session
for it. That silence was seven failed runs on one ticket. When a run
dies before its session exists, `Platform.notify` — a new required
member — leaves a plain comment on the ticket itself before the run
fails. And closings compose the rule: **every** ending releases the
delegate (the delegate means *an app is working this issue*; a finished
run works it no more — leaving it sitting would blacklist the ticket,
which "endings release" forbids). While a closing is owed, the ticket
waits; when it is paid, failed work is work again.

---
'@aivi/host': patch
---

Two endings told the truth. `runTurn` with the `fail` permission policy
says a verdict that already stands before arming the wait — a permission
pending from before the prompt used to hang the turn on the very wait
that permission holds. `Dispatcher.release()` confirms an in-flight kill
before freeing the slot: an expiring lease releases through the usual
door when OpenCode answers that the session is done spending, and stays
held, expiring, and retrying when it does not.

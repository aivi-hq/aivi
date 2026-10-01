---
'@aivi/host': minor
'@aivi/tracker-linear': minor
---

**The eligibility walk: work is pulled, not pushed.** The orchestrator now
walks each tracker's board — lanes right to left (work closest to done
first), tickets top to bottom, a queue lane as the **bottom** of the worker
lane it feeds — and starts work through the dispatcher: nothing starts
without a lease, the delegation path included, and a full pool answers the
delegator in words instead of silence. A queue pickup moves the ticket into
the worker lane before the worker starts; the claim mirrors the lease, and
every ending gives the slot back and wakes the walk again. A refusal stops
the pass for that pool only; other pools walk on.

A person's stop is now a fact the walk respects: the follower remembers it,
the memory survives restarts, and only the person's next move — a lane move
or a fresh run — answers it. Picked-up work has no agent session, so its
ending is said with the installation's own app: closing note and move on
the ticket, question as a ticket comment; endings that arrived while nobody
followed are rendered at boot from the orchestrator's own record through
the follower's watermark.

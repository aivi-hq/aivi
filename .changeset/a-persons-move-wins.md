---
'@aivi/plugin': minor
'@aivi/host': minor
'@aivi/tracker-linear': minor
---

**A person's move wins.** The webhook is the trigger to end a job
gracefully, and a missed delivery no longer ends as a surprise: the
adapter now reads Linear's archive as a neutral `archive` change, so
deleting a ticket interrupts its live run, says the stop in the session,
and releases only after the run is properly disposed of. Before any
ending move the orchestrator asks the board `ticketLane` where the ticket
sits (new `Tracker` member): gone, or anywhere but where the run worked
or the target, means a person moved it — the owed move is spent, never
undone, and the log says so. And the `ask` form's options are
suggestions now (`custom: true`): a person who *types* an answer instead
of picking one closes the record with their own words — before, a free
answer to an options question was refused by OpenCode and the form stood
unsettled (live, 2026-10-02, the riddle ticket).

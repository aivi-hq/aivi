---
'@aivi/plugin': minor
'@aivi/host': minor
'@aivi/forge-github': minor
---

**The feedback loop.** A run that starts with open review threads on its
pull request is *told* — the first prompt names each unresolved thread and
teaches the loop (agree: do the work, aivi_push; disagree: a grounded
comment; both end with aivi_respond_feedback, which resolves) — and the
open thread ids of that moment are snapshotted on the run row: the only
ones the completion gate can ever owe. `aivi_work_complete` with success
now re-reads the pull request: owed threads still open refuse the
completion as a tool error listing them, each refusal counts, and at the
third a person is asked through the same durable form aivi_ask makes —
never doubled, and an answer to *that* form resets the count. A clean
start owes nothing (a reviewing agent posts its findings and finishes
freely), failure completions are exempt, a human resolving is
authoritative, and plain conversation comments are context only. New
tools: `aivi_review` (what the gate checks, visible), `aivi_respond_feedback`
(answer a thread or comment), and `aivi_submit_review` — the review
agent's inline findings as real review threads; APPROVE is not offered,
that button stays human. On the forge contract: `PrFacts.mergeable`
("main moved, you conflict" arrives in the first prompt),
`ReviewFacts.comments`, `commentPr` and `submitReview`; the ledger grows
migration 4 with the loop's `feedback` JSON.

# Knowledge improvements: what is open

Status: knowledge is a core concept (ruled 2026-10-03 — it stays one until
different knowledge adapters are real). [knowledge.md](../knowledge.md) owns
the behaviour; this file collects the improvements, one per section, and
will grow.

## Dreaming transcripts are never cleaned up

Every dreaming run writes its transcript — the markdown of conversations
the reviewing agent reads — to `<state>/dreaming/<runId>.md` (0600,
`packages/host/src/dreaming.ts`) and nothing ever deletes those. The facts
and proposals the run produces are reconciled in place and do not grow;
the sessions belong to OpenCode and are not ours to prune. These nightly
files are ours, and they accumulate one per run forever. A retention rule
(how many nights, or which runs keep their transcript) is the open
decision.

## Transcript content is not automatically memory

Raised by the operator (2026-10-05) with the meetings program in view: a
transcript is a literal record, and not all of it is durable knowledge —
"what did you do over the weekend" banter before the meeting starts reads
as facts about people, but should not become memories. The dreaming
reviewer is the place this gets decided (it already reads transcripts and
proposes facts); what is open is the *rule* — what makes utterances
knowledge-worthy (decisions, commitments, stated preferences) versus
conversation that was only ever spoken in the moment — and whether
channel chatter needs the same filter once meetings arrive with real
banter volumes.

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

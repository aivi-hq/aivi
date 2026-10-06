---
'@aivi/core': patch
'@aivi/host': patch
---

The turn-end nudge lives. It was specified, budgeted and coded since
2026-10-02 — and had fired exactly zero times, ever: it watched
`session.idle`, which OpenCode's schema declares deprecated and its server
never sends (verified against 2.0.23). A worker that ended its turn in plain
text, after a rejected permission or into silence, just sat there. A turn
ended is now `session.execution.succeeded` followed by a quiet span — new
`orchestrator.turnEndDebounce`, default `5s`, cancelled by any new
execution — with no unanswered question standing. Only true silence earns
the nudge; the spent budget fails the run visibly. And a worker's permission
prompt is now answered by aivi at once — reject, with the operator's new
editable `permission-denied` prompt naming `aivi_ask` — instead of parking
the worker until the idle clock kills it.

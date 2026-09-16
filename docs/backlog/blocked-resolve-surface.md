# `blocked` across runs, workers, and conversations

Status: real inconsistency surfaced live 2026-09-16; parked pending a decision.

## The problem

Three different things share the word `blocked`, and the CLI surface is uneven:

| State | Where | Meaning today | Operator command |
| --- | --- | --- | --- |
| run `blocked` | `runs` table (jobs) | ended without proof the external side stopped | `aivi runs resolve ID --confirm-stopped --outcome … --reason …` |
| worker `blocked` | `<module>_turns` where `effects: 'work'` (Linear) | a worktree may still be mutating and the stop can't be verified | `aivi linear resolve ID --confirm-stopped --reason …` |
| conversation `blocked` | `<module>_turns` for chat (Discord/Slack) | — **removed 2026-09-16**: chat turns never block now, they fail and release | none (and now unreachable) |

Two concrete issues:

1. **The word and the recovery shape differ per surface.** `runs resolve` takes an
   `--outcome`; `linear resolve` does not. An operator has to learn three
   spellings for "release the thing that holds capacity."

2. **A `blocked` state without a configured module has no command.** `discord
   resolve`/`slack resolve` only exist when the module is configured. The day a
   chat platform could produce a `blocked` turn (it can't today, by design), a
   home without that module configured could not clear it. Linear is the only
   module that blocks; if Linear is unconfigured, `linear resolve` does not
   exist. Decide whether blocked-state recovery should live on the host
   (`aivi resolve ID` with the store figuring out the table) instead of
   per-module, so no dead ends.

## Context

- The 2026-09-16 change: `blocked` for conversation turns was removed for
  `effects: 'reply'` platforms (chat); they fail and release. Only `effects:
  'work'` (Linear) keeps `blocked`.
- Runs are a separate table and keep `blocked` regardless.
- `docs/operations.md` still describes run `blocked` recovery; that is fine,
  but the conversation-turn rows it used to mention are gone.

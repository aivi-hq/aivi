---
'@aivi/core': patch
'@aivi/cli': patch
'@aivi/plugin': patch
---

Preparing the self-project. `AGENTS.md` was rewritten from the ground up:
principles, decisions-by-precedent, the escape hatch, and the timer bans,
with the shared vocabulary kept and the rest moved to the docs that own
them — plugin seam words to `@aivi/plugin`'s new `docs/vocabulary.md`,
channel words to `docs/channels.md`, exec words to `docs/operations.md`.
`CONTEXT.md` is absorbed and gone. The shipped worker templates (dev,
product, review) and the dreamer now deny `aivi_jobs`: scheduling belongs
to the assistant, and a lane that gives itself work was never the design.
The repository carries its own `.opencode/agents/` overrides with the
graft workflow and the verify gate spelled out. The lane schema dropped
its "inert until the dispatcher is built" descriptions — the dispatcher
is built.

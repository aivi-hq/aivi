---
'@aivi/cli': minor
---

**Template scaffolding — the worker files ship.** `packages/cli/templates/agents/`
grows `product.md`, `dev.md` and `review.md` beside the assistant and the
dreamer, and `aivi setup` seeds all five into `<home>/.opencode/agents/`,
never overwriting what exists. The worker files carry the judgement — voice,
the returning-work posture line, "Request changes for problems. Comments for
nits.", and the permission denials an unattended run needs — while the
mechanics stay in the orchestrator's first prompt, so nothing restates the
tool contract. Written once, then plain files: editing them is the whole
configuration.

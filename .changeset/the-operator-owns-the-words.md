---
'@aivi/core': minor
'@aivi/host': minor
---

**Editable prompts.** The texts aivi speaks by itself — the worker
contract, the nudge, the feedback-loop opener, review posture, PR-body
style, the escalation form, the job-result re-entry line — now have
built-ins in core **and** editable copies in `<home>/prompts/`. `server
create` copies them in when the home is born (never overwriting; each copy
opens with a warning header); every text is **read at use**, so an edit
lands on the next run and deleting the file is instant restoration. New
command: `aivi prompts` lists the set and where each one's words come
from, `aivi prompts install` re-copies what is missing, `aivi prompts show
<name>` prints what aivi says today. Composition stays code: the owed
thread list, ticket data and the state machine are never template
material.

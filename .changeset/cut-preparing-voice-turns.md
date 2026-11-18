---
"@aivi/voice": patch
---

Cut a room's turn when the room leaves while its session is still being prepared. The cut only reached a turn that was already asking the model, so a room that left during session creation ran the whole answer for nobody: the slot stayed held and leaving waited until that answer was finished. The turn now ends before the model is asked, and the prepared session is kept for the next join.

---
"@aivi/voice": minor
---

Quote an addressed meeting sentence to the agent as it was said. The wake phrase was cut out of the sentence first, which could leave a prompt that began with a stray comma, and the phrase is how the agent knows it is being spoken to. Nothing is stripped anymore, and the `stripWake` export is removed.

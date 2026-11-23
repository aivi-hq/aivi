---
"@aivi/voice": patch
---

Cut a spoken clause at a punctuation mark only once a space or a line break follows it. A mark at the end of the text received so far was treated as a clause end, so a number that arrived as `3.` and `5` was spoken as two clauses. The mark now waits for the next character, and the closing sentence of an answer is spoken when the answer ends.

---
"@aivi/chrome": minor
---

Add `killAfterMs` to `Chrome.launch`, and `pollMs` to `Chrome.launch` and `Chrome.attach`. `killAfterMs` is how long a browser gets to end after SIGTERM before it is killed (default 5000, as before). `pollMs` is the pause between two looks while a browser boots, at its port file and at `/json/version` (defaults 50 and 100, as before). They were fixed numbers in the code.

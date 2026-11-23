---
"@aivi/tracker-github": patch
---

Give back the webhook route and the event subscription when the module's start fails after it took them. The supervisor retries a failed start, and the route a half-started module left registered made every retry fail with "registered twice", so the module stayed degraded until the host restarted.

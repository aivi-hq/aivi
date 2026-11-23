---
"@aivi/voice": patch
---

Report a restart-recovered lease as recovered only when its slot came back. When the dispatcher answered that the kill was still unconfirmed, voice logged `turns.recovered` although the slot stayed held. That answer now logs `turns.lease.pending-kill` with the room and pool, like every other release.

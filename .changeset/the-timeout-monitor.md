---
'@aivi/host': minor
---

**The timeout monitor: one clock per lease, aimed at a known instant.**
The dispatcher now arms a timer at every grant — the prepare window for a
lease without a session, the idle window for an attached one — and every
sign of life re-aims it. A silent worker is killed, the kill is confirmed
before the slot is freed, and an unconfirmed kill keeps the slot
unavailable: capacity that may still be working is never double-booked,
and the next look is a known instant, not a poll. The clocks watch leases
whether or not pools count them, and after a restart the survivors'
clocks run from their stored activity — a silence that began before the
restart is timed from where it began. `setInterval` stays banned.

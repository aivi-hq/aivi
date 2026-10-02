---
'@aivi/host': minor
'@aivi/channel-slack': minor
'@aivi/channel-discord': minor
---

**Interjection is the default; `/steer` died and `/queue` took its place.**
A message that arrives while the conversation's turn runs now goes **into**
that turn — `session.prompt` with `delivery: "steer"`, marked
`metadata.aivi.steer = <the turn's message id>` so the answer verification
counts it as part of the turn (ruled 2026-10-02: the prompt is delivered
with steer by default, or queue when requested). A reaction acks it; the
turn's own answer speaks for it; a steer that fails queues the message
anyway, logged, never lost. `/queue TEXT` is the explicit way **behind** the
running turn. Both channels and the shared command table (Slack manifest,
Discord registration, `/help`) move together.

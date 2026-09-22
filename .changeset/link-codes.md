---
'@aivi/host': minor
---

Link codes and channel identities (schema v10): a person mints a 5-digit, one-time code with `POST /v1/links` (bearer required, one active per person, 15 minutes) and spends it with the new `/link CODE` chat command on any platform; the host binds `{channel, user id} → person` and confirms in its own words. Refusals never consume the code, and an already-bound account is refused outright — there is no unlink yet. Linked accounts speak as their person: the turn prompt carries the person's name and sessions are stamped `metadata.aivi.person`. Retention sweeps expired codes. Modules advertise their redemption wording through the new optional `ChannelModule.linkHint`.

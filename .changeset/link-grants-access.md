---
'@aivi/core': minor
'@aivi/channel-discord': minor
'@aivi/channel-slack': minor
'@aivi/host': minor
---

Who may talk is no longer config's job: `access.dm` and the per-channel
`users` lists are gone, and a person's link is the only admission. A linked
account may DM aivi and is heard wherever aivi listens; an unlinked account
is ignored in channels, and in a DM it can only redeem a code, answered at
most once per start with the link hint. `/link` redeems wherever aivi
listens, linked or not. The installers no longer ask for anyone's user id,
and `/steer` now speaks as the person and stamps `metadata.aivi.person`, so
a session knows who steered it. Breaking, before any live install: configs
carrying `access.dm` or `users` fail validation.

---
'@aivi/host': minor
'@aivi/core': minor
'@aivi/app': minor
---

Roles arrive: a person carries an open string array of roles (`operator`
manages people and maintenance; new people default `member`), the store
migration grants `operator` to everyone who existed, and `whoami` answers the
real roles instead of the hardcoded stub. People management over the API —
listing, creating (optionally with roles: `aivi people create NAME --role
operator`) and minting tokens for — now requires an operator bearer; the
store-direct path on the server itself stays the operator at the console.
Wider per-operation enforcement lands with the ops dispatcher
(docs/plans/operator-api.md).

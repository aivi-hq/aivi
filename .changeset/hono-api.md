---
'@aivi/host': minor
'@aivi/core': minor
'@aivi/cli': minor
'@aivi/linear': minor
'@aivi/opencode': patch
---

The host API is a Hono app now; the hand-rolled node:http router is gone and behavior (statuses, error bodies, the 405/404 fallbacks, raw-byte webhooks) is preserved by the boundary tests. Paths carry no version: `/v1` is removed from every route, and the API version lives in a header instead — every first-party client sends `x-aivi-client` with its own package version, read from `package.json` at runtime. The major is the contract, the minor is features: a client ahead of its host is refused with 403 `server_version_too_low`, a client behind the host's major with `client_version_unsupported` (`aivi upgrade`); a client behind within the major is served. `GET /version` and `GET /health` answer without the header. This release starts `@aivi/cli` and `@aivi/host` as a changesets `fixed` group, so their versions stay one number from here on. **Operator action:** Linear webhooks now arrive at `<public base>/linear/webhooks/app/<app id>` — re-point the dashboard URL.

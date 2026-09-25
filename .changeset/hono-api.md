---
'@aivi/host': minor
'@aivi/core': minor
'@aivi/cli': minor
'@aivi/linear': minor
'@aivi/opencode': patch
---

The host API is a Hono app now; the hand-rolled node:http router is gone and behavior (statuses, error bodies, the 405/404 fallbacks, raw-byte webhooks) is preserved by the boundary tests. Paths carry no version: `/v1` is removed from every route, and the API version lives in a header instead — every first-party client sends `x-aivi-client` and the host answers a request whose breaking segment differs with 403 and a `code` naming the fix (`client_version_unsupported` → `aivi upgrade`; `server_version_too_low` → update the host). `GET /version` and `GET /health` answer without it. **Operator action:** Linear webhooks now arrive at `<public base>/linear/webhooks/app/<app id>` — re-point the dashboard URL. `@aivi/core` exports `aiviVersion` (equal to `@aivi/host`'s version, welded by a test); the thin CLI carries that copy itself.

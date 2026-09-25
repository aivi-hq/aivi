# aivi API refactor: Hono

Status: built 2026-09-25 on branch feat/api-refactor. What the API does now
is owned by [architecture.md](../architecture.md); this file is the record
of how the refactor was planned. The phases below predate the build; the
deltas landed together are collected at the bottom.

## Design (settled — do not relitigate)

- Replace the raw node:http API in `packages/host/src/server.ts` with a Hono app.
- `createHostServer` is gone. Export `createApp()` (the Hono app) from
  `@aivi/host`, plus a small `serveApp(app, bind, port)` helper that wraps
  `createServer(createAdaptorHandler(app.fetch))` from `@hono/node-server`
  and wires listen/error. `packages/host/src/application.ts` uses it; the
  returned object stays a real node http Server (listen/address/close).
- One file per resource under `packages/host/src/api/routes/`. Static
  paths only. NO `/v1` prefix anywhere — the prefix is fully removed from
  every path, the client, the tests, and the docs. No `withVersions`, no
  version path params, no per-version handlers or schemas.
- Linear webhooks: path becomes `POST /linear/webhooks/app/:app`
  (`packages/linear/src/routes.ts` `appWebhookPath`). User owns the Linear
  dashboard config; operator re-points the webhook URL. If Linear ever
  needs compat, a `/v1` prefix can be re-added then — not before.
- Validation is ENDPOINT-OWNED: each route line decides its own
  `zValidator('json', <schema>, onZod)` from `@hono/zod-validator`. The
  shared piece is only `onZod`/`onError` formatters producing the standard
  `{ error: string }` body (client `describeFailure` depends on it).
- Query parsing for `/knowledge/search` and `/sources` is NOT middleware:
  `parseSelection` stays a plain function the handler calls itself.
  Keep its repeatable-param semantics (`project`, `kind` multi-values);
  refactor its `string | object` return to `{ ok, error }` (lands review
  finding host-core-app.md L13/S5). Do not use zValidator's query target
  (it collapses repeated keys).
- Version negotiation REPLACES endpoint versioning:
  - Client sends `x-aivi-client: <version>` on every request
    (`packages/host/src/client.ts` createHostClient).
  - Server compares the breaking segment: minor while the packages are
    0.x, major at >=1.0. Same segment = allowed.
  - Mismatch → 403 (user's decision, not 426). Bodies:
    `{ code: 'client_version_unsupported', minVersion: '<server version>' }`
    (client older) and `{ code: 'server_version_too_low', minVersion: ... }`
    (client newer). Missing/unparseable header counts as oldest.
  - Exempt from the gate: `/health`, `/version`, and the public webhook
    dispatcher (Linear authenticates by signature, is not our client).
  - `GET /version` → 200 `{ version }` — shape frozen forever, open like
    `/health`. No `breaking` field, no supportedClients field, no config,
    no semver dependency (integer segment compare, ~3 lines).
  - Version source: single constant (e.g. `packages/core/src/version.ts`),
    verified against package versions by the existing check chain; also
    fixes review L4/S5 (`Status.version: '0.1.0'` hardcoded).
  - `Status` gains additive `version` correctness only (no other changes).

## Behavior to preserve (tests encode these)

- Error body is always `{ error: string }`; codes in
  `packages/host/src/client.ts` describeFailure parses them.
- Exact statuses asserted in `packages/host/test/http.test.ts` (442 lines):
  open `/health` + `/status` (no auth); 400 bad kind/param/project; 502
  context failure; 405 method mismatch; 413 over-size body; 415
  non-JSON content-type; 401/403 people gate (anonymous vs operator role);
  404 unknown person; 409 link already-linked; 400 invalid person/jobs;
  503 unavailable services; 500 'The job operation failed on the host'.
- D1: 405 unifies to `{ error: 'Method not allowed' }` + `Allow` header
  (hono `methodNotAllowed({ app })`). Tests assert status only.
- D2: notFound keeps today's quirk: unknown path + non-GET → 405, + GET →
  404. One fallback handler implements both.
- D3: `PublicRoutes` class survives (dynamic register/unregister has no
  hono analogue) as one dispatcher middleware consulting the Map, passing
  RAW bytes (`c.req.raw.arrayBuffer()`; Linear signs bytes; 1 MiB cap kept).
  Guard relaxes from `/v1/` prefix to: not `health`, not `version`, must
  not collide; double-registration still throws.
- D4: interrupted body reads → 400 `{ error: '… request interrupted' }` +
  existing log keys (`browser.interrupted` etc.). Log keys preserved:
  `api.public.failed`, `browser.failed`, `jobs.failed`, `context.failed`,
  `knowledge.search.failed`, `jobs.interrupted`.
- Body caps unchanged: browser 32 KiB, jobs/people/links 64 KiB, public
  1 MiB (hono `bodyLimit`, boundary `> max` = 413, exactly-max passes).
- Zod failure messages keep today's shapes: `Invalid job request: <path>:
  <msg>; …`, `Invalid person: …`, `Invalid token request: …`,
  `Invalid browser request`, `Invalid search request` — wire via shared
  `onZod` onError.
- `bearerPerson` semantics: auth is `none`; a bearer only names the caller
  for association; unknown/absent stays anonymous. Only whoami/links reject
  anonymous (401); people management needs role `operator` (401 anon / 403
  non-operator). Keep `bearerPerson` + `status` exported as today.
- Tests: `http.test.ts` URLs change (paths lose `/v1`) but assertions
  otherwise stand. Mock servers in other packages' tests stay node:http.
  New boundary tests: too-old client 403 `client_version_unsupported`,
  too-new client 403 `server_version_too_low`, nameless header treated
  oldest.

## File layout

```
packages/host/src/api/
  app.ts        createApp(): Hono — global middleware (setHeaders
                content-type json + cache-control no-store, bearerPerson
                resolution, version gate, methodNotAllowed, notFound,
                onError), mounts route registrars
  gate.ts       version gate + GET /version
  http.ts       shared helpers: onZod formatter, requireJson (415),
                bodyLimit presets, respond utilities
  routes/
    health.ts  whoami.ts  status.ts  knowledge.ts (search+sources)
    projects.ts context.ts browser.ts jobs.ts wake.ts links.ts
    people.ts (incl. /people/:id/tokens)
packages/host/src/server.ts  → deleted; exports move to api/app.ts via
packages/host/src/index.ts (`createApp`, `serveApp`, keep `PublicRoutes`,
`bearerPerson`, `status` exports)
```

`packages/host/src/application.ts` `serve()` uses `createApp` + `serveApp`
(listen on `loaded.config.host.bind/port`, `.once('error')` before listen,
`http.on('error', fail)`, `http.address()` for onReady, non-loopback warn
unchanged).

## Deps (pinned exact, all zero-transitive, MIT)

`packages/host/package.json`: `hono 4.13.9`, `@hono/node-server 2.1.1`,
`@hono/zod-validator 0.9.1`. zod 4.1.13 already in `@aivi/core`. No semver
dep. Node engine fine (>=20 adapter, repo runs Node 26).

## Out of scope

- `packages/linear/src/mcp.ts` stays node:http (raw streaming proxy).
- No OpenAPI, no hono/client typed client.
- `Status.completion` constant untouched.

## Phases (each ends green: `npm run build && npm run typecheck && npm test`)

1. Skeleton: add deps; `api/app.ts`, `api/gate.ts`, `api/http.ts`;
   version constant; `serveApp`; port health/status/projects; URL sweep
   through client + http.test (drop `/v1`); gate + `/version` live.
2. Version gate tests + fallbacks: D1 methodNotAllowed, D2 notFound quirk.
3. GET resources: whoami, context (AbortSignal.timeout 15s, 502),
   knowledge (parseSelection → `{ok,error}`), projects, wake.
4. POST resources: browser, jobs (JobRefused → its status), people+tokens
   (operator gate), links (401/415/404/409 ladder).
5. Webhook dispatcher (D3): Map middleware, raw bytes, 1 MiB; update
   `appWebhookPath` in packages/linear; verify linear route tests.
6. Error/interrupt parity (D4, onError, log-key audit); `aivi upgrade`
   remedy text in gate messages; `npm run agentic:verify`.
7. Docs in the same commits as the changes they describe:
   `docs/architecture.md` (decision: version negotiation via
   `x-aivi-client` + 403 codes, refuse-not-dual-serve; hono listener),
   `docs/configuration.md` (version constant source), and every doc that
   documents `/v1/...` paths → new paths: `docs/channels.md`,
   `docs/people.md`, `docs/linear.md` (+setup: operator re-points Linear
   webhook URL), `docs/operations.md`, `docs/discord.md` if mentioned.
   CONTEXT.md "Where things are" line for host layout if needed.

## Verification gates

- Mock/node tests never establish live behavior: after the suite, live
  OpenCode + Discord + Slack gates only if anything beyond the HTTP layer
  moved (expected: none; Linear live gate needs the dashboard URL edit).
- `npm run agentic:verify` before each commit; Conventional Commits
  (`type(scope): subject`).

## Context budget note for future-me

This file is the source of truth for the refactor decisions. If compacted:
re-read this, then `CONTEXT.md`, then start at the first unchecked phase.
Do not add version machinery, ranges, config fields, or `/v1` back.
Validation is endpoint-owned; the gate is a 403 with a `code` field.

## Built (2026-09-25) — deltas from the plan above

- `serveApp` is `createServer(getRequestListener(app.fetch))` from
  `@hono/node-server`, not `createAdaptorServer`: the adaptor's `ServerType`
  return is a union over http/http2 and types `listen` worse. Same real
  node http Server, not yet listening.
- The version constant (`aiviVersion` in `packages/core/src/version.ts`) is
  `@aivi/host`'s `package.json` version — the packages are versioned
  independently, so "the package set" has no single version. A core test
  asserts both, and `@aivi/cli` — which may import nothing (its packaging
  test) — carries a copy in `src/api-version.ts` that the same test welds.
- D4 as planned: an interrupted body read now answers 400 through the
  validator (`Invalid <label>…`) instead of `… request interrupted`, and the
  `*.interrupted` log keys are gone with the manual read loops. Untested
  edge; accepted.
- `browser.ts` never became a route: the browser reached the API through the
  tool door (`/tools`), and the old `/browser` endpoint was already gone
  before this refactor started.
- `/health` and `/version` are GET-only routes registered first in
  `createApp`; the exemption is that registration order, not a path check
  inside the gate.

# Review: fallow leftovers (2026-09-25)

The complexity round (batches 1–15) is over: the 114 findings that exceeded a
complexity threshold are all resolved, and no remaining finding exceeds one.
What is left — 77 findings, every one flagged for `crap` only — is in three
classes. Each item below is a decision, not a defect report.

Background: CRAP wants coverage. When istanbul cannot match a function by
name — anonymous argument callbacks get no entry in its map at all — fallow
estimates coverage as zero, so the estimate is `cc² + cc` and any cc ≥ 6 is
flagged. A "measured" finding is istanbul's own count.

## A. Tested code istanbul cannot name (measurement artifact)

The body runs in tests, fully; only its anonymity hides that. The established
idiom (used for `respond` in the test fakes and all of batch 15) is to assign
the callback to a named const and pass that in: `const add = () => { … };
return this.transaction(add)`. Naming makes the function measured, and the
finding drops honestly. It is a style change to 26 call sites for a
measurement gain — genuine, but a style call, so it is yours.

A.1 — `Store` transaction callbacks, run on every call:
`store.ts:520` addJob (cc10), `:596` materializeDue (cc6), `:652` claim (cc6),
`:709` acquireLease (cc7), `:758` finish (cc5), `:797` acquireDaemon (cc6),
`:1006` redeemLinkCode (cc5).

A.2 — host route and turn callbacks, run through HTTP/turn tests:
`api/routes/knowledge.ts:17` (cc10), `api/routes/links.ts:36` (cc7),
`api/routes/people.ts:31` (cc5), `api/routes/tools.ts:22` (cc5),
`api/public.ts:48` (cc5), `channel/turns.ts:52` (cc14), `jobs.ts:42` (cc12),
`channel/model.ts:46` (cc7), `channel/store.ts:121` (cc5),
`runtime.ts:158` executor dispatch (cc5), `runtime.ts:206` (cc8),
`runtime.ts:110` dreaming handler (cc5), `scheduler.ts:101` promise (cc9),
`application.ts:242` (cc7, partly run).

A.3 — adapters and core, run in their suites: `app/src/cli.ts:39` (cc8),
`browser/src/transport.ts:84` (cc6), `browser/src/service.ts:15` (cc5),
`core/src/browser.ts:4` loopback (cc7), `core/src/config.ts:159` (cc6),
`opencode/src/index.ts:168` agentTransform (cc5).

## B. Matcher artifacts — no repo-side fix

B.1 `linear/src/client.ts:118` constructor (cc6): istanbul records the class
constructor as `LinearClient`, fallow as `constructor`; the names never match
though coverage exists (9 calls). Upstream matcher gap; ignore pattern or
fallow issue.

B.2 Test bodies themselves (slack.test.ts:284, channel.test.ts:328,
application.test.ts:359, store.test.ts:493): the `test('…', async t => …)`
callback is an anonymous argument, and it runs. Extracting it to a named
const before `test()` would read worse — recommend an ignore pattern for
`test/**` bodies or an upstream fix, not a style change.

B.3 `scripts/browser-smoke.mjs:31` find (cc9): a smoke script, never under
coverage (`test:cov` includes `packages/*/src|test` only). Options: ignore
`scripts/**`, or include it in coverage.

## C. Code no test reaches (true gaps)

C.1 `channel-discord/src/module.ts` (10 findings, `handleInteraction` cc18
the largest): tests never start the gateway — a live token is needed. Slack
solved this with an injectable connection in `createSlackModule`; discord
has no such seam yet. Options: build the seam and test the handlers (real
work, `handleInteraction` is cc18), or ignore the module, or accept.

C.2 `channel-slack/src/connection.ts:77/132/167` (identify, post, userName):
the live Web API client; every test injects `fakeConnection` instead. Same
options as C.1.

C.3 `cli/src/main.ts` (main cc7, goesToApp, three action arrows): the CLI
tests import the command implementations directly; nobody calls `main()`
in-process, so the argv contract (forwarding, the `server create` refusal,
`aivi version`) is untested. Option: a test that imports main.ts and calls
`main(['--version'])` etc. — cheap for the guards, harder for the forwarding
path (spawns the app).

C.4 `app/src/commands/projects.ts` (askRepository, askLanes cc12,
projectsCreate cc11, projectsAdd cc12, resolveTokens, laneAgent) plus
`plugin-setup.ts:50` and `commands/channels.ts:48`: interactive clack prompt
flows behind an `isTTY` guard; no test answers a prompt. Option: injectable
prompt functions (the same seam shape as C.1/C.2) or accept.

C.5 `cli/src/runtime.ts` (ensureNode cc8, existingRuntime) and
`cli/src/service.ts` (runOrThrow, serviceUninstall): they spawn node/npm/
launchctl. Option: injectable spawn, or accept.

C.6 One-offs:
- `host/src/store.ts:62` migrateReport (cc10, measured zero): the v6 report
  rewrite has no migration test. This is the one true gap worth a test —
  cheap (open an old-version fixture, run the constructor).
- `host/src/opencode.ts:96` `_announceVersion` (measured zero): only runs
  when a server announces its version; needs a fake answering that route.
- `host/src/runtime.ts:98` projects.sync (measured zero): the operation is
  never invoked in tests.
- `linear/src/module.ts:82` clientFor, `:579`: multi-app paths a single-app
  test never walks.
- `core/src/brand.ts:56` brandBanner (istanbul/partial, cc9): measured and
  partially covered — the honest tier; fine to leave or threshold-override.
- `app/src/commands/jobs.ts:54` (cc15, cog14) and `knowledge.ts:26`:
  interactive list/detail flows, same story as C.4.

## Disposition

(to fill in, one by one)

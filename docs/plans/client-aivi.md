# Client-side aivi: persons, soul, linking, attribution — plan

Status: designed 2026-09-21; revised after same-day sparring (auth `none`
final, whoami/soul split, agent sharing cut, whoami returns `operator` for
any valid token until real roles land). Multi-session (grouped below).
Box 1 moves this file to `docs/plans/client-aivi.md` and links it from
`CONTEXT.md`. Email linking is **explicitly deferred**; Discord, Slack and
Linear are in. **No existing installs — zero backwards compatibility
anywhere in this plan.**

## The outcome a colleague can test

Admin: `aivi server create` on the server → home + an operator person +
their token, and the last question "Where will you use aivi? **this machine
/ another**" decides whether client setup finishes right there or the token
is printed with instructions for their laptop. Colleague: gets a token from
`aivi people create` → installs the client CLI → `aivi setup` → url, token,
verified with `whoami` **before anything is written**, both plugins
installed into OpenCode (hot-reloads; no restart step),
`~/.config/aivi.json` written → "Signed in as …", linking offered. After
that: their agents speak aivi's name and soul, `knowledge_search` answers,
attended commits carry the co-author **named by aivi's identity**, and
pasting a one-time code into a Discord/Slack DM (or a Linear comment) binds
their channel identity to their person.

## The identity model (settled in sparring, 2026-09-21)

- aivi is a virtual colleague: **people exist so records have an owner** —
  memories, reminders, delegates, jobs. Humans only; aivi itself is *not*
  in the `people` table, and its own work (dreaming, retention, sync) runs
  in-process and authenticates to nothing.
- **Attribution vs association** (goes in the `CONTEXT.md` vocabulary
  table): *attribution* = which names a commit carries — the bot as
  author/co-author from aivi's identity, the human from their own git
  config; a git fact. *Association* = which person a record belongs to —
  link codes, job ownership, session stamps, memories; a host fact, taken
  from the calling bearer, never from what a message claimed (channel
  identities associate by the paste-a-code ritual precisely because there
  is no bearer there).
- **Auth: `none`, final.** `host.auth.mode` and the `AIVI_TOKEN` env
  comparison are deleted. A request with an unknown or missing bearer is
  **accepted with no person attached**. Tokens **identify, never
  authorize** — they answer "which person is this" for association.
  Anonymous is rejected **only at endpoints whose answer must be attached
  to a person**: `GET /v1/whoami` (it is the person lookup) and link
  creation. Everywhere else anonymous works.
- **Roles: a v1 stub.** `whoami` answers `roles: ["operator"]` for every
  valid token — the operator is the only user, running locally, so this is
  simply true today. No roles column, no roles files. Real per-person
  roles arrive with the operator's api-only session (see out of scope);
  before publishing, that replaces the stub.
- **Two identities, two endpoints.** `whoami` = *who is the caller* (person
  + roles). `soul` = *who aivi is* (persona name, soul text,
  `identity.github`) — open to anyone, and the source the attribution
  plugin reads. There is **no server token**: every token row belongs to a
  person, and the config file has no `server` key.
- **One config file, identical shape everywhere: `~/.config/aivi.json`** —
  `{ configVersion?, url?, home?, person?: { token, roles?, checkedAt? } }`
  , `0600`. `home` declares "this machine hosts aivi" (no fs probing).
  `person.roles`/`checkedAt` are a **cache for the help command only** —
  real commands never consult cached roles. The CLI and both plugins load
  this one file; no env-var chains. Home installs at `~/.aivi`, never
  moves; if the path is gone the CLI says "no aivi home found — point me at
  the new one or run create again."
- **Server setup and client setup are the same flow.** `aivi server create`
  mints the operator person + token right away; "another machine" prints
  the token + instructions instead of persisting it. Direct SQLite writes
  exist only in bootstrap (server create); every other command talks HTTP.
- **Distribution (decided): transpile to JS.** One published **client CLI**
  package — commands, interactive prompts, config reader, HTTP client, the
  entirety of what clients install — built to JS so it runs on node *and*
  bun. OpenCode-loaded plugins (`@aivi/plugin`, opencode-attribution)
  publish raw `.ts` sources (verified OpenCode loads those). This is a
  **scoped exception** to the repo's no-build rule — exactly one package
  gets a build; everything else still runs from `src/*.ts`, and the owning
  doc records the exception in the same commit.
- **No served agents (cut 2026-09-21).** aivi does not distribute agent
  files. Shared agents are a plain git repo each user clones into
  `~/.opencode/agents/`; OpenCode's own local-wins behavior does the rest.
  What the plugin does serve over HTTP is the soul/persona text, so remote
  clients are not soul-less.
- **Channels are per-home optional installs, not shipped.** `~/.aivi/app/`
  (its `package.json` as the manifest of what this home runs: server,
  discord, slack, …) is built up as needed — that is the operator's
  installation session, in progress. This plan never says "ships with the
  server."
- **Out of scope — the operator is on it:** putting every command behind
  the authenticated API with real per-person roles, and the aivi
  installation story (CLI binary managing a home with its own
  `node_modules` and app manifest, no git clone — which will *replace* the
  2026-09-15 "installation is a git checkout" decision).
- **Interim gap, stated not hidden:** with commands open, anyone who can
  reach the port can use them. Loopback is safe; a remote-exposed server
  is open until the api-only session lands.
- Carried decisions: nothing fetches at commit time; keychain adapters =
  backlog, file now.

## Verified (2026-09-21)

- From `@opencode/plugin` 2.0.10 types + v2 plugin guide: **async-then-sync
  works** — `setup` is awaited, `transform` is sync, the guide says
  verbatim "load external data before the synchronous callback, then call
  `reload()` after those inputs change". Soul behind the API needs no
  OpenCode change.
- **Node 26.7.0 refuses `.ts` under `node_modules`**
  (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`; tested here), direct `.ts`
  outside it works. **OpenCode plugins can publish raw `.ts` sources**
  (attribution's `exports: "./src/index.ts"` proves it — OpenCode unpacks
  plugins outside that restriction and resolves their deps itself). An
  npm-published **CLI cannot** → hence the JS build.
- OpenCode **hot-reloads plugins** (operator-confirmed, not to be
  re-verified): setup never restarts the service.
- Today's auth is one shared bearer `AIVI_TOKEN`; the plugin's
  soul/persona path is local-filesystem only, so remote clients silently
  get no soul today.

## Mechanisms

1. **`people` + `tokens` tables (aivi.sqlite, real migration).**
   `people {id, name, email?, created}`; `tokens {token_hash, person_id,
   label, created}` — every token belongs to a person, always. Bearer
   resolution in `server.ts`: known hash → attach person to the request;
   unknown or none → proceed anonymous. Nothing rejects except at
   person-attached endpoints (whoami, links). `host.auth.mode` and the env
   comparison are **deleted**; the example home is rewritten to the new
   story as if it was always there.
2. **`GET /v1/whoami`** → `{ person: {id, name}, roles: ["operator"] }`
   (stub, see model); 401 only when no bearer resolves. **`GET /v1/soul`**
   → persona name, soul text, `identity.github` — open. The aivi plugin
   stamps `metadata.aivi.person` on local sessions when it holds a person
   token (association).
3. **Soul + persona behind the API.** Remote: plugin setup awaits the soul
   fetch, the sync transform reads the cache; the local-file path stays for
   server homes. Open: what wakes a refresh on a client (v1: fresh at
   service start; no polling per AGENTS.md).
4. **One CLI, dynamic from the config file.** Help is a network-free
   template over the file's facts: `home` key → *operate* section (`serve`,
   `jobs`, `runs`); `person.token` → *personal* section; `person.roles`
   (cached whoami, refreshed at setup and opportunistically) → whether
   *admin* commands are listed — **display only**. Real commands never
   consult cached roles; with the whoami stub and open commands, nothing
   gates yet, and when the api-only session enforces roles server-side the
   server says no, not the CLI.
5. **`aivi server create`** (bootstrap; the only direct-store command):
   init `~/.aivi`, create the operator person + token immediately, then ask
   "Where will you use aivi?" — *this machine*: persist the person key and
   chain into client setup (plugins in, one breath); *another machine*:
   print the token + "run `aivi setup` there, paste url + token".
6. **`aivi setup`**: preflight (OpenCode on PATH? offer install · plugins
   present? skip) → prompt url + token → `whoami` verifies (a typo must not
   persist) → `opencode plugin add` for both plugins → persist the person
   key + roles cache → "Signed in as …" → offer `aivi link`. Plugin
   credential rule: **the person token if the config has one, else
   bearerless** (channel conversations are associated by their channel
   identity regardless).
7. **Link codes (Discord, Slack, Linear).** `aivi link <platform>` (person
   token required — anonymous cannot link, there is no person to bind) →
   `POST /v1/links` → one-time code `aivi-<random>` (hashed, ~15 min TTL),
   pasted anywhere the bot reads; the inbox matches codes **before** a
   message becomes a turn, binds `{module, channel user id} → person`,
   replies confirming. Email later: link token to inbox + callback URL on
   the public Linear route.
8. **Attribution without drift.** opencode-attribution gains an aivi mode:
   it reads `~/.config/aivi.json` (just a file — no aivi imports), fetches
   **soul** at setup for `identity.github`, prefers it over
   `opencode.coauthor`; git config is the offline fallback. It never calls
   whoami — the co-author is aivi, not the caller. Stays standalone and
   publishable.
9. **Shared library `@aivi/client`** (repo-internal): config read/write
   (0600, configVersion), HTTP client + bearer, light types — used by the
   plugin and the CLI package. How its `.ts` sources land inside the
   published JS CLI (bundle vs publish-as-JS) is decided inside the build
   box. Consolidating `@aivi/host/client` onto it is follow-up.

## Open decisions (operator owns these; not schedulable work yet)

- What wakes a soul refresh on clients (v1: fresh at service start).
- Token revoke/rotate → `docs/backlog/`. Keychain/credential adapters →
  `docs/backlog/`.
- **Operator's parallel work (not this plan):** every command behind the
  authenticated API + real per-person roles (replaces the whoami `operator`
  stub); aivi installation as a managed home with its own `node_modules`
  and `~/.aivi/app/` manifest, channels installed per home as needed
  (replaces the git-checkout installation decision).

## Steps — the trail

Rules so compaction cannot lose the work: every box is one small verifiable
task; **check a box in the same commit that lands it**; mark exactly one box
`▶ in progress`; update **Where we are** whenever work moves. After a
compaction: reread this file, resume at the first unchecked box, trust the
file over memory.

**Where we are:** Session A complete (boxes 1–7, 2026-09-21, branch
`feat/client-identity`). 2026-09-22, branch `feat/aivi-setup`: box 12's
`aivi setup` command landed (detect → connect/create, verify-before-write,
`opencode plugin add` for both plugins, person id/name/roles cache,
service-install offer; `server create` folded in as the identity step) and
box 10's credential half landed (plugin reads client-config url + bearer;
server home ignores the cached bearer). Still open in those boxes: the
dynamic CLI help, soul-fetch at setup, session person stamping — and box 8
(`@aivi/client`) was skipped: setup reads the config file directly. The
decided flow supersedes items 5–6 below where they disagree (setup is the
single entry; `server create` is no longer person-facing). Next Session B
work starts at box 8 as written.

### Session A — identity core (aivi repo)

- [x] 1. Move this file to `docs/plans/client-aivi.md`; link from
       `CONTEXT.md` (map + open threads).
- [x] 2. Identity tables: `person` + `token` in the host `Store` (schema
       v8 — the single SQLite lives in host, not core); every token row has
       a person (FK); `createPerson/people/person/mintToken/personForToken`
       (secret shown once, stored hashed); types in `@aivi/core`; test in
       `packages/host/test/store.test.ts`. (Same-day rename: the tables are
       `people`/`tokens`, plural like `jobs`/`runs`; entity words — ids
       `person-<8>`, column `person_id`, methods `createPerson`/`person(id)`
       — stay singular.)
- [x] 3. Host: `bearerPerson(store, authorization)` in `server.ts` — known
       token → its person, unknown/none → null; the router no longer rejects,
       nothing 401s until whoami. Deleted `HostAuth`/`resolveHostAuth`/
       `MIN_TOKEN_LENGTH`, the `auth` config field (schema regenerated) and
       every `AIVI_TOKEN` handoff (service env, secrets filter, CLI, client
       error text); example `.env.example` = third-party secrets only;
       non-loopback bind warns `api.open`; smoke is one open serve; owning
       docs rewritten (configuration, operations, architecture, opencode,
       getting-started, discord, CONTEXT).
- [x] 4. `GET /v1/whoami` → `{ person: {id, name}, roles: ["operator"] }`
       (stub); 401 for anonymous and unknown bearers, the only such route;
       `Whoami` type + `whoami()` on `HostClient`; test in `http.test.ts`.
- [x] 5. CLI: `aivi server create` — init `~/.aivi` (starter `config.json`,
       `state/`), operator person + token (secret printed once), then "Where
       will you use aivi?" → *this machine* writes `~/.config/aivi.json`
       (0600, merged, never over an existing token), *another* prints url +
       token for `aivi setup` there. Refinement on the plan: the question is
       asked **before** anything is minted, so a cancel leaves nothing
       behind. Flags `--use`/`--name` skip prompts; re-run refuses. First
       CLI tests in `packages/app/test/cli.test.ts`; owning doc:
       `operations.md` §First run.
- [x] 6. People over the API: `POST /v1/people`, `GET /v1/people`,
       `POST /v1/people/:id/tokens` (+ `personCreateSchema`/
       `personTokenCreateSchema`), client methods, CLI `aivi people
       create|list|token` (secret printed once); ungated like everything
       until the api-only session. Router lesson: a path dispatch before the
       method gate catches *all* methods — `/v1/people` branches on method.
       CLI tests run the real CLI against an in-test host via async `spawn`
       (`spawnSync` blocks the parent event loop and deadlocks the host).
       `schema:check` green (no config-schema change needed).
- [x] 7. Docs: `docs/backlog/identity-linking.md` promoted →
       `docs/people.md` (attribution vs association, auth `none` + whoami
       stub, person/token tables, client config shape, bootstrap + people
       commands, link codes, backlog notes); `configuration.md` + `operations.md`
       point at it; `CONTEXT.md` vocabulary rows **attribution** and
       **association**, the tokens-identify decision bullet, and the
       people.md fact-map row; `localization.md` backlog link repointed;
       backlog file removed.

### Session B — the client (aivi repo)

- [ ] 8. `@aivi/client` package (internal): config read/write (0600,
       configVersion, home/person keys), HTTP client + bearer, whoami/link
       types; unit tests.
- [ ] 9. Host: `GET /v1/soul` → persona name, soul text, `identity.github`;
       tests.
- [ ] 10. Plugin remote mode: credentials from `~/.config/aivi.json`
       (person token if present, else bearerless; `options.url` override,
       else `url` key, else loopback); setup awaits `soul` (+ `whoami` for
       the cache), sync transforms read the cache; local-file soul path
       stays for server homes; stamp session person metadata when a person
       token is held (verify the session API write inside this box); mock
       tests.
- [ ] 11. Build: prepack JS build for the published client CLI (engines
       node+bun, bin entry); decide inside this box how `@aivi/client`
       sources land in the artifact (bundle vs publish-as-JS); record the
       scoped no-build exception in the owning doc; verify the built
       artifact runs on node **and** bun.
- [ ] 12. `aivi setup` + dynamic CLI: preflight, prompts, verify-before-
       write, `opencode plugin add` for both plugins, person key + roles
       cache write, "Signed in as", offer link; help template over {home,
       person, cached roles} with no network — cached roles affect listing
       only, never command behavior; tests.
- [ ] 13. Link codes: `POST /v1/links` (person token required; anonymous is
       told there is no person to bind); inbox code-match before a message
       becomes a turn; discord/slack/linear bind handlers; confirmation
       reply; `aivi link <platform>`; tests.
- [ ] 14. Docs of this session: `people.md`, `opencode.md` (remote plugin),
       `channels.md` (code matching), `configuration.md` (config file,
       0600, token-never-logged); `agentic:verify` per commit.

### Session C — attribution (separate repo `~/projects/agentic/opencode-attribution`)

- [ ] 15. aivi mode: read `~/.config/aivi.json`; fetch **soul** at setup,
       cache the `identity.github` pair, prefer it over
       `opencode.coauthor`; offline git-config fallback unchanged; tests.
- [ ] 16. README setup section; standalone rule holds (no `@aivi/*`
       imports — the config file is just a file).

### Live gates (each its own moment; end of Session B/C)

- [ ] 17. Same-machine path (the main one): `aivi server create` → "this
       machine" → "Signed in as", soul says the name, `knowledge_search`
       answers.
- [ ] 18. Headless path: `aivi server create` → "another machine" → printed
       token → laptop `aivi setup` → same expectations.
- [ ] 19. Colleague path: `aivi people create` → hand over token → setup →
       same expectations (ideally a second user account).
- [ ] 20. Discord: `aivi link discord` → paste code in DM → confirm →
       `aivi people list` shows the binding.
- [ ] 21. Slack: same flow.
- [ ] 22. Linear: code from a delegation/comment binds the Linear user.
- [ ] 23. Drift: change `identity.github` server-side → next attended
       commit on the client carries it, with `opencode.coauthor` unset
       locally.
- [ ] 24. Regression: jobs, dreaming and retention still run (in-process,
       bearerless where HTTP is involved).

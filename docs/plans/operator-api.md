# Operator commands behind the API

Status: planned (presearch done 2026-09-21). Goal: every operator command
works from any machine — through the API when the server is remote, directly
against the home when run on the server itself (works offline) — with one
implementation per command and roles deciding who may call what remotely.

## The idea in one line

Each command's body becomes a **host operation function** (plain function over
`Store`/config, already 90% written — it lives in the CLI today). The API and
the CLI both become thin transports over it:

- **On the server machine** (the client config has `home`, and the home
  exists): the CLI calls the function in-process — the exact behavior of
  today's CLI (direct SQLite + `/v1/wake`). Works with the server stopped.
- **From anywhere else**: the CLI calls `POST /v1/ops/<name>` with JSON args;
  the route is a wrapper over the same function.

Detection is a config fact, not guesswork: `home` is present in
`~/.config/aivi.json` only on machines that host aivi
([people](../people.md#the-client-config)). `--remote`/`--local` flags can
override per call.

## Inventory (presearch 2026-09-21)

API today: `/health`, `/v1/people` (POST), `/v1/people/:id/tokens`,
`/v1/browser`, `/v1/jobs` (POST, agent-created), `/v1/wake`, `/v1/whoami`,
`/v1/status`, `/v1/knowledge/search`, `/v1/sources`, `/v1/projects` (GET),
`/v1/context`.

| Command | Today | Behind API? |
| --- | --- | --- |
| `status` | store-direct | read op |
| `config check`, `sources`, `projects list` | local config read | `/v1/sources` + `/v1/projects` exist; check is local-only (fine: it checks the local file) |
| `jobs list/show/add/run/pause/resume/remove` | store-direct + wake | only `POST /v1/jobs` exists |
| `runs list/show/cancel/abort/resolve` | store-direct | nothing |
| `people create/list/token` | HTTP | exists |
| `knowledge search/index` | HTTP | search exists; index is a queued job (`ops.knowledge.index`) |
| `projects add/create/remove/purge` | git clone + config.json write | nothing (list is GET) |
| `discord/slack/linear status/resolve` | store-direct | nothing |
| `opencode check`, `serve`, `service …`, `update`, `upgrade`, `server create` | local-only by nature | stay local (machine commands) |

## Steps

- [ ] 1. Operation registry in `@aivi/host`: each operator capability is a
      named function `(args: unknown, ctx: {store, loaded, log}) => unknown`,
      claimed once at composition — the same claim-exactly-once vocabulary the
      task registry already uses. Reads and mutations are both operations.
- [ ] 2. API: one dispatcher route (`POST /v1/ops/<name>`) over the registry,
      plus thin GET routes for the heavy read lists if curl-friendliness
      matters. Existing routes stay until they migrate; no behavior change.
- [ ] 3. CLI: replace command bodies with registry calls. Transport
      resolution per command (home → in-process, else HTTP). Output
      formatting stays in the CLI.
- [ ] 4. Roles: **store landed 2026-09-21** — `person.roles` (open string
      array, JSON column, migration granted `operator` to everyone existing;
      new people default `member`), `whoami` answers the real roles, and the
      people routes (`GET/POST /v1/people`, token minting) require an
      operator bearer; `aivi people create NAME --role operator` grants the
      role at creation. Remaining: enforcement for every other mutating
      operation moves into the ops dispatcher when it exists (step 2).
- [ ] 5. `service`-adjacent commands (`service install`, `update`, `upgrade`,
      `server create`) stay CLI-local: they run before/around a server and
      need the machine. Document that boundary here.
- [ ] 6. Docs: operations.md gains the transport table; people.md gains roles.

## Deliberately out of scope

- Making `serve` itself API-driven (the server is the thing being driven).
- A second config format for remote homes; the home is the home.

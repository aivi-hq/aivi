# aivi in one page

Read this at the start of a session. It holds what is not written anywhere
else: the shape of the system, the decisions and their reasons, and which
document owns which fact. Details live behind the links.

## What it is

An always-on teammate around OpenCode v2. OpenCode stays the runtime (agents,
sessions, providers, tools, permissions). aivi adds a shared knowledge server,
scheduled work, and channels such as Discord, all started by one `aivi serve`.
Ordinary OpenCode installs reach the knowledge server through a small plugin.
Principles: simplicity in architecture and use, and a focus on performance.

Packages and their responsibilities: [README](README.md#packages). Everything
runs in one process; adapters are optional modules with a start/stop contract.

## Vocabulary

| Word | Meaning |
| --- | --- |
| task | what to do: `kind` + parameters (`system.check`, `knowledge.index`, `shell`, `opencode.prompt`, `dreaming`) |
| schedule | cron + timezone + pool + task (+ report); one outstanding occurrence at a time |
| job | one unit of queued/running/finished work; one row, one audit trail |
| turn | one prompt to a verified final answer in one OpenCode session (`runTurn`) |
| pool / lease | named capacity (`local-model`, `maintenance`); jobs and Discord turns take leases from the same pools |
| blocked | ended without proof that the external side stopped; keeps its capacity until `jobs resolve` |
| failed | ended before anything external happened; the next occurrence retries |
| source / kind | a configured document path, core or per-project, labelled `doc`, `decision`, `memory`, `conversation` |
| dreaming | a scheduled agent that turns conversations since its last run into `facts.md` and proposals |
| origin | `metadata.aivi.origin` on every session aivi creates: `discord`, `job`, `dreaming` |

## Decisions and why

- **Two queues, one capacity.** Discord turns are not host jobs: they run in
  order per thread, continue the thread's session, reply into it, and start in
  seconds. Jobs are fresh sessions in any order. Both take leases from the
  same pools ([architecture](docs/architecture.md#two-queues-one-capacity)).
- **Failed vs blocked** is decided by one thing: was the prompt accepted?
  `TurnNotStarted` before it → `failed`; anything unverifiable after it →
  `blocked`, capacity kept, human resolves.
- **Verified final answer**, never idleness: `finalAnswer` reads the native
  context (`user → assistant(finish: stop) → idle(succeeded)`, no unfinished
  tools).
- **OpenCode discovery per unit of work** (one file read per job or turn), no
  cached client, so `opencode service restart` is picked up by the next turn.
- **Shutdown aborts** running jobs; they end `blocked`. A grace period is a
  design choice not yet made ([shutdown-hooks](docs/backlog/shutdown-hooks.md)).
- **The agent file is the boundary.** Discord, jobs and dreaming run the
  configured OpenCode agent as defined; aivi adds only what the file cannot
  know (`external_directory` for configured sources; dreaming's two `edit`
  targets) and never a deny. Restrict an agent in its own file. The home is
  the OpenCode location (`<home>/.opencode/agents/`), so example sources need
  no external rules at all ([opencode.md](docs/opencode.md)).
- **Memory is files** inside a knowledge source, never system-prompt state.
- **Blocked jobs hold global capacity** on purpose until per-project pools
  exist ([projects-and-capacity](docs/backlog/projects-and-capacity.md)).
- **Linear config exists ahead of the module** to record the lane → app →
  agent invariant; nothing reads it yet.

## Where each fact lives

| Fact | Owner |
| --- | --- |
| Config fields, task kinds, secrets and `.env` order | [docs/configuration.md](docs/configuration.md) |
| Startup, shutdown, `tick`, failed/blocked outcomes | [docs/application.md](docs/application.md) |
| Tool ids, plugin loading, permission matching, session driver contract | [docs/opencode.md](docs/opencode.md) |
| Knowledge scope, kinds, refresh | [docs/knowledge.md](docs/knowledge.md) |
| Dreaming run, memory contract, dreamer boundary | [docs/dreaming.md](docs/dreaming.md) |
| Discord behavior, setup, recovery | [docs/discord.md](docs/discord.md) |
| Browser service | [docs/browser.md](docs/browser.md) |
| Decisions | [docs/architecture.md](docs/architecture.md) |
| Status per milestone, live gates, next steps | [docs/roadmap.md](docs/roadmap.md) |
| Frozen product requirements | [docs/requirements.md](docs/requirements.md) |
| Unscheduled ideas | `docs/backlog/` (one file per topic) |
| Review findings (not specs; each has a disposition section) | `docs/review/` |

## Where things are

`packages/{core,host,knowledge,browser,discord,opencode,app}` with tests in
`packages/*/test/*.test.ts` (`node:test`; real SQLite and QMD, the real v2
client against a mock server). `scripts/` holds the smoke, schema, and live
checks; `schemas/` is generated. aivi reads one **home** (`~/.aivi`, or
`AIVI_HOME`): `aivi.json` (or a git-ignored `aivi.local.json`), `.env`, and
`state/` with `aivi.sqlite`, the QMD index, and dreaming transcripts.
`example/` is a home with everything enabled (`npm run aivi` points there);
the tests load it.

## Open threads

- Live gates: OpenCode and browser passed 2026-09-15; Discord still to
  re-check after today's changes (librarian directory, feedback messages).
- Next work, in order: [roadmap](docs/roadmap.md#next-in-order-of-intent).
- The docs restructure proposed in `docs/review/docs-consistency.md` §3 is
  deferred until the jobs/projects work settles.

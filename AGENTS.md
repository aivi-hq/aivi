# Working on aivi

aivi is an always-on teammate built around OpenCode v2. OpenCode stays the
runtime for agents, sessions, providers, tools, and permissions; aivi adds a
shared knowledge server, scheduled work, chat channels, and ticket
orchestration around it, all started by one `aivi serve`.

## Principles

- Lean on OpenCode v2. It is the core of aivi: when OpenCode already has a
  solution, use it instead of building our own.
- Be critical and protect the project. Do not blindly follow instructions;
  verify and confirm first.
- Always speak from confirmed truths. Verify and confirm.
- Simplicity in architecture and use, and a focus on performance.

## Build and test

- Node 26 (`engines` in `package.json`), pinned dependencies, npm workspaces.
- The `@opencode/*` family is one version set: every package pins the same
  version, and the root `overrides` enforces it.
- Packages compile to `dist/` with TypeScript 7 (`npm run build`,
  incremental) and publish that artifact untouched.
- Tests and typecheck resolve workspace packages to `src/` through the
  `development` exports condition (`--conditions=development`, plus
  `NODE_OPTIONS` so CLI children spawned by tests resolve sources too). Keep
  to erasable TypeScript syntax and `.ts` import specifiers — Node must run
  the sources directly.
- Test lifecycle, persistence, and configuration changes at the actual
  boundaries they affect. Live OpenCode, Discord and macOS Chrome
  verification are separate gates; mock tests do not establish those.
- Before finishing work, run `npm run agentic:verify`. The exit code is the
  verdict: 0 passed, anything else did not. Its output is one JSON blob —
  read it once and fix what it names. Do not run it again just to re-read
  the same blob; run it again only after a fix.

## Decisions

- Decide only with precedent. Before deciding anything, search the knowledge
  — recorded decisions, docs, memories, past conversations. What was ruled
  before wins.
- Without precedent, decide only when the answer is obvious.
- Any doubt at all: do not decide. Ask the human.

## Escape hatch

- Stuck on something that looks out of scope but should not be ignored: do
  not decide it away and do not stall on it. Open a triage ticket in the
  tracker for the finding and continue with the work you were given. The
  ticket is how the human hears about it.

## Timers

- No polling. No periodic timers. `setInterval` is banned outright.
- `setTimeout` only for a serious exception that a human has explicitly
  greenlit beforehand.

## Vocabulary

| Word | Meaning |
| --- | --- |
| task | the payload a job executes: `prompt` or `shell` (the only kinds a person or agent authors), or `invocation` (the `name` of an operation plus opaque `args`); never a thing you trigger — you trigger jobs, and a run is one execution of one |
| operation | a system capability of the host or a module, claimed by name exactly once at composition (a second claimant is fatal; a run of an unclaimed name fails with its name); seeded as `system` jobs by the module that owns it, shown by operation name in every view |
| job | a definition: a task plus *when*, recurring (`cron` + `timezone`) or one-off (`at`), with `id`, `title`, `resource`, `report`, `misfire`, `enabled`; state `active`/`paused`/`done`/`missed`; source `config` (config.json), `system` (seeded by the host: `retention`, `projects-sync`), `agent` (created through `aivi_jobs`) or `operator` (`aivi jobs add`); one outstanding run at a time |
| run | one execution of a job: `queued → running → succeeded / failed / blocked`, or `cancelled`, or `missed`; one row, one audit trail, always a `jobId`; snapshots the task |
| missed | a run recorded for an occurrence found later than its misfire grace; terminal, never executed, reported like a failure |
| turn | one prompt to a verified final answer in one OpenCode session (`runTurn`); a conversation turn is of kind `message` (a person) or `job` (an outcome re-entering) |
| pool / lease | a slot in a named capacity pool. Two systems coexist (no merger yet): **ticket work** draws the dispatcher's `dispatcher.pools` (the orchestrator asks, the dispatcher decides), while **jobs and channel turns** draw `scheduler.resources`: [orchestrator](docs/orchestrator.md) |
| blocked | ended without proof that the external side stopped; keeps its capacity until `runs resolve` |
| failed | ended before anything external happened; the next occurrence retries |
| report | where an outcome goes: `{to: "session", session}` (back into that session as a prompt), `{to: "channel", module, channel}` (posted by a channel module), or nothing; each carries `on` (`always`, `failure` or `never`; default `always`) for when it fires |
| source / kind | a configured document path, core or per-project, labelled `doc`, `decision`, `memory`, `conversation`, `manual` (docs shipped with an installed package); a file belongs to its most specific source |
| project | what the team works on: one directory `<home>/projects/<id>` holding a checkout (`source/`), its memory (`memory/`) and worker worktrees (`worktrees/`), discovered from that directory (`projects.<id>` in `config.json` only overrides), indexed by the docs convention (`projectDefaults`); channels talk *about* projects, workers (Linear, later) work *in* them; a project with `memory/` but no `source/` is a *removed* project (still listed and searchable until `projects purge --confirm`); a project may be **repo-less** — a forge gives the checkout, so with no forge a project has memory and knowledge but no source |
| forge / tracker | the two **systems** core names (in that order): a **forge** owns repositories (clones a project's checkout, branches, pull requests), a **tracker** owns tickets (lanes, delegation). Core spells the roles, never which plugin fills them; `projectRoles = ['forge', 'tracker']` |
| dreaming | a scheduled agent that turns conversations since its last run into `facts.md` and proposals |
| origin | `metadata.aivi.origin` on the OpenCode sessions aivi's **channel turns**, jobs and dreaming create — **not worker sessions**, which carry no aivi metadata and are known by the orchestrator's run rows: a channel **platform** id (`discord`, `slack`, `linear` — the platform a conversation is on, not the package that speaks for it, which is why `@aivi/tracker-linear` writes `linear`), `job`, `dreaming`; on messages also `job-result` |
| attribution | which names a commit carries: the bot as author/co-author from aivi's identity, the human as author from their own git config — a git fact, it never consults whoami ([people](docs/people.md)) |
| association | which person a record belongs to: link codes, job ownership, session stamps, memories — a host fact, taken from the calling bearer, never from what a message claimed ([people](docs/people.md)) |
| link | a channel account bound to a person, minted by `aivi link` and redeemed by `/link`; the binding is also the channel admission — who may talk, while config names only where ([people](docs/people.md)) |

## Where each fact lives

| Fact | Owner |
| --- | --- |
| Config fields, task kinds, secrets and `.env` order | [packages/host/docs/configuration.md](packages/host/docs/configuration.md) |
| Startup, shutdown, dispatch, failed/blocked outcomes, resolving blocked work, CLI | [docs/operations.md](docs/operations.md) |
| First run, the assistant in OpenCode, first project and channel | [docs/getting-started.md](docs/getting-started.md) |
| Module contract (`AiviServices`, `Store.migrate`, `fail`) | [docs/architecture.md](docs/architecture.md#one-application-contained-modules) |
| The plugin seam words (tracker stages, forge and platform adapters, project contributor) | [packages/plugin/docs/vocabulary.md](packages/plugin/docs/vocabulary.md) |
| Tool ids, plugin loading, permission matching, session driver contract | [docs/opencode.md](docs/opencode.md) |
| Knowledge scope, kinds, refresh | [docs/knowledge.md](docs/knowledge.md) |
| People, person tokens, linking, the client config (`~/.config/aivi/config.json`) | [docs/people.md](docs/people.md) |
| What a project is, home layout, docs convention, who works in one | [docs/projects.md](docs/projects.md) |
| Dreaming run, memory contract, dreamer boundary | [docs/dreaming.md](docs/dreaming.md) |
| Channel module contract, shared inbox/engine/turn runner, ids, report shape | [docs/channels.md](docs/channels.md) |
| Discord behavior, setup, recovery | [docs/discord.md](docs/discord.md) |
| Slack behavior, app manifest, setup | [docs/slack.md](docs/slack.md) |
| Linear behavior (the tracker's stages, stops and their trails, attribution), setup | [docs/linear.md](docs/linear.md) |
| How work gets picked and worked (orchestrator and dispatcher: lanes, priority, queue lanes, pools, leases; the tracker's stages, worker tools, completion and question contracts, recovery) | [docs/orchestrator.md](docs/orchestrator.md) |
| Browser service | [docs/browser.md](docs/browser.md) |
| Decisions | [docs/architecture.md](docs/architecture.md) |
| Product requirements | [docs/requirements.md](docs/requirements.md) |

## Where things are

`packages/{core,host,knowledge,plugin,browser,channel-discord,channel-slack,tracker-linear,forge-github,opencode,cli}` with tests in
`packages/*/test/*.test.ts` (`node:test`; real SQLite and QMD, the real v2
client against a mock server). `dist/` is built by `npm run build`
(TypeScript 7, incremental); tests need no build — they run from sources
under Node's type stripping, resolving workspace packages through the
`development` exports condition.
`scripts/` holds the smoke and live checks; the editor schema is generated at
runtime into `<state>/cache/schema.json`, composed from the plugin list. aivi reads one **home** (`~/.aivi`, or
`AIVI_HOME`): `config.json` (the live config, never version-controlled), `.env`,
`app/package.json` (the installed server, and the `aivi-plugins` list that
enables plugins), `projects/<id>/{source,memory,worktrees}` per project,
`memory/` (org), and `state/` with `aivi.sqlite`, the QMD index, the editor
schema cache, and dreaming transcripts.
`dev/` is a real development home, produced by `npm run aivi:cli setup` against
the local build (only its README is tracked; everything else, including the
app manifest setup writes, is generated or git-ignored). `npm run aivi:cli`
is the one script for everything against it, `-- serve` included.

# Jobs: what is left

Status: the design agreed 2026-09-15 is built, and the same day the model
was split into definitions (`jobs`) and executions (`runs`), misfire became
one grace rule with `missed` runs, and retention became the system job
`retention`. The facts live with their owners:

| Fact | Owner |
| --- | --- |
| Task kinds, `report` shapes, jobs/runs/tasks vocabulary and states, the misfire grace, `scheduler.retention`, agent-created jobs, operator commands (`jobs …`, `runs …`) | [configuration.md](../configuration.md) |
| Startup reconciliation and seeding, missed runs per tick, abort semantics, failed vs blocked, retention as a job | [application.md](../application.md) |
| `POST /v1/jobs`, `aivi_jobs` input, session authority, `agent.list` validation | [opencode.md](../opencode.md#jobs-tool) |
| Run outcomes re-entering a thread; report threads adopting the run's session; `/status` lists | [discord.md](../discord.md) |
| Schema v7, "it matched or it didn't", the API mutation revision, `job-result` origin | [architecture.md](../architecture.md) |

Verified live against OpenCode 2.0.3 on 2026-09-15 before the rename to
`aivi_jobs`: session lookup, agent validation, create/refuse paths. The
renamed tool and route, and the Discord parts (re-entry turns, report
threads, `/status`), still need their live gates.

## Not built, deliberately

Deferred until someone asks twice:

- Standing sessions per job (memory across runs belongs in files; if ever
  wanted: `session: "standing"`, a session id derived from the job id,
  OpenCode's inbox for ordering).
- Retries after the model or the process was reached.
- Digests and a "home channel".
- Executable allow-lists for scripts; `[SILENT]`-style markers (the librarian
  reading a re-entered result *is* the silence mechanism).
- Natural-language time parsing in aivi (the model translates; the tool
  echoes the next occurrences).
- Structured confirmation widgets in Discord ([discord-widgets](discord-widgets.md)).
- Per-user ownership of agent-created jobs: today every agent-created job is
  visible to and mutable by every caller the access policy admits; the owner
  accepted "jobs are the admin's responsibility" for now.
- A per-occurrence record of every missed minute (one `missed` run per job
  per gap was chosen so a week of downtime is one line).
- Editing a definition in place (`update`); today it is remove and create.

## Research notes (2026-09-14/15, official docs only)

- **Hermes** (`cronjob` tool, `/cron`, `hermes cron`): one tool with
  `create|list|update|pause|resume|run|remove`; fresh session per run;
  `deliver: origin` resolved at create time; `[SILENT]` marker; delivery
  failure is a distinct status; scheduled agents cannot use `cronjob` unless
  opted in; scripts under `$HERMES_HOME/scripts/` with a sanitized environment
  (no provider secrets); `mirror_delivery` makes a delivery continuable by
  seeding it into a thread's session (aivi binds the thread to the run's own
  session instead); `blocked_config` preflight; failure streak nudge at 3;
  catch-up collapses to one run.
  <https://hermes-agent.nousresearch.com/docs/user-guide/features/cron>,
  <https://hermes-agent.nousresearch.com/docs/developer-guide/cron-internals>.
- **OpenClaw** (Automations): payloads `system-event | message | command |
  script`; command payloads are operator-admin only with `--command-argv`,
  `--command-env KEY=VALUE`, `--command-cwd`, timeout and output caps;
  sessions `main | isolated | current | session:<id>`; unattended-run contract
  with `NO_REPLY` as the silent token; jobs created by an agent are capped to
  that turn's tools. <https://docs.openclaw.ai/automation/cron-jobs>,
  <https://docs.openclaw.ai/automation/cron-jobs/payloads>.
- **OpenCode v2**: no scheduler or timer concept; `session.prompt` with
  `delivery: queue` is a durable per-session inbox (aivi's `runTurn` and the
  native re-entry use it); events are live-only. OpenCode owns per-session
  ordering; the host keeps jobs, runs and leases.

# Jobs: what is left

Status: the design agreed 2026-09-15 is built (steps 1–6 of the original
order, same day). The facts now live with their owners:

| Fact | Owner |
| --- | --- |
| Task kinds, `shell` environment, `report` shapes (`session`, channel, none), agent-created jobs, `aivi_schedule` behaviour, `misfire`, operator commands (`--at`, `jobs abort`, `schedules …`) | [configuration.md](../configuration.md) |
| Abort semantics, failed vs blocked | [application.md](../application.md) |
| `POST /v1/schedule`, tool input, session authority, `agent.list` validation | [opencode.md](../opencode.md#schedule-tool) |
| Job outcomes re-entering a thread; report threads adopting the job session; `/status` lists | [discord.md](../discord.md) |
| The API mutation revision, `job-result` origin | [architecture.md](../architecture.md) |

Verified live against OpenCode 2.0.3 on 2026-09-15: session lookup, agent
validation, create/refuse paths. The Discord parts (re-entry turns, report
threads, `/status`) still need their live gate.

## Not built, deliberately

Deferred until someone asks twice:

- Standing sessions per schedule (memory across runs belongs in files; if ever
  wanted: `session: "standing"`, a session id derived from the schedule id,
  OpenCode's inbox for ordering).
- Retries after the model or the process was reached.
- Digests and a "home channel".
- Executable allow-lists for scripts; `[SILENT]`-style markers (the librarian
  reading a re-entered result *is* the silence mechanism).
- Natural-language time parsing in aivi (the model translates; the tool
  echoes the next occurrences).
- Structured confirmation widgets in Discord ([discord-widgets](discord-widgets.md)).
- Per-user ownership of agent-created schedules: today every agent-created
  schedule is visible to and mutable by every caller the access policy admits;
  the owner accepted "jobs are the admin's responsibility" for now.
- A schedule's `title` on one-offs (jobs have no title column; the prompt's
  first line is the label).

## Research notes (2026-09-14/15, official docs only)

- **Hermes** (`cronjob` tool, `/cron`, `hermes cron`): one tool with
  `create|list|update|pause|resume|run|remove`; fresh session per run;
  `deliver: origin` resolved at create time; `[SILENT]` marker; delivery
  failure is a distinct status; scheduled agents cannot use `cronjob` unless
  opted in; scripts under `$HERMES_HOME/scripts/` with a sanitized environment
  (no provider secrets); `mirror_delivery` makes a delivery continuable by
  seeding it into a thread's session (aivi binds the thread to the job's own
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
  ordering; the host keeps schedules, the queue and leases.

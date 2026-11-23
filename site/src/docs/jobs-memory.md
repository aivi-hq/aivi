---
title: Jobs and memory
description: Schedule work, read the run history, and let dreaming keep the memory tidy.
order: 5
group: Use aivi
---

aivi can start work without a person in the room. A job says what to do and when. A run is one execution of that job, with its own record. Memory is what survives after the run ends.

## Jobs

A job is a definition. It has a task and a schedule, either recurring or one-off. Jobs come from four places:

- `config`, written in `config.json`.
- `system`, seeded by the host for retention and project sync.
- `agent`, created by the assistant through the `aivi_jobs` tool.
- `operator`, created with `aivi jobs add`.

A task is one of three kinds:

| Kind | What it does |
| --- | --- |
| `prompt` | Runs one agent turn in a directory and waits for a verified answer. |
| `shell` | Runs an argv command. Exit 0 succeeds, another exit fails, a timeout blocks. |
| `invocation` | Runs a system operation by name, such as `knowledge.index`. |

People and agents author `prompt` and `shell` tasks. `invocation` exists so the host and its modules can schedule their own operations with the same machinery.

### A configured job

```json
{
  "jobs": [
    {
      "id": "morning-brief",
      "title": "Morning brief",
      "cron": "0 8 * * 1-5",
      "timezone": "Europe/Amsterdam",
      "task": {
        "kind": "prompt",
        "agent": "assistant",
        "directory": "/home/ada/.aivi",
        "prompt": "Post a short brief: merged pull requests, open reviews that need a person, and anything that failed overnight."
      },
      "report": {
        "to": "channel",
        "module": "discord",
        "channel": "123456789",
        "on": "always"
      }
    }
  ]
}
```

`report` decides where the outcome goes. A channel report posts to the platform the module names. A session report enters the session as a prompt, so the agent there can read the outcome and answer in its own words. `on` can be `always`, `failure` or `never`.

Config changes take effect after a restart. Jobs created by an agent or by `aivi jobs add` are paused, resumed and removed through the CLI or the tool, and a config change never touches them.

### Jobs from a file

```sh
aivi jobs add brief.json --cron "0 8 * * 1-5" --timezone Europe/Amsterdam --title "Morning brief"
aivi jobs add remind.json --at 2h
aivi jobs list
aivi jobs run morning-brief
```

The file holds a bare task, or `{ task, report?, resource? }`. With neither `--cron` nor `--at`, the job runs once as soon as capacity is free.

### Jobs from chat

Any agent with the aivi plugin gets the `aivi_jobs` tool. People can ask in ordinary language:

> Every Monday at 09:00, post a summary of last week's merged pull requests.

The agent translates the time into a cron expression, checks that the report can be delivered, and creates the job. The tool returns the next occurrences so the agent can confirm what it made. A session that is itself a job cannot create another job, which keeps schedules from spawning more schedules.

## Runs

Every execution is a run with one row, one audit trail and one job id. The states are:

| State | Meaning |
| --- | --- |
| `queued` | Waiting for capacity. |
| `running` | The task is executing. |
| `succeeded` | The task finished. |
| `failed` | It ended before anything external happened. The next occurrence retries. |
| `blocked` | It ended without proof that the external side stopped. It keeps its capacity until a person resolves it. |
| `cancelled` | A queued run was cancelled. |
| `missed` | The occurrence was found after its misfire grace. It is recorded, never executed, and reported like a failure. |

Inspect the recent ones:

```sh
aivi runs list
aivi runs show RUN_ID
aivi runs list --state blocked
```

A blocked run holds a model slot because aivi cannot prove that the session stopped doing work. Look at the session, then resolve it explicitly:

```sh
aivi runs resolve RUN_ID --outcome succeeded --reason "Inspected the session" --confirm-stopped
```

`aivi runs cancel RUN_ID` only cancels a queued run. `aivi runs abort RUN_ID` asks the scheduler to stop a running run, which ends it `blocked` and leaves the same resolution step.

### Misfires

When the host starts, it looks for occurrences it missed. If an occurrence is later than its grace period, aivi records one `missed` run for the gap and advances to the next occurrence. It does not replay every missed minute.

A time-bound job, such as a 09:00 standup, can keep the default grace of 60 seconds. A job that should run whenever the server is back, such as a nightly index, sets a large grace in its own `misfire` block.

## Dreaming

Dreaming is a scheduled prompt that reads the conversations since its last run and distils what should be remembered. It writes plain Markdown into the memory homes, which are indexed like any other source.

A typical schedule:

```json
{
  "jobs": [
    {
      "id": "dreaming",
      "cron": "0 3 * * *",
      "timezone": "Europe/Amsterdam",
      "task": {
        "kind": "invocation",
        "name": "dreaming",
        "args": { "memoryDirectory": "memory" }
      }
    }
  ]
}
```

The job tracks a cursor for each memory home. It reviews sessions newer than the cursor whose origin is a channel or a voice room, and it never reviews its own runs. Nothing new means no model call.

Each session gets its own dreamer turn and transcript. The transcript is deleted when the turn succeeds, because the OpenCode session is the record. A failed turn keeps its transcript for the post-mortem and leaves the cursor at the last session that finished, so the next run resumes with the failed one.

### What memory looks like

| File | Written by | Purpose |
| --- | --- | --- |
| `memory/facts.md` | dreaming | Current truth, as dated and attributed bullets grouped by topic. |
| `memory/archive.md` | dreaming | How things used to be. Superseded facts land here with their dates. |
| `memory/proposals/rules.md` | dreaming | Conventions and red lines people stated, waiting for a person to approve them. |
| `memory/proposals/skills.md` | dreaming | Repeatable tasks that could become skills. |
| `rules.md`, agent files, skills | people | The standing instructions. Dreaming cannot write here. |

A project has the same structure under `projects/<id>/memory/`. The dreamer decides whether a fact belongs to the organization or to one project, and it reconciles against the current file before writing. A retry does not duplicate a fact.

Reviewing proposals is a conversation. Open the memory files, read what the dreamer noticed, and move what should become a rule into the place where rules live. Dreaming only proposes changes; a person decides what becomes a rule.

## Retention

The host seeds a `retention` job that deletes finished runs and finished one-off jobs older than 30 days. Blocked and active runs are never touched, and recurring jobs stay. Change the window in `scheduler.retention`, or turn the job off with `false`.

The request diary and other logs have their own command:

```sh
aivi host clear-logs --older-than 30d
```

## What to read next

- [Running aivi](running.html) for the service, logs and recovery.
- [Dreaming](https://github.com/aivi-hq/aivi/blob/main/docs/dreaming.md) for the full memory contract.
- [Configuration](https://github.com/aivi-hq/aivi/blob/main/packages/host/docs/configuration.md) for every job field.

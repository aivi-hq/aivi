# Configuration

## Home

aivi reads one directory, the **home**: `~/.aivi` by default, or `AIVI_HOME`.
It holds `aivi.json`, `.env`, and `state/` (SQLite, the search index, dreaming
transcripts). There is no config-path option. If `aivi.local.json` exists in
the home it is used instead of `aivi.json`; `*.local.json` is git-ignored, so a
checked-in home such as `example/` can carry a private setup beside the public
one. In this repository `npm run aivi` sets `AIVI_HOME=example`; that home has
every feature enabled, so `serve` needs `DISCORD_BOT_TOKEN` in `example/.env`
unless the `modules.discord` block is removed.

`aivi.json` is installation configuration. `aivi.project.json` lives inside each
registered project. OpenCode's own files stay in their native locations.
Unknown fields and invalid combinations fail validation; nothing silently falls
back to another project or resource pool.

Paths in installation config and in task files resolve relative to the home.
Project source paths resolve relative to the project directory. The home is
also the OpenCode location: agents live in `<home>/.opencode/agents/`.

## Fields

| Field | Default / purpose |
| --- | --- |
| `version` | Required; `1` |
| `stateDirectory` | `state` inside the home |
| `host.bind` | `127.0.0.1`. Use a LAN/tailnet address or `0.0.0.0` so remote OpenCode installs can reach the knowledge server |
| `host.port` | `4100` |
| `host.auth.mode` | `token` (default): callers send `AIVI_TOKEN` as a bearer token. `none`: trust the network (loopback, Tailscale, LAN you control) |
| `opencode.url` | Omit to discover the local `opencode service` automatically (recommended). Set only for a server elsewhere; then `OPENCODE_USERNAME`/`OPENCODE_PASSWORD` supply its basic-auth credentials |
| `knowledge` | Core sources, each `{id, path, kind?}`; kinds: `doc` (default), `decision`, `memory`, `conversation` |
| `projects` | Project registry, each `{id, directory}` |
| `modules.discord.config` | Optional path to Discord module settings |
| `browser` | On by default: aivi launches its own Chrome with a profile in `state/chrome` on first use. `false` disables it; an object selects another mode or limits; see [browser setup](browser.md) |
| `search` | Optional `{provider: "qmd", indexOnStart: true, maxPending: 32}` |
| `scheduler.maxConcurrent` | `1`; counts running and blocked jobs |
| `scheduler.resources` | `{"local-model": 1}`; named pool limits |
| `scheduler.pollMs` | `1000`; polling interval, no model call |
| `schedules` | Empty; named cron/timezone/resource/task entries, each with optional `report` and `enabled` (default `true`) |

## Tasks

| Kind | Fields | Outcome |
| --- | --- | --- |
| `system.check` | – | Reports whether every knowledge source path exists |
| `knowledge.index` | – | Refreshes the search index |
| `shell` | `command` (argv array, never a shell string), `cwd`, `env` (merged over the inherited environment), `timeoutMs` (10 min) | Exit 0 succeeds, other exits fail, a timeout blocks; stdout/stderr tails are kept. The process inherits the host environment minus aivi's secrets (`AIVI_TOKEN`, `DISCORD_BOT_TOKEN`, `OPENCODE_*`, and every key of `<home>/.env`); set a secret in `env` on purpose if a script needs it |
| `opencode.prompt` | `agent`, `directory`, `prompt`, `timeoutMs` (30 min), `onPermission` (`reject`/`fail`) | Runs one agent turn to a verified answer; see [OpenCode integration](opencode.md) |
| `dreaming` | `memoryDirectory`, `agent` (`dreamer`), `directory` (the home), `origins` (`["discord"]`), `maxSessions`, `timeoutMs` | Reviews conversations since the last run and maintains memory files; see [dreaming](dreaming.md) |

## Reporting

Any schedule, or a task file passed to `jobs enqueue` as `{ "task": …, "report": …, "resource"?: … }`,
may carry `"report": { "to": "discord", "channel": "<id>", "on": "always" | "failure" | "never" }`.
`to` names a destination a running module registered; the module decides whether
aivi may post there (Discord: `reportChannels` in its config). Delivery success
or failure is recorded in the job's audit history and never changes the job's
outcome. See `example/tasks/shell.json`.

Scheduling starts at the next future occurrence on initial registration. Restart
preserves the next occurrence for unchanged definitions. Changes cancel stale
queued occurrences and calculate a new next time. Existing active work remains
owned. Config changes require a daemon restart; `schedules sync` also provides
explicit reconciliation when the daemon is stopped.

## Linear mapping (validation only)

Installation config maps each application key to one unique OpenCode agent:

```json
{ "linear": { "applications": { "dev-app": { "agent": "dev" } } } }
```

The project config selects applications by lane:

```json
{
  "knowledge": [{ "id": "adrs", "path": "docs/adr" }],
  "linear": {
    "workspaceId": "linear-workspace-id",
    "projectId": "linear-project-id",
    "lanes": { "Development": "dev-app", "Review": "dev-app" }
  }
}
```

Multiple lanes can reuse `dev-app`. Another application cannot also map to `dev`.
Global/project OpenCode configuration still resolves the agent named `dev`.
These application keys are configuration references; OAuth credentials and native
application installation details belong to the future Linear adapter.

## Operator commands

Run `npm run aivi -- --help` for commands.
The `--key` on `jobs enqueue` deduplicates identical requests; changed payloads
with the same key are rejected. Failed jobs do not retry automatically.

Use `jobs show ID` for the task, session ID, result, and transition history.
`jobs cancel ID` only cancels queued work. Resolving a blocked job is an explicit
operator action described in [OpenCode setup](opencode.md).

## Secrets

Secrets never live in JSON files. They come from the process environment, and
the CLI loads dotenv-style files without overriding variables that are already
set: `<home>/.env`. `fnox exec` works the same way. Variables: `AIVI_TOKEN`, `DISCORD_BOT_TOKEN`,
`OPENCODE_USERNAME`/`OPENCODE_PASSWORD` (only with `opencode.url`).

With `host.auth.mode: "token"`, `AIVI_TOKEN` (at least 24 characters) must be
present in the host environment and in the OpenCode server's environment for the
plugin. With `mode: "none"` no token is needed anywhere; the host logs a warning
when it binds beyond loopback without auth. Per-device tokens and SSO (via a
reverse proxy) are planned as further modes. The plugin never receives an API
for reading host secrets.

The host discovers OpenCode through the SDK's service registration
(`~/.local/state/opencode/service.json`), so the random service port and its
basic-auth password never appear in aivi configuration.

Shell tasks never inherit these secrets: the child process gets the host
environment minus the fixed names above and minus every key defined in
`<home>/.env`. Everything else (PATH, HOME, the operator's shell variables)
passes through, and a task's own `env` map is merged on top.

`aivi serve` logs one JSON object per line on stderr; `--log-level debug` shows
schedule materialization. stdout is reserved for command output.

JSON schemas are generated into `schemas/` by `npm run schema`; `npm run check`
fails when they are stale. Point your editor at them for autocompletion and
field descriptions: `"$schema": "../schemas/aivi.schema.json"` (relative to the
config file) in `aivi.json`, `aivi.project.json`, and the Discord config. Runtime validation additionally checks cron
expressions, timezones, uniqueness, and references across project files.

`aivi serve` is the single application command. See [application lifecycle](application.md)
for ownership and [knowledge search](knowledge.md) for indexing and retrieval.

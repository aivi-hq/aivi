# Native OpenCode integration

aivi uses the published `@opencode/client` and `@opencode/plugin` 2.0.3 packages:
the v2 `Plugin.define` API and native session operations. It does not patch
OpenCode or read its private storage.

## Plugin tools and permission actions

The aivi plugin registers these tools for the OpenCode **Location** that loads
it, so every agent in a directory that loads the plugin has them. The **effective
id is also the permission action** you write rules against (`aivi_jobs` and
`aivi_browser` are confirmed in their sections below; the rest follow the same
rule). Every aivi tool is a Code Mode tool, so the agent also needs the `execute`
action, which OpenCode's default policy already allows. There is **no per-agent
tool allowlist in v2** — availability is location-scoped registration, and you
grant or withhold each tool with `permissions`.

| Tool | Permission action | What it does | Permissions notes |
| --- | --- | --- | --- |
| `knowledge_search` | `knowledge_search` | Keyword search over configured knowledge; returns source paths and excerpts | Runs over the host API, not a file read. Opening a full document still uses `read` (and `external_directory` when the source is outside the Location). |
| `knowledge_projects` | `knowledge_projects` | List the projects and the source kinds each is searchable by | Read-only. |
| `aivi_sources` | `aivi_sources` | List configured knowledge sources and their paths | Read-only. |
| `aivi_status` | `aivi_status` | aivi version, job counts and capabilities | Read-only; does not start work. |
| `aivi_context` | `aivi_context` | This conversation's context window, tokens, cost and knowledge scope | Read-only; takes the session id from the tool context. |
| `aivi_jobs` | `aivi_jobs` | Create/list/pause/resume/remove/run jobs | Schedules work. Turn the tool off host-wide with `scheduler.agentSchedules: false`. |
| `aivi_browser` | `aivi_browser` | aivi's own Chrome for unattended sessions | Distinct from OpenCode's `browser.*` desktop tools. The example librarian denies `browser` (OpenCode's), **not** this one. |

### Giving tools to an agent

OpenCode's base policy for every agent is `{action: "*", resource: "*", effect:
"allow"}`, so all aivi tools are **allowed by default** — you usually grant them
by doing nothing, and withhold one with a deny. To scope per agent, add rules to
that agent's file (`<home>/.opencode/agents/<agent>.md` frontmatter `permissions:`,
or `agents.<id>.permissions` in config); rules combine in order and the **last
match wins**, so put the broad rule before its exceptions.

```yaml
# allow scheduling and knowledge lookup, but nothing browser-related
permissions:
  - { action: "aivi_browser", resource: "*", effect: "deny" }
  - { action: "aivi_jobs",    resource: "*", effect: "allow" }
```

Because these are Code Mode tools, denying `execute` removes all of them at once.
The home **is** the OpenCode Location, so its `knowledge/`, `memory/` and
`projects/` directories need no `external_directory` rules; sources elsewhere get
those from aivi per session ([below](#host-submission)). Mentioning a tool in the
agent's prompt is how you tell it to *use* one — it does not gate access.

### Adding agents

An agent is one Markdown file. In aivi the home **is** the OpenCode Location, so
add `<home>/.opencode/agents/<name>.md`; to offer it in every project, use
`~/.config/opencode/agents/<name>.md`. The frontmatter holds the config fields
(`description`, `mode`, `model`, `permissions`, …) and the **body is the system
prompt** — put instructions there, not in a `system` frontmatter field. Full
field list: [OpenCode agents](https://opencode.ai/v2/docs/agents).

A new agent in this Location already has every aivi tool (the plugin registers
them here and the default policy allows them); list the tools you want it to
reach in the body so it uses them. **Per-project override:** a project's own
`.opencode/agents/<name>.md` in its checkout replaces the home's agent of the
same id for that project ([linear](linear.md)). Do not carry v1 frontmatter over
(`tools`, `permission`, `prompt`, `disable`, `maxSteps`, `temperature`,
`top_p`) — v2 uses `permissions`, `disabled` and `steps`.

Project-override agents get the aivi tools too: the plugin is discovered from
the home as an ancestor of the checkout or worktree, and aivi's own turn runner
(Discord, Slack, Linear) adds `external_directory` allows for every configured
knowledge source — so those agents can both search and read the documents. To
guarantee the tools anywhere, declare the plugin once in the global config.

## Verified boundary (OpenCode 2.0.3, macOS, 2026-09-15)

Milestone 0 of the roadmap, run against a real `opencode service` with
`github-copilot/gemini-3.8-flash`. Repeat it any time with
`npm run live:opencode -- --plugin "$PWD/example"`.

| Question | Finding |
| --- | --- |
| How is the server found? | `opencode service` registers `~/.local/state/opencode/service.json` with a random loopback port and a password. `Service.discover()` from `@opencode/client/service` returns it. aivi uses that; `opencode.url` is only an override. |
| Authentication | HTTP basic (`opencode:<password>`). Anonymous and bearer requests get 401. |
| Client-chosen IDs | `session.create({ id: "ses_aivi_…" })` and `session.prompt({ id: "msg_aivi_…" })` are accepted; nested `metadata` objects are stored and returned. |
| Turn completion | After `session.prompt` (`delivery: "queue"`), `session.wait` returns when the turn ends (about 2 s for a trivial prompt). `session.context` then shows `user → assistant(finish: "stop", time.completed) → idle(outcome: "succeeded")`. This is what the host's `finalAnswer` checks (jobs, dreaming and Discord). |
| Permission prompts | A tool that needs approval (for example `external_directory` when reading a knowledge source outside the project) parks the turn; `session.wait` blocks until a human replies. `permission.asked` on the event stream announces each request (`{ id, sessionID, action, resources }`); `permission.list({ sessionID })` shows what is already pending and `permission.reply` answers it. aivi answers from the event, and reads the list once after the prompt for requests that predate it (verified 2026-09-15). |
| Plugin loading | A directory entry in `plugins` resolves `<dir>/server.*` or `<dir>/index.*`, not `package.json#main`. `packages/opencode/server.js` re-exports the build for that reason. Loading is location-scoped: the plugin is instantiated per project directory that configures it. |
| Plugin failure mode | An exception in `setup()` marks the plugin `failed` and registers no tools. The plugin therefore never throws for a missing token; the tool call reports the 401. |
| Tool invocation | Plugin tools are exposed to the model through codemode, for example `return await tools.aivi.status();`. Effective ids are `aivi_status`, `aivi_sources`, `aivi_jobs`, `aivi_browser`, `knowledge_search`, `knowledge_projects` (`GET /v1/projects`: id, `removed`, searchable source kinds), `aivi_context` (`GET /v1/context?session=`: the calling session's context window, totals and knowledge scope as markdown, the same text as the channels' `/context`); tools return `output` (value) and `content` (text). `aivi_status` returns `{ version, counts, sources, leases, completion, upcoming, recent }`. See [Plugin tools and permission actions](#plugin-tools-and-permission-actions) for the permission actions to write rules against. |
| Permission matching | Documented in [permissions](https://opencode.ai/v2/docs/permissions): `*` matches any characters **including `/`**, rules combine in order and the **last match wins**, `external_directory`/`read`/`edit` resources are canonical absolute paths (`realpath`). aivi's session rules are appended after the agent's, so an `edit` allow from dreaming wins over the dreamer's `edit: deny`; aivi never sends a broad allow, so OpenCode's default `.env` guard stays in force. |
| History access | `session.list` (paginated; filter by `directory`/`project`), `message.list`, `session.export`, `session.context`. There is no cross-session search: any "what did we discuss" feature needs a derived index. |
| Changes to a local plugin | The server caches module resolution; run `opencode service restart` after changing the plugin package layout **or after `npm install` rewrites `node_modules`** (the plugin otherwise fails with "Cannot find package"). The restart also reloads every client of that service, including an open TUI. |
| `session.list` order | `order: "desc"` sorts by `time.updated`, not creation: a prompted older session moves to the top. Dreaming's cursor relies on this. |
| Agent model (2026-09-15) | A session created with `agent` but no `model` runs `model.default`, not the agent file's `model`; only the TUI substitutes it. `agent.list({ location: { directory } })` returns each agent with its resolved `model: { id, providerID }` (`agent.get` does not see agents under a directory's `.opencode/`). `session.create` takes `model`; `session.switchModel` (`POST /api/session/{id}/model`) changes it later and `session.get().model` shows it. The `model` field of `session.prompt` does not exist; the client drops it. |
| `.env` under aivi's session policy | With `read *` allow followed by `*.env` deny, a read of `.env` ends as a tool error (no permission prompt); a sibling file reads fine; the content never enters the transcript. |
| Event stream (2026-09-15) | `client.event.subscribe()` is `GET /api/event` as `text/event-stream`: global, live-only (no replay), no automatic reconnect; an `AsyncIterable` of events with `type` and `data.sessionID`. During a turn it emits `session.execution.started`, `session.step.started/streamed/ended`, `session.tool.input.started` (`{ sessionID, assistantMessageID, id, name }`), `session.tool.input.ended`, `session.tool.called` (`data.input`), `session.tool.progress`, `session.tool.success` / `session.tool.failed`, `session.text.started/delta/ended`, `session.usage.updated`, `session.execution.succeeded/failed/interrupted`. Under codemode the tool name is `execute` and the aivi tools are calls inside `input.code` (`tools.aivi.status()`, `tools.knowledge.search({…})`); native tools (`read`, `grep`, `glob`, `webfetch`, `bash`) appear by name. `session.log({ follow: true })` yields only `log.synced` and is not usable for progress. The host's one stream and its reconnect loop: [channels](channels.md#progress-while-a-turn-runs). |

## Librarian in native chat

Walkthrough in [getting started](getting-started.md#the-librarian-in-opencode).
The home is the OpenCode location, so the example's knowledge, memory and
project directories need no `external_directory` rules; sources elsewhere get
those rules from aivi per session. The OpenCode service caches
`@aivi/host/client`, so restart it after every change to the plugin or client
(`opencode.lifecycle: "own"` does this at `aivi serve` startup).

## Host submission

Leave `opencode.url` unset and the host discovers the local service. Set it only
for a server elsewhere, with `OPENCODE_USERNAME`/`OPENCODE_PASSWORD` if that
server requires basic auth. `opencode.lifecycle` decides the rest. `own`
(default): when `aivi serve` starts it replaces a running service through the
SDK (`Service.stop` with `pty: "handoff"`, then `Service.ensure`), so the
service carries the current plugin build; aivi is then
the one process to supervise. This happens once, before any module or job, when
aivi has no work of its own; a turn in flight in the old service at that instant
is cut short, its session is not. Later, a missing service is started on the
next unit of work; a running one is never restarted again while aivi runs.
`ensure` only starts a missing service; `discover` never starts or stops.

```sh
npm run aivi -- opencode check
npm run aivi -- jobs add example/tasks/librarian.json
npm run aivi -- runs list
```

The running host dispatches queued runs through the session driver
(`packages/host/src/session.ts`): create the session with a client-chosen id,
pin agent, directory and model, prompt, wait, answer permission prompts per policy, and
verify the final answer (`assistant.finish === "stop"`, `idle.outcome ===
"succeeded"`, no unfinished tools, text present). The run then succeeds with
`{ sessionId, text, rejectedPermissions }`. The model is a session property that
the API does not fill in from the agent file (seen live 2026-09-15: sessions ran
OpenCode's default model instead of the librarian's), so every turn resolves it:
the agent's `model` from `agent.list` for the directory, or a conversation's
`/model` pin; it goes into `session.create` and, when `session.get` shows
something else, through `session.switchModel` before the prompt. An agent file
that pins none leaves OpenCode's default alone. The agent file is the boundary for every caller: a `prompt` job
sends no session rules; Discord adds `external_directory` allows for the
configured sources; dreaming adds those plus `edit` allows for its two write
targets. aivi never sends a deny.

Task options: `timeoutMs` (default 30 min) and `onPermission`: `reject`
(default; deny and let the agent continue, recorded in the result) or `fail`
(leave the prompt pending for a human and block the run). Which failures end
`failed` and which `blocked`, and how an operator releases a blocked run, is in
[operations](operations.md#how-runs-end). Channel turns use the same driver.
Interrupting a worker at Linear's request will reuse `session.interrupt` as
`/stop` does.

## Jobs tool

The plugin registers `aivi_jobs` (namespace `aivi`, permission action
`aivi_jobs` like the other aivi tools). Its input is flat: `action`
(`create|list|pause|resume|remove|run`), `id` for the last four, and for
`create` one of `prompt`/`command`, one of `at`/`cron` (+ `timezone`), optional
`title`, `agent`, `directory`, `cwd`, `env`, `timeoutMs`, `report`
(`session` default; `channel`, with `channel` and `module` defaulting to the
calling conversation's own channel and platform; `none`) and `on`. The tool adds the
calling `sessionID` and `messageID` from the native tool context; the host
reads the session's agent, directory and `metadata.aivi.origin` from OpenCode
and refuses sessions with origin `job` or `dreaming` (a job's own session
adopted by a Discord thread is a conversation and is allowed). The route is
`POST /v1/jobs`, same bearer auth as every other route; `messageID` is the
dedupe key of a one-off, so a retried tool call creates one job, not two. The
host validates the agent with `agent.list` for that directory before creating
anything (verified 2026-09-15: `agent.get` does not see agents defined under a
directory's `.opencode/`, `agent.list` with a location does). Behaviour and
the configuration switch are in
[configuration](configuration.md#agent-created-jobs).

## Browser tool

The plugin also registers `aivi_browser` (permission action `aivi_browser`). Ownership comes from the native tool context, not tool arguments.
Configure the host browser service before using it; see [browser setup](browser.md).

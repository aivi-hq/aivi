# Native OpenCode integration

aivi uses the published `@opencode/client` and `@opencode/plugin` 2.0.3 packages:
the v2 `Plugin.define` API and native session operations. It does not patch
OpenCode or read its private storage.

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
| Permission prompts | A tool that needs approval (for example `external_directory` when reading a knowledge source outside the project) parks the turn; `session.wait` blocks until a human replies. `permission.list({ sessionID })` exposes the pending request and `permission.reply` answers it. Any unattended driver must check this. |
| Plugin loading | A directory entry in `plugins` resolves `<dir>/server.*` or `<dir>/index.*`, not `package.json#main`. `packages/opencode/server.js` re-exports the build for that reason. Loading is location-scoped: the plugin is instantiated per project directory that configures it. |
| Plugin failure mode | An exception in `setup()` marks the plugin `failed` and registers no tools. The plugin therefore never throws for a missing token; the tool call reports the 401. |
| Tool invocation | Plugin tools are exposed to the model through codemode, for example `return await tools.aivi.status();`. Effective ids are `aivi_status`, `aivi_sources`, `aivi_schedule`, `aivi_browser`, `knowledge_search`; tools return `output` (value) and `content` (text). `aivi_status` returns `{ version, counts, sources, leases, completion, upcoming, recent }`. |
| Permission matching | Documented in [permissions](https://opencode.ai/v2/docs/permissions): `*` matches any characters **including `/`**, rules combine in order and the **last match wins**, `external_directory`/`read`/`edit` resources are canonical absolute paths (`realpath`). aivi's session rules are appended after the agent's, so an `edit` allow from dreaming wins over the dreamer's `edit: deny`; aivi never sends a broad allow, so OpenCode's default `.env` guard stays in force. |
| History access | `session.list` (paginated; filter by `directory`/`project`), `message.list`, `session.export`, `session.context`. There is no cross-session search: any "what did we discuss" feature needs a derived index. |
| Changes to a local plugin | The server caches module resolution; run `opencode service restart` after changing the plugin package layout **or after `npm install` rewrites `node_modules`** (the plugin otherwise fails with "Cannot find package"). The restart also reloads every client of that service, including an open TUI. |
| `session.list` order | `order: "desc"` sorts by `time.updated`, not creation: a prompted older session moves to the top. Dreaming's cursor relies on this. |
| `.env` under aivi's session policy | With `read *` allow followed by `*.env` deny, a read of `.env` ends as a tool error (no permission prompt); a sibling file reads fine; the content never enters the transcript. |

## Librarian in native chat

1. Build with `npm ci && npm run build`.
2. Start aivi, for example `npm run aivi -- serve`
   (with `AIVI_TOKEN` from fnox, or `host.auth.mode: "none"` on a trusted machine).
3. With `mode: "token"`, export the same `AIVI_TOKEN` in the OpenCode **server**
   environment and `opencode service restart`. Restart the service after
   every rebuild of the plugin or the host client as well: the long-running
   service keeps `@aivi/host/client` in its module cache, so a plugin that
   registers a new tool can still call a client without that method
   ("client.schedule is not a function", seen 2026-09-15).
4. Open `example/` in OpenCode v2. Its `opencode.jsonc` loads the local plugin
   and selects the `librarian` agent from `.opencode/agents/`.
5. Ask it to list aivi sources and read the company handbook.

The example agent denies shell, edits, and subagent launches; everything else
is OpenCode's default. The home is the OpenCode location, so the example's
knowledge, memory and project directories are inside it and need no
`external_directory` rules. Sources elsewhere (project checkouts) get those
rules from aivi per session.

## Host submission

Leave `opencode.url` unset and the host discovers the local service. Set it only
for a server elsewhere, with `OPENCODE_USERNAME`/`OPENCODE_PASSWORD` if that
server requires basic auth. aivi never starts or stops the service;
`opencode service start` does.

```sh
npm run aivi -- opencode check
npm run aivi -- jobs enqueue example/tasks/librarian.json
npm run aivi -- jobs list
```

The running host dispatches queued jobs through the session driver
(`packages/host/src/session.ts`): create the session with a client-chosen id,
pin agent and directory, prompt, wait, answer permission prompts per policy, and
verify the final answer (`assistant.finish === "stop"`, `idle.outcome ===
"succeeded"`, no unfinished tools, text present). The job then succeeds with
`{ sessionId, text, rejectedPermissions }`. The agent file is the boundary for every caller: an `opencode.prompt` job
sends no session rules; Discord adds `external_directory` allows for the
configured sources; dreaming adds those plus `edit` allows for its two write
targets. aivi never sends a deny.

Task options: `timeoutMs` (default 30 min) and `onPermission`: `reject`
(default; deny and let the agent continue, recorded in the result) or `fail`
(leave the prompt pending for a human and block the job). A failure before the
prompt is accepted (OpenCode unreachable, session create/get rejected) ends the
job `failed`; the next occurrence retries. A timeout, a failed turn, a changed
agent/directory, or a host shutdown mid-turn block the job, because none of
those prove the session stopped doing things. Blocked jobs keep
their capacity until an operator has looked at the session:

```sh
npm run aivi -- jobs resolve JOB_ID --outcome succeeded --reason "Inspected completed session" --confirm-stopped
```

Discord uses the same driver for each turn. Steering an active worker into
cleanup (the Linear lifecycle) is not part of the driver yet.

## Schedule tool

The plugin registers `aivi_schedule` (namespace `aivi`, permission action
`aivi_schedule` like the other aivi tools). Its input is flat: `action`, and for
`create` one of `prompt`/`command`, one of `at`/`cron` (+ `timezone`), optional
`title`, `agent`, `directory`, `cwd`, `env`, `timeoutMs`, `report`
(`session` default, `discord` + `channel`, `none`) and `on`. The tool adds the
calling `sessionID` and `messageID` from the native tool context; the host
reads the session's agent, directory and `metadata.aivi.origin` from OpenCode
and refuses sessions with origin `job` or `dreaming` (a job's own session
adopted by a Discord thread is a conversation and is allowed). The route is
`POST /v1/schedule`, same bearer auth as every other route; `messageID` is the
dedupe key of a one-off, so a retried tool call creates one job, not two. The
host validates the agent with `agent.list` for that directory before creating
anything (verified 2026-09-15: `agent.get` does not see agents defined under a
directory's `.opencode/`, `agent.list` with a location does). Behaviour and
the configuration switch are in
[configuration](configuration.md#agent-created-jobs).

## Browser tool

The plugin also registers `aivi_browser` (permission action `aivi_browser`). Ownership comes from the native tool context, not tool arguments.
Configure the host browser service before using it; see [browser setup](browser.md).

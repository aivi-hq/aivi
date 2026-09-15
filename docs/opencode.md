# Native OpenCode integration

aivi uses the published `@opencode/client` and `@opencode/plugin` 2.0.3 packages:
the v2 `Plugin.define` API and native session operations. It does not patch
OpenCode or read its private storage.

## Verified boundary (OpenCode 2.0.3, macOS, 2026-09-14)

Milestone 0 of the roadmap, run against a real `opencode service` with
`github-copilot/gemini-3.8-flash`. Repeat it any time with
`npm run live:opencode -- --plugin "$PWD/examples/librarian"`.

| Question | Finding |
| --- | --- |
| How is the server found? | `opencode service` registers `~/.local/state/opencode/service.json` with a random loopback port and a password. `Service.discover()` from `@opencode/client/service` returns it. aivi uses that; `opencode.url` is only an override. |
| Authentication | HTTP basic (`opencode:<password>`). Anonymous and bearer requests get 401. |
| Client-chosen IDs | `session.create({ id: "ses_aivi_…" })` and `session.prompt({ id: "msg_aivi_…" })` are accepted; nested `metadata` objects are stored and returned. |
| Turn completion | After `session.prompt` (`delivery: "queue"`), `session.wait` returns when the turn ends (about 2 s for a trivial prompt). `session.context` then shows `user → assistant(finish: "stop", time.completed) → idle(outcome: "succeeded")`. This is what the Discord adapter's `finalAnswer` checks. |
| Permission prompts | A tool that needs approval (for example `external_directory` when reading a knowledge source outside the project) parks the turn; `session.wait` blocks until a human replies. `permission.list({ sessionID })` exposes the pending request and `permission.reply` answers it. Any unattended driver must check this. |
| Plugin loading | A directory entry in `plugins` resolves `<dir>/server.*` or `<dir>/index.*`, not `package.json#main`. `packages/opencode/server.js` re-exports the build for that reason. Loading is location-scoped: the plugin is instantiated per project directory that configures it. |
| Plugin failure mode | An exception in `setup()` marks the plugin `failed` and registers no tools. The plugin therefore never throws for a missing token; the tool call reports the 401. |
| Tool invocation | Plugin tools are exposed to the model through codemode, for example `return await tools.aivi.status();`. Effective ids are `aivi_status`, `aivi_sources`, `knowledge_search`, `browser_control`. |
| History access | `session.list` (paginated; filter by `directory`/`project`), `message.list`, `session.export`, `session.context`. There is no cross-session search: any "what did we discuss" feature needs a derived index. |
| Changes to a local plugin | The server caches the resolved entrypoint; run `opencode service restart` after changing the plugin package layout. |

## Librarian in native chat

1. Build with `npm ci && npm run build`.
2. Start aivi, for example `npm run aivi -- --config examples/aivi.json serve`
   (with `AIVI_TOKEN` from fnox, or `host.auth.mode: "none"` on a trusted machine).
3. With `mode: "token"`, export the same `AIVI_TOKEN` in the OpenCode **server**
   environment and `opencode service restart`.
4. Open `examples/librarian` in OpenCode v2. Its config loads the local plugin
   and selects the `librarian` agent.
5. Ask it to list aivi sources and read the company handbook.

The example agent denies shell, edits, and subagent launches and allows
`external_directory` reads for the example knowledge paths using `**` globs;
without those rules every read waits for a permission prompt. Resources in
permission rules are matched against absolute paths.

## Host submission

Leave `opencode.url` unset and the host discovers the local service. Set it only
for a server elsewhere, with `OPENCODE_USERNAME`/`OPENCODE_PASSWORD` if that
server requires basic auth. aivi never starts or stops the service;
`opencode service start` does.

```sh
npm run aivi -- --config examples/aivi.json opencode check
npm run aivi -- --config examples/aivi.json jobs enqueue examples/tasks/librarian.json
npm run aivi -- --config examples/aivi.json jobs list
```

The running host dispatches queued jobs through the session driver
(`packages/host/src/session.ts`): create the session with a client-chosen id,
pin agent and directory, prompt, wait, answer permission prompts per policy, and
verify the final answer (`assistant.finish === "stop"`, `idle.outcome ===
"succeeded"`, no unfinished tools, text present). The job then succeeds with
`{ sessionId, text, rejectedPermissions }`.

Task options: `timeoutMs` (default 30 min) and `onPermission`: `reject`
(default; deny and let the agent continue, recorded in the result) or `fail`
(leave the prompt pending for a human and block the job). A timeout, a failed
turn, a changed agent/directory, or a host shutdown mid-turn also block the job,
because none of those prove the session stopped doing things. Blocked jobs keep
their capacity until an operator has looked at the session:

```sh
npm run aivi -- --config examples/aivi.json jobs resolve JOB_ID --outcome succeeded --reason "Inspected completed session" --confirm-stopped
```

Discord uses the same driver for each turn. Steering an active worker into
cleanup (the Linear lifecycle) is not part of the driver yet.

## Browser tool

The plugin also registers `browser_control` with native permission action
`browser`. Ownership comes from the native tool context, not tool arguments.
Configure the host browser service before using it; see [browser setup](browser.md).

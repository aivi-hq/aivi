# Review: adapters and plugin

## Disposition (2026-09-15)

Applied: 2 (as `TurnNotStarted` thrown by `runTurn`, used by jobs and Discord),
3, 4, 5, 6, 8, 10, 15, 16, 17, 25, 29, 32 (one librarian; `discord-librarian/`
deleted), 33, 34 (comment), test gap 2 (examples load through the real
loaders), agent-file items in §5 except tool naming (see below).

Wrong: 13. OpenCode's permissions doc states `*` matches any characters
including `/` and that the last matching rule wins; `*.env` is correct. The
answer to Q5 is recorded in `docs/opencode.md`.

Rejected: Q1 / "Discord turns as host jobs" (decision recorded in
`architecture.md`: two queues, one capacity); 18 as a read/write gate now
(documented; "queue index behind searches" is planned work); 11, 12, 14 (a
missing source path is a configuration error and should fail startup).

Deferred: 20–24 and test gaps 8–9 until the live Chrome gate runs (changing
recovery logic without Chrome is guesswork); 1 was fixed the day before;
7, 9, 26, 27, 28, 30, 31, the simplicity items on shared helpers, and test
gaps 1, 3–7, 10–12. Q6 (tool names under Code Mode) is a live check.

---


Scope: `packages/knowledge`, `packages/discord`, `packages/browser`,
`packages/opencode`, `scripts/*.mjs`, `examples/**`. Host/core/app are covered
in `host-core-app.md`; host APIs are referenced where the adapters lean on them.
All 22 adapter tests pass on Node 26.5 (`node --test packages/{knowledge,discord,browser,opencode}/test/*.test.ts`).

## 1. Summary

The adapters are small and mostly honest about their boundaries, but the shipped
Discord example config is rejected by `config check`, so the documented Discord
onboarding path is broken. The Discord engine blocks turns (and capacity) on
failures that happen *before* a prompt was ever submitted, so an unreachable
OpenCode fills the inbox with operator-only work. `module.ts` (318 lines, the
most stateful file in scope) has no tests. Three packages re-implement the same
"canonical source directory" logic, and knowledge/browser each hand-roll the
same bounded serial queue.

## 2. Bugs and correctness risks

Severity: **H** breaks a documented path or data integrity; **M** wrong behaviour
under realistic conditions; **L** edge case / hygiene.

### Discord module (`packages/discord/src/module.ts`)

1. **H — `examples/discord.json` fails validation.** `config.ts:21` defaults
   `messageContent` to `false`; `core/config.ts:228` defaults channel `trigger`
   to `mention-to-start`; `config.ts:27` then rejects any non-`mention` trigger
   without `messageContent`. `npm run aivi -- --config examples/aivi-discord.json config check`
   prints the `messageContent` issue. Fix: set `"trigger": "mention"` in the
   example channel (or `"messageContent": true`), and correct the `config.ts:20`
   doc comment, which says the intent is only needed for `trigger: "any"`.
2. **M — pre-prompt failures are treated as unverifiable.** `engine.ts:66-78`
   blocks the turn and its lease on *any* error from `ask`, including
   `opencode()` connect failure, `session.create`, and `session.get`
   (`host/session.ts:79-96`) — all of which happen before `session.prompt`. With
   OpenCode down, every message becomes a blocked turn requiring
   `discord resolve`, and `store.ts:87-92` counts `blocked` toward `maxPending`,
   so the inbox eventually refuses everyone. Fix: add an `onPrompted` callback to
   `runTurn` (mirroring `onCreated`); if the error arrives before it fired, mark
   the turn failed, release the lease, and tell the user; block only after.
3. **M — `client.destroy()` is not awaited** (`module.ts:101`); it returns
   `Promise<void>` in discord.js 14.27. Shutdown can finish before the gateway
   closes and a rejection is unobserved. Fix: `await client.destroy()`.
4. **M — `/new` at the top level of a `sessions: "threads"` channel.**
   `module.ts:250-253` calls `store.reset(interaction.channelId)` on a channel
   that is never a conversation, inserting a `discord_sessions` row for it and
   replying "The next message starts a fresh session" (the next message opens a
   new thread anyway). `/status` (`:258`) has the same mismatch. Fix: when
   `accessEntry(...).sessions === 'threads' && route.parentId === null`, reply
   "run this inside a thread".
5. **M — a blocked turn is silent to the user.** After a timeout/failure the
   typing indicator stops and nothing is posted; only `/status` reveals the
   block. Fix: best-effort `send(turn.channel, 'I could not finish this; an operator has been notified.')`
   inside the `catch` at `engine.ts:74-78` (ignore send errors).
6. **L — `<@!id>` nickname mentions are not stripped** (`module.ts:164`). Fix:
   `replaceAll(new RegExp(`<@!?${id}>`, 'g'), '')`.
7. **L — `store.has()` is executed for every visible guild message before
   authorization** (`module.ts:157`). Cheap, but it is a DB read for messages
   that are discarded at `:159`. Fix: compute `knownConversation` lazily or
   only when `parentId !== null`.
8. **L — loop failure surfaces twice.** `module.ts:302` forwards the loop
   error to `services.fail`, then `stop()` at `:308` rethrows the same error into
   the host's shutdown `AggregateError`. Fix: `await loop.catch(() => {})` in
   `stop()`.
9. **L — thread-only channels fall through** (`module.ts:168`): in a forum
   channel `conversation` stays the channel id and `channel.send` will fail.
   Unreachable in practice (forum posts are threads) but the branch should
   return with a log instead of enqueueing.

### DiscordStore (`packages/discord/src/store.ts`)

10. **M — `claim()` opens one write transaction per queued row after capacity
    is gone** (`store.ts:131-143`): with 100 queued turns and a busy model slot,
    each 500 ms tick runs 100 `BEGIN IMMEDIATE` transactions that all return
    false. Fix: check `capacityUsage` once before the loop, or `break` when
    `acquireLease` fails for a capacity reason (return a reason enum).
11. **L — positional `INSERT ... VALUES(?,?,0)`** (`store.ts:93`, `:117`) is
    brittle against future columns; name the columns.
12. **L — `list()` joins `s.ready` from the *current* session row** so
    historical turns report the new session's readiness. Harmless today, but
    `Turn.ready` on a listed turn is not what it says. Fix: only project `ready`
    in `claim()`.

Lease pairing itself (claim+lease, sent+release, block+blockLease,
resolve+release, recover+blockLeasesOwnedBy) is consistent; the "Lost resource
lease ownership" throws from `host/store.ts:314-323` correctly escalate to the
engine's outer catch.

### Native chat (`packages/discord/src/native.ts`)

13. **M — `.env` deny rules may not match absolute paths.** `native.ts:39-40`
    use `*.env` / `*.env.*`. `librarian.md:16-18` states resources are matched
    against absolute paths and recommends `**`. If `*` does not cross `/`, the
    rule never matches `/…/.env`. Fix: `**/.env`, `**/.env.*` (correct under
    either semantics). Also confirm last-match-wins ordering; the list starts with
    deny-all at `:37`, so first-match would deny everything.
14. **L — startup hard-fails on a missing source path** (`native.ts:44`, also
    `knowledge/index.ts:63`), while `system.check` exists precisely to report
    unavailable sources. Fix: skip with a warning and let `system.check` report.
15. **L — comment at `native.ts:23`** says plugin tools use their id as the
    permission action; `browser_control` uses `permission: 'browser'`
    (`opencode/src/index.ts:114`). Reword.

### Knowledge (`packages/knowledge/src/index.ts`)

16. **M — `search()` throws synchronously** (`:94-95`) although it returns a
    Promise; `knowledge.search(...).catch(...)` misses schema/unknown-project
    errors. The test at `knowledge.test.ts:47-48` codifies this. Fix: make
    `search` an `async` function (the `run()` fast-rejects stay as-is).
17. **M — one escaped result fails the whole query** (`:118-119`). A symlink
    inside a source that resolves outside it (or a single-file source whose
    directory gained a same-pattern file) turns every search on that scope into
    an error. Fix: `continue` and log once per path; keep the throw only for the
    collection-name mismatch at `:102`, which indicates a QMD bug.
18. **M — `index()` blocks all searches** (`:136`, same chain as `:98`). The
    example schedules an hourly `knowledge.index`; during a large refresh the
    plugin's `client.search` (10 s timeout, `host/client.ts:30`) fails and Discord
    `/search` stalls. Fix: allow searches to run concurrently with one another
    and only serialize against `update()` (a read/write gate), or at minimum
    document the stall in `docs/knowledge.md`.
19. **L — comment placement** at `:116` (`} // deleted since the last index refresh`)
    sits after the catch block; move it above `try`.

QMD boundary: empty `collection` becomes unscoped in QMD
(`store.js:3170-3177`), so the guard at `:96-97` is essential and correct.
`displayPath` is `collection/path`, `filepath` is `qmd://collection/path`
(`store.js:3221-3222`), so the prefix strip at `:104-109` matches 2.8.3.
`createStore` with inline config deletes collections not in config
(`store.js:1198-1204`); documents of a removed collection stay in FTS until the
next `update()` but are never selectable through `ids`.

### Browser (`packages/browser/src/*.ts`)

20. **M — a definite `isError` from `new_page` becomes the permanent
    "uncertain" state** (`index.ts:75-79`). In `existing` mode the first call
    before Chrome is up, or a refused `--autoConnect` prompt, bricks browser use
    until host restart. MCP's `new_page` creates the page *then* navigates
    (`tools/pages.js:113-119`), so a failed `about:blank` goto can leave an
    unowned tab; the safer minimal fix is: on `isError`, re-list pages, adopt a
    single new `about:blank` page if present, otherwise rethrow the normal error.
    Reserve `fail()` for transport throws and `reconnected`.
21. **M — the new tab is identified by `selected`** (`index.ts:81-82`). With
    `--pageIdRouting=true` selection is legacy state a human can flip between the
    two calls, producing a spurious `fail()`. Fix: require
    `added.length === 1 && added[0].url === 'about:blank'`; drop `selected`.
22. **L — MCP stderr is swallowed** (`transport.ts:62`). Chrome launch/attach
    failures leave no trace. Fix: forward truncated lines to the host logger at
    debug level (no URLs are in stderr diagnostics).
23. **L — double close** (`transport.ts:93-94`): `Client.close()` already closes
    its transport. Keep one.
24. **L — four MCP round trips per `open`** (`list_pages`, `new_page`,
    `navigate_page`, `list_pages`). Acceptable, but the final `list_pages` could
    reuse the `pages` returned by `navigate_page` (`setIncludePages(true)`).

### Plugin (`packages/opencode/src/index.ts`, `server.js`)

25. **M — tools return only `content: JSON.stringify(...)`** (`:54`). With
    `codemode: true`, `return await tools.knowledge.search(...)` hands the model
    a string to parse. Fix: return `{ output: value, content: JSON.stringify(value) }`
    (verify against 2.0.3 codemode).
26. **L — `browserInput` is flat; combination errors arrive as host 400 text.**
    Fine given the host validates, but the tool description should say which
    fields each action needs (it does for `tabId`, not for `url/uid/value/key/response`).
27. **L — `AIVI_TOKEN` is read once at `setup()`** (`:53`); rotation needs
    `opencode service restart`. Document or read per call.

### Scripts

28. **L — `scripts/smoke.mjs:78-100`** duplicates the startup wait without the
    `error` handler and JSON `try/catch` present at `:36-53`; a non-JSON first
    line crashes with an uncaught exception. Fix: one `waitForListening(daemon)`.
29. **L — `scripts/live-opencode.mjs:14`** `MODEL.split('/')` breaks provider
    ids containing `/` (`openrouter/anthropic/claude-…`). Fix: split on the first
    `/` only.
30. **L — `scripts/browser-smoke.mjs`** has no overall deadline; a hung Chrome
    launch hangs `npm run smoke:browser` forever. Fix: `AbortSignal.timeout(120_000)`
    that calls `service.close()`.
31. **L — `scripts/schema.mjs`** is fine; note it imports from `dist`, so
    `schema:check` silently depends on `build` having run first (true in `check`).

### Examples

32. **M — two librarians drift.** `examples/discord-librarian/opencode.jsonc`
    defines an inline `system` prompt with no model, no kind guidance, and no
    tool names; `examples/librarian/.opencode/agents/librarian.md` has all three
    but no Discord-speaker guidance. Fix: make `discord-librarian` reference the
    same agent file (or delete the inline agent and point `discord.json.directory`
    at `librarian`).
33. **L — dreaming is exemplified where it cannot run.** `examples/aivi.json`
    schedules `dreaming` with `origins: ["discord"]` but has no Discord module;
    `examples/aivi-discord.json` has Discord but no dreaming schedule.
34. **L — `librarian.md:20-28`** `external_directory` globs depend on the
    checkout being named `aivi`. Acknowledged in the comment; consider
    `**/examples/knowledge/**`.
35. **L — `examples/aivi-browser.json`** writes `.aivi-browser/` inside
    `examples/` (state and Chrome profile), unlike the other examples which use
    `../.aivi`.

## 3. Simplicity review

- **A second job queue.** `DiscordStore` (203 lines) re-implements
  queued/running/blocked/discarded states, claim, block, resolve, restart
  recovery, and gets its own CLI (`discord status/resolve`) mirroring
  `jobs list/resolve`. The only thing host jobs lack is per-channel
  serialization. A `discord.turn` task kind with a per-channel dedupe/outstanding
  key would reuse scheduler capacity, blocking, reporting, and recovery, and
  delete most of `store.ts` and `engine.ts`. This is the largest lever toward
  "thin core, OpenCode does the work".
- **A second poll loop.** `module.ts:290-300` runs a 500 ms tick loop beside the
  host's scheduler loop (`application.ts:148-158`). Even without merging queues,
  `engine.tick()` can be event-driven: call it after `enqueue` and in
  `launch().finally`, and drop the loop, `stopped` getter and the
  "stopped unexpectedly" plumbing.
- **Three copies of "canonical source directory".** `knowledge/index.ts:62-72`,
  `discord/native.ts:43-52`, `host/dreaming.ts:~195-205` each `realpath` +
  `stat` sources and build globs. One `sourceDirectories(loaded)` in core (or
  host) resolves once at load time and gives every consumer the same answer.
- **Two hand-rolled bounded serial queues.** `knowledge/index.ts:76-91` and
  `browser/index.ts:36-53,138-153` are the same 15 lines. A `serialQueue(max)`
  helper in core removes one copy and its two test variants.
- **Three abort sources in one module.** `module.ts` juggles `services.signal`,
  its own `abort`, and `engine.abort` plus `stop`/`teardown` closures. Passing
  one `AbortSignal` into `DiscordEngine` removes `engine.stop()`, `stopped`, and
  the listener bookkeeping at `:95,:102`.
- **Duplicated types.** `Ask` (`engine.ts:22`) and `NativeChat` (`native.ts:9`)
  are identical; keep one.
- **`Route`** exists only to carry `guildId` for the `isDM` consistency check
  (`config.ts:48`); the module already derives `isDM` from the channel type and
  could do the check inline, letting `authorized` take `AccessRoute`.
- **Plugin** is appropriately thin: it maps tools to the fetch client and adds
  nothing else. Keep it that way; do not grow `browserInput` into a
  discriminated union — the host is the validator.

## 4. Readability

- `knowledge/index.ts:118`: a five-term boolean on one line; name it
  `escaped` first.
- `engine.ts:64-86`: two nested error layers with different meanings (inner →
  block the turn, outer → kill the engine). The outer's purpose is only explained
  in `module.ts:301`. Add one comment on `:80`.
- `store.ts:19`: a function named `turn` mapping rows, a type `Turn`, and local
  variables `turn` in `engine.ts`/`module.ts`. Rename the mapper `rowToTurn`.
- `module.ts:109-125`: `typing`/`askWithTyping` are fine but `done` is an
  `AbortController`; call it `finished`.
- `module.ts:148` and `:206`: identical guard duplicated; hoist `acceptsEvents()`.
- `browser/index.ts:61-62`: the comment about monotonic IDs and reconnection
  sits above `list_pages` but explains the `reconnected` check in `call()`;
  move it to `:50`.
- `config.ts:20` doc comment is wrong (see bug 1) and is the direct cause of the
  invalid example.
- `docs/discord.md` contradicts itself: `:37` allows web fetch/search and `:45`
  describes the typing indicator, while `:147` says web/browser tools are future
  work and `:153` says no typing UI is included. `README.md:68` says Discord is
  live-verified; `docs/architecture.md:141` says it is still open.
- `AGENTS.md:19` says Node 24; `README.md:11` and `package.json#engines` say 26.

## 5. Agent files review

### `examples/librarian/.opencode/agents/librarian.md`

- **Self-contradiction.** Paragraph 2 tells the model to use `memory` for
  "what did we agree" questions and pass `kinds`; paragraph 3 says "durable-memory
  tools are not implemented yet." Delete the last sentence — it is a status line,
  will churn, and it is exactly the kind of text that should not live in a
  prompt-cached soul.
- **Tool names vs. surface.** The prompt names `aivi_sources` and
  `knowledge_search`. `docs/opencode.md` says tools are exposed through codemode
  as `tools.aivi.sources()` / `tools.knowledge.search()`. If the model only sees
  the codemode surface, the names in the prompt do not match what it can call.
  Verify with a live turn and pick one naming in the prompt.
- **Missing guidance:** (a) Discord prompts begin with
  `[Discord message from NAME (user ID)]` (`native.ts:68`) — only the inline
  discord-librarian prompt mentions the speaker; (b) permissions are
  auto-rejected in Discord — say "if a read is denied, say so, do not guess";
  (c) unknown project IDs are errors — "ask which project" is there, but not
  "if the tool says Unknown project, list `aivi_sources` and ask"; (d) reply
  length: Discord replies are chunked at 1900 chars; ask for concise answers with
  the citation first.
- **Frontmatter** denies edit/shell/subagent but not `browser`; in native chat a
  human is present so `ask` is acceptable, but state it in the comment so the
  Discord deny-all session policy is not mistaken for redundancy.
- **Prompt-cache friendliness:** short and stable apart from the "not implemented
  yet" line. Keep per-turn facts (speaker, channel) in the user message, as
  `native.ts` already does.

### `examples/librarian/.opencode/agents/dreamer.md`

- **Cadence is hard-coded** ("Once a day"); the schedule is cron-configured.
  Write "When aivi runs you".
- **Origins are assumed** ("conversations people had with the librarian");
  `origins` can include `job` or later `linear`. Say "conversations aivi
  selected for you".
- **Missing red line on secrets and personal data.** Transcripts can contain
  pasted tokens, health/HR details, or private messages; `facts.md` is a
  searchable core source. Add: never record credentials, personal circumstances,
  or anything the speaker would not want in a shared handbook; mention that it
  was left out in the summary.
- **"Never delete a bullet" vs. "Fix obvious typos in your own earlier bullets"**
  is a tolerable tension; make the second explicitly "typos only, never meaning".
- **Write boundary matches the host** (`dreaming.ts:205-206`: `facts.md` and
  `proposals/*`). Note `proposals/*` is single-level; the prompt says "files
  under proposals/", so nested dirs would be denied — align wording ("files
  directly in proposals/").
- **Frontmatter** denies shell/subagent but not `edit`; run interactively in
  `examples/librarian` it could edit anything there. If the agent is only ever
  driven by dreaming, say so in a comment; otherwise add a deny for `edit` and
  rely on the session-level allows.
- **Prompt-cache friendliness:** stable; the dated example is static. Good.

## 6. Test gaps (prioritized)

1. `module.ts` has no tests. A fake `Client` (EventEmitter + `channels.fetch`)
   would cover: thread creation path and `conversation` id, access routing from
   real `Message` shapes (DM partial, thread, forum), typing start/stop around
   `ask`, teardown ordering (`stop → drain → destroy`), destination
   registration/unregistration and the `reportChannels` refusal.
2. Example configs are never parsed in tests; a test that loads every
   `examples/*.json` through `loadConfig`/`loadDiscordConfig` would have caught
   bug 1.
3. Engine: timeout (`turnTimeoutMs`) and `stop()` during `ask` → turn blocked,
   lease blocked, `drain()` resolves; also the outer-catch path (store throws in
   `block`) → `engine.stopped`.
4. Store: FIFO across channels with `maxConcurrent > 1`; a queued turn behind a
   `blocked` turn in the same channel never claims.
5. Knowledge: `maxPending` overflow → `Knowledge queue is full`; `close()` with
   queued work; search ordering relative to `index()`.
6. Knowledge: symlink/escaped result behaviour (currently: whole query fails —
   pin whichever behaviour you choose); single-file source excludes siblings in
   the same directory.
7. Native chat: the `.env` deny rules and `external_directory` globs asserted
   verbatim (they are security rules with no test).
8. Browser: `open` when `new_page` returns `isError`, or when the added page is
   not `selected`, or when two pages appear (popup race); `navigate`, `focus`,
   `dialog`, `press` argument mapping (only `click`/`snapshot` are asserted).
9. Browser: `close()` while operations are queued; `execute` after `close()` and
   after `failure`.
10. Plugin: `search`/`sources` argument-to-query-string mapping (`projects: []`
    → `coreOnly=true`, `kinds`, `includeCore=false`); only the browser tool is
    tested end-to-end.
11. Slash commands: `/search` unknown project message, `/new` refusal text,
    `/status` state summary — currently only the store-level `reset` throw is
    tested.
12. Smoke: `scripts/smoke.mjs` runs without a `search` block, so the advertised
    `knowledge search` CLI path is never smoke-tested against a live host.

## 7. Questions for the owner

1. Should Discord turns become host jobs (`discord.turn` task kind) instead of a
   parallel queue with its own CLI? What is the per-channel serialization
   requirement that jobs cannot express today?
2. For failures *before* `session.prompt` (OpenCode unreachable), is blocking the
   turn intended, or should the turn fail cleanly and release capacity?
3. Should a blocked turn tell the Discord user anything, or is silence plus
   `/status` the intended UX?
4. In `existing` browser mode, is "Chrome must be running before the first
   browser call or restart aivi" acceptable, or should transport failures on the
   first connect be retryable?
5. How does OpenCode 2.0.3 match permission resources — does `*` cross `/`, and
   is it last-match-wins? Bug 13 hinges on it; the answer should be recorded in
   `docs/opencode.md`.
6. Under codemode, what names does the model see for plugin tools
   (`knowledge_search` vs `tools.knowledge.search`)? The librarian prompt should
   use those.
7. Is `/search` posting absolute server paths into Discord (ephemeral) intended,
   given the same paths are cited by the librarian anyway?
8. Which is the librarian of record for Discord: `librarian.md` or the inline
   agent in `discord-librarian/opencode.jsonc`?
9. Node 24 (`AGENTS.md`) or Node 26 (`README.md`, `engines`)?
10. Is `webfetch`/`websearch` for the Discord librarian intended
    (`native.ts:30-31`) while `docs/discord.md:147` says web tools are future
    work?

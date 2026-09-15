# Review: `@aivi/core`, `@aivi/host`, `@aivi/app` (2026-09-14)

## Disposition (2026-09-15)

Applied: B1, B2, B4, B5, B6, B7 (no cache; discovery per unit of work), B8
(plus `errorMessage` prints `AggregateError.errors`), B3 (`realpath`, and the
`.env` read-deny the librarian already had), B10 (doc comment only; the one
caller uses `store.db`), B12 (warn once per pool name), B14 (docs now describe
the abort; a grace period stays with `backlog/shutdown-hooks.md`), L8, S1, S2,
S10, Q11 (Node 26). Tests added for gaps 1, 2, 4, 6 (primary error) and the
dreaming session id.

Rejected: B11 (two hand-written files that differ only in key order are an
operator mistake either way); "rejected write-boundary permissions → failed"
under B3 (a rejected prompt on a successful turn is a legitimate, audited
outcome); S4 (Linear config stays: it records agreed constraints for the next
module); S7 (the `PendingAnswer` contract is documented and tested; churn
without a bug).

Deferred: B9 / Q9 (the base for task paths is variable per project; part of
`backlog/jobs.md` and `backlog/projects-and-capacity.md`); B13 / Q5 (verify at
the live boundary; noted in `dreaming.md`); Q1 (blocked jobs holding global
capacity is intended until per-project pools exist); Q6 transcript retention,
L-items not listed above, and the remaining test gaps.

---

Scope: `packages/core/src/*.ts`, `packages/host/src/*.ts`, `packages/app/src/cli.ts`
and their tests. All 36 tests pass on Node 26.5 (`node --test`, dist already built).
Findings marked *confirmed* were reproduced with throwaway scripts against the
built `dist/` outside the repo; nothing in the repo was modified.

## 1. Summary

The code is small, consistent with the documented principles, and the store /
scheduler core is sound: `BEGIN IMMEDIATE` transactions, ownership checks on every
state change, and coalesced misfires behave as documented. The biggest risks are in
the session driver and the executor: a tight re-poll loop in `runTurn` (measured at
~675 requests/s), timeout errors that are misclassified because the SDK wraps them,
several "no external effect happened" failures that nevertheless *block* a job and,
with the default `maxConcurrent: 1`, stall every schedule until an operator
intervenes. Dreaming's permission rules use non-canonical paths, so on symlinked
directories the dreamer is silently denied its own write boundary.

## 2. Bugs and correctness risks

### High

**B1. Hot loop when `session.wait` returns but the turn is not in the context.**
`packages/host/src/session.ts:117-124`. On `PendingAnswer` the code re-arms
`session.wait` and loops immediately with no delay. If `wait` resolves at once (idle
session, dropped prompt, context lag) the loop calls `wait` + `permission.list` +
`context` back-to-back until the job's timeout (default 30 min). *Confirmed:* 675
round-trips in 1 s against a mock. Fix: `await setTimeout(pollMs, undefined, { signal })`
before re-arming (or only re-arm after the delay).

**B2. Timeouts are reported as "Transport", not as a timeout.**
`packages/host/src/runtime.ts:66,93`. The checks `error.name === 'TimeoutError'` never
match in practice: when the timeout fires while an SDK request (almost always
`session.wait`) is in flight, the SDK rejects with `ClientError` whose message is
`Transport` and whose `cause` is the `TimeoutError`. *Confirmed.* The operator then
sees `Transport. Inspect session …` as the blocking reason. Fix: keep the timeout
signal in a variable and branch on `timeout.aborted` instead of the error name (same
for `context.signal.aborted`, which is already done correctly).

### Medium

**B3. Dreaming permission resources are not canonical paths.**
`packages/host/src/dreaming.ts:141-149` builds `external_directory` / `edit` rules from
`task.memoryDirectory` and `runDir` as configured, while `packages/discord/src/native.ts:28-31`
deliberately uses `realpath` because OpenCode matches "native canonical
external-directory boundaries". On macOS (`/tmp`→`/private/tmp`, `/var`, symlinked
home paths) the dreamer's reads and edits are prompted, auto-rejected, and the job
*succeeds* with `changed: []` and a non-empty `rejectedPermissions`. Fix: `realpath`
both directories before building rules; consider treating rejected permissions on the
write boundary as `failed`.

**B4. Spawn errors block the job instead of failing it.**
`packages/host/src/runtime.ts:42,50`. `execFile` reports ENOENT/EACCES with a string
`code` and no signal; the mapping turns that into `exitCode: null` → `blocked`
("Command did not exit cleanly"), occupying capacity until `jobs resolve`. *Confirmed*
with `/nonexistent/binary`. Fix: `typeof exec.code === 'string' && !exec.signal` →
`failed` with `exec.message`.

**B5. A down OpenCode service blocks jobs that never made a request.**
`packages/host/src/runtime.ts:72` (`await deps.opencode()` before `attachSession`) and
`dreaming.ts:124`. Discovery failure has no external effect, yet the job is blocked
(the test at `runtime.test.ts:53` enshrines this). With the default `maxConcurrent: 1`
a single blocked job halts `knowledge.index`, `system.check`, and every other pool.
Fix: catch the `opencode()` call separately and return `failed` with reason
"OpenCode unreachable"; only failures after `session.create` was attempted should block.

**B6. Dreaming never persists its session id before calling OpenCode.**
`packages/host/src/runtime.ts:53-61` computes `sessionId` only for the error message;
`dream()` derives the same id again (`dreaming.ts:151-154`) and `context.attachSession`
is never called. This contradicts `docs/architecture.md:58` and the `opencode.prompt`
path (`runtime.ts:76`). Fix: `context.attachSession(sessionId)` before `dream()` and pass
the id in (or expose `onCreated`).

**B7. OpenCode client is cached for the host lifetime.**
`packages/host/src/application.ts:69-72` only clears the cache when *discovery* fails.
After `opencode service restart` (random new port and password; recommended in
`docs/opencode.md:24`) every turn fails with a transport error until aivi restarts. Fix:
reset `opencodeClient` when a request fails with a transport/401 error, or re-run
`Service.discover()` per job (it is a file read).

**B8. `finally` replaces the primary error with an `AggregateError`.**
`packages/host/src/application.ts:126-141`. If the `try` block throws (for example
`Scheduler stopped unexpectedly` at line 121, whose real cause only surfaces via
`scheduler.drain()` at 133) and any cleanup step also fails, the thrown value is
`AggregateError('Application shutdown failed')` and the CLI prints only that string
(`cli.ts:204`, `errorMessage` ignores `.errors`). Fix: catch the primary error, push it
into `errors`, and have the CLI print `error.errors` for `AggregateError`.

**B9. `jobs enqueue` skips path resolution and the dreaming invariant.**
`packages/app/src/cli.ts:133-134` resolves only `opencode.prompt.directory` and
`shell.cwd` (against cwd, whereas config paths resolve against the config directory);
a `dreaming` task file keeps relative `directory`/`memoryDirectory`, and the
"memoryDirectory must be inside a core knowledge source" check in
`packages/core/src/config.ts:241-242` is not applied. The cursor key
(`dreaming.ts:123`, keyed by the raw path) also diverges from the schedule's absolute
key. Fix: extract `resolveTaskPaths(task, base, sources)` from `loadConfig` and call it
from the CLI.

**B10. `Store.transaction` has no nesting guard.**
`packages/host/src/store.ts:93-97`, contract at `197-208`. `acquireLease` runs
`onAcquire()` inside its transaction; any Store method that opens its own transaction
(`enqueue`, `note` is fine, `finish` is not) fails with `cannot start a transaction
within a transaction`. *Confirmed.* The rollback is clean, but the documented adapter
hook is a trap. Fix: track a `depth` counter and run `fn()` directly when already inside
a transaction, or state in the doc comment that `onAcquire` may only use `store.db`.

**B11. Fingerprint depends on JSON key order.**
`packages/host/src/store.ts:17,118`. Two task files with identical content but
different key order yield "Idempotency key already used for a different task".
*Confirmed.* Fix: stable-stringify (sorted keys) in `hash`.

**B12. A queued job whose pool no longer exists is silently stuck.**
`packages/host/src/store.ts:178-179` `continue`s forever with no log or state change;
`status` shows it as `queued`. Fix: log once per tick in `Scheduler.tick` or fail the
job with "Unknown resource pool" at claim time.

**B13. `collectSessions` assumes `order: 'desc'` sorts by `time.updated`.**
`packages/host/src/dreaming.ts:59-61` breaks out of pagination at the first session with
`updated <= since`. The protocol description only says "newest first"
(`@opencode/protocol/dist/groups/session.js:38`). If the server orders by creation time,
an old session with new messages after a newer, already-seen one is never reviewed. Fix:
verify against the live server (add to `live-opencode.mjs`) or drop the early break and
filter the whole page set.

**B14. Shutdown aborts in-flight jobs; docs say it drains them.**
`packages/host/src/application.ts:127-128` calls `scheduler.stop()` first, which aborts
every running `execute` (shell gets SIGTERM, turns abort) and blocks the job.
`docs/application.md:47` says shutdown "drains scheduled work". With `maxConcurrent: 1`
every restart during a dreaming run produces a blocked job. Fix (smallest): drain first
with a bounded grace period, then abort; or change the doc and warn on `host.stopped`.

### Low

- **L1** `cli.ts:57-59,183`: an `AIVI_ENV_FILE` that does not exist is silently ignored; an explicit path should error.
- **L2** `cli.ts:54` + `core/src/log.ts:28`: an invalid `--log-level` makes `order[level]` undefined and everything logs; validate against `LogLevel`.
- **L3** `cli.ts:64-66`: discord.js is imported and its config parsed for every command, including `status` and `jobs list`.
- **L4** `server.ts:21` hardcodes `version: '0.1.0'`; `core/src/contracts.ts:15` `completion: 'verified-final-answer'` is a constant shipped in a status API.
- **L5** `session.ts:107`: a new `pollMs` timer is created per iteration and left running when `waited` wins; harmless alone, but it multiplies in B1.
- **L6** `store.ts:257-259`: `EPERM` from `process.kill(pid, 0)` counts as alive (documented), but the error message does not say how to recover from a stale row.
- **L7** `store.ts:134-142`: the schedule fingerprint includes `report` and `enabled`, so changing only a report channel cancels the queued occurrence and recomputes `next_at` from now.
- **L8** `application.ts:57,74-95`: a signal that is already aborted still acquires the daemon, builds resources, and runs `knowledge.index()` before `throwIfAborted()`.
- **L9** `application.ts:130-133`: modules stop before `scheduler.drain()`, so a job finishing during shutdown reports to an unregistered destination and leaves `report-failed` audit noise.
- **L10** `dreaming.ts:137-138`: transcripts accumulate under `<state>/dreaming/` with no retention.
- **L11** `dreaming.ts:61,78`: the cursor compares `session.time.updated` but messages are filtered by `time.created`; an answer still streaming at the previous run is captured partially and never re-read.
- **L12** `client.ts:21`: `new URL(path, base)` drops any base path prefix (a reverse proxy at `/aivi/` breaks).
- **L13** `server.ts:75-82`: `coreOnly=true&includeCore=false` returns `200 []` instead of `400`.
- **L14** `config.ts:208-243`: the parsed config is mutated in place; the schedule fingerprint (`store.ts:134`) therefore changes when the config file moves.

## 3. Simplicity review

- **S1 Session id derived in three places.** `runtime.ts:54`, `runtime.ts:73-74`, `dreaming.ts:151-154` all compute `ses_aivi_${jobId without dashes}`. One `sessionIdFor(jobId)` in `session.ts` removes the duplication and fixes B6's mismatch risk.
- **S2 Two identical catch blocks.** `runtime.ts:62-69` and `88-96` differ only in the `PermissionRequired` branch. A `blockedReason(error, hostSignal, timeoutSignal, timeoutMs)` helper also fixes B2 in one place.
- **S3 Task path resolution lives in two places and disagrees.** `config.ts:234-243` vs `cli.ts:133-134` (see B9). One helper, called from both.
- **S4 Linear configuration for a feature that is not built.** `config.ts:77-80` (`projectSchema.linear`), `:117` (`linear.applications`), `:132-136` and `:229-231` validation, plus `AGENTS.md` rules about lanes. Nothing outside `config.ts` reads it. This is speculative surface that every config author sees in the schema; either drop it until the Linear module lands or move it into that module's own config file (as Discord does).
- **S5 Constants in the API.** `Status.version` and `Status.completion` (`contracts.ts:15`, `server.ts:21,25`) carry no information a client acts on. Read the version from `package.json` or remove both.
- **S6 `Destinations` class.** `destinations.ts:12-25`: `has()` is unused, and `register` returns an unregister closure that only Discord uses. A `Map<string, Destination>` on `HostServices` would do the same with less ceremony. Not wrong, just more than needed.
- **S7 Exceptions as control flow in `finalAnswer`.** `session.ts:133-153` throws `PendingAnswer` for "keep waiting" and `Error` for "give up", and `runTurn:117-124` sorts them with `instanceof`. Returning `{ done: false } | { done: true, text }` and throwing only for real failures would make the loop read top-to-bottom.
- **S8 Two hooks for "the session now exists".** `ExecutionContext.attachSession` (scheduler) and `TurnOptions.onCreated` (session). Jobs use the first, Discord the second, dreaming neither. Pick one.
- **S9 Two task-file shapes.** `cli.ts:129-132` accepts a bare task or `{task, report, resource}` and falls back from one parser to the other, so a typo in `report` produces an error about `kind`. One shape (the wrapper) is enough.
- **S10 `readCursor` runs a migration on every call** (`dreaming.ts:38`). Cheap, but a `migrate` in a read path is surprising; run it once where `dream()` starts.
- **S11 Defaults declared twice.** `config.ts:107` and `:122` repeat every inner default in `.default({...})`. In zod 4, `.prefault({})` applies the field defaults; one source of truth.
- **S12 `log.ts:46`** special-cases both `value instanceof Error` and `key === 'error'`; `errorMessage` already handles both shapes.
- **Where the thin-core principle holds.** `runTurn` verifying the final answer from `session.context` rather than trusting idleness is deliberate and documented; keeping it. Building transcripts by hand from `message.list` (`dreaming.ts:72-90`) is the one place aivi re-implements something OpenCode offers (`session.export`); acceptable while the export format is unstable, but note it in `dreaming.md`.

## 4. Readability

- `session.ts:134`: a one-line `findLastIndex` with an inline cast to `{ message?: string }` hides the two ways a turn is identified (native id vs `metadata.aivi.message`). Name the predicate.
- `session.ts:141`: `tail.lastIndexOf(idle) < tail.lastIndexOf(answer)` compares object identity to order two messages; `findLastIndex` results would say what is meant ("idle must come after the answer").
- `session.ts:122` comment says "context lags or another step started; re-arm" but the re-arm has no delay (B1); the comment describes intent the code does not implement.
- `runtime.ts:39-46`: the `execFile` callback decodes Node's error object through a four-member cast and nested ternaries; a small `classifyExit(error)` returning `{ kind: 'exit' | 'signal' | 'spawn' }` would document the three cases and fix B4.
- `runtime.ts:49` comment ("Aborted by host shutdown or timeout") is misleading: the branch also catches spawn failures.
- `server.ts:69-85`: `parseSelection` returns `string | object` where the string is an error; callers test `typeof selection === 'string'`. A `{ ok, error }` result or throwing would be clearer.
- `store.ts:11-27`: row mappers named `lease`, `audit`, `job` shadow the domain nouns and read as variables elsewhere (`const job = ...` at `scheduler.ts:40`). `toLease`/`toJob` avoids the double take.
- `store.ts:26`: `r.report === undefined` can never be true for a selected column; it hints at a schema doubt that no longer exists.
- `config.ts:59-60`: two fields per line in a schema that otherwise uses one per line.
- `application.ts:69-72`: the `??=` plus `.catch` that resets the cache works only because the callback runs after the assignment; say so in the comment, or write it as two statements.
- `cli.ts:57`: the env-file search order is a ternary inside a `for` header; a named array (`envFiles(configPath)`) would make the precedence (documented in `usage`) visible.
- `destinations.ts:45`: nested ternary inside an array literal inside `.filter(Boolean).join`; split into `summary` and `details`.
- `dreaming.ts:59,76`: the request-object ternaries are explained by the comment at line 58; the message list at 76 has no such comment although it repeats the same trick.
- `docs/application.md:47` vs `application.ts:127-128`: "drains scheduled work" does not describe aborting it (B14).

## 5. Test gaps (prioritised)

1. `runTurn` aborted or timed out while `session.wait` is pending, and how `createExecutor` classifies that error (would have caught B2).
2. `runTurn` with a context that lags behind `wait` (mock returns an empty context once, then the answer); assert the request count stays bounded (B1).
3. `dream()` when `runTurn` throws: cursor unchanged, job blocked, transcript kept, `rejectedPermissions` surfaced; `dream()` with the cursor mid-way through a multi-page `session.list` (B13).
4. Shell spawn failure (ENOENT) and `maxBuffer` overflow → expected states (B4).
5. `Store.acquireLease` with an `onAcquire` that throws (lease rolled back) and one that calls a Store transaction (B10).
6. `runHost` with a job running when the signal fires: job ends `blocked`, modules stop before drain, `host.stopped` logged, and the primary error survives a failing `knowledge.close()` (B8, B14).
7. `runHost` OpenCode factory: failure then success (cache reset), and behaviour after a transport error (B7).
8. HTTP: unknown query parameter → 400, `limit=abc` → 400, `coreOnly=true&includeCore=false`, browser body exactly 32 KiB, non-JSON body → 400, `browser.execute` rejecting → 409.
9. CLI has no unit tests at all: env precedence (`AIVI_ENV_FILE`, config-adjacent `.env` before `~/.aivi/.env`, environment wins), `jobs enqueue` both file shapes and path resolution for every task kind (B9), `jobs resolve` guard combinations, `tick` running with `auth.mode: 'none'`.
10. Store: schedule whose cron has no future occurrence (`0 0 30 2 *`) at `syncSchedules`/`materializeDue`; a changed schedule while a `blocked` occurrence exists; a queued job whose pool was removed (B12).
11. `finalAnswer`: unfinished tool part, `agent-switched` in the tail, assistant with `error`, several assistant messages where only the last is the answer.
12. `describeOutcome` for `blocked` with a `{ sessionId }` result, and `shouldReport` for `cancelled`.

## 6. Questions for the owner

1. **Blocked jobs hold global capacity, and the default `maxConcurrent` is 1.** One blocked job (including B4/B5 cases where nothing external happened) stops every schedule in every pool until `jobs resolve`. Is that the intended failure mode for an always-on teammate, or should blocked jobs hold only their pool slot?
2. Should failures that provably happened *before* any external effect (discovery failure, spawn error, `session.create` rejected) be `failed` rather than `blocked`?
3. Shutdown: abort immediately (current code) or drain with a grace period (current docs)?
4. Dreaming: is `edit` the OpenCode permission that also covers *creating* `proposals/*.md` (`write` tool), and is `execute` only Code Mode, as `native.ts:18` states? The dreamer rules depend on both.
5. Is `session.list` with `order: 'desc'` ordered by `time.updated`? `collectSessions` is only correct if so.
6. Transcripts under `<state>/dreaming/` contain user conversations and are never pruned. Retention policy?
7. Adapter leases (`resource_leases`) left `running` after a crash are only blocked when that adapter starts again; if Discord is removed from the config there is no CLI to release them. Intentional?
8. Keep the Linear configuration surface now, or add it with the module?
9. `jobs enqueue` resolves paths against the shell cwd; config resolves against the config directory. Which rule should operators learn?
10. Should a configured `AIVI_ENV_FILE` that does not exist be an error?
11. `AGENTS.md` says Node 24; `package.json`, `.node-version`, README, and docs say 26. Which is authoritative?
12. `Status.completion` and the hardcoded `version`: what is a client expected to do with them?

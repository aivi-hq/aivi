# Review: the code sweep (2026-10-03)

Scope: every TypeScript source under `packages/*/src` (~28,000 lines, eleven
packages), read against the rules in AGENTS.md and the behaviour the docs
promise. Method: mechanical scans first (banned timers, swallowed errors,
boundary words in core, lifecycle hazards), then a hand read package by
package — core, plugin kit, host (channel, orchestrator, dispatcher, api,
cli, services), tracker-linear, forge-github, knowledge, browser, the two
channel packages, the OpenCode plugin, and the CLI — no child agents.
**No file was edited for this review**; every line below is a finding for
the operator to decide on.

## A. Mechanical scans

- **No `setInterval` anywhere** in `packages/*/src` — the ban holds. Every
  clock is a `setTimeout`: keep-alives, retry backoffs, re-arming diary
  watches, as the rules allow.
- **No `catch {}` blocks, no `as any`, no `@ts-ignore`/`@ts-expect-error`, no
  TODO/FIXME** anywhere. Clean.
- **`.catch(() => {})`** appears 22 times. Sixteen are the standard cancelled
  sleep (`setTimeout(…).catch(…)` in application/events/modules), a
  best-effort `AGENTS.md` note (`wx`), unhandled-rejection guards on promises
  awaited elsewhere (tracker-linear/setup.ts), and knowledge's chain
  bookkeeping (the operation's own result reaches its caller). The remaining
  thirteen sit in `channel-discord/src/module.ts` (7) and
  `channel-slack/src/module.ts` (6) plus tracker-linear's boot retry (2), all
  on fire-and-forget sends — reacts, typing indicators, queue acks, boot
  closings that stay owed to the next wake. That is the shape the docs
  sanction ("a short reply instead when the bot can't react"); none swallows
  a state change a person waits on. Accepted, listed for completeness.
- **`process.exitCode`** only in CLI entry files (`cli/src`, `channel-slack/src/cli.ts`)
  — never in library code. Correct.
- **Boundary words in core**: `brand.ts` and `log.ts` name `discord`/`slack`
  (their colors), `config.ts` ships `origins: ['discord']` as the dreaming
  default, and `identity.github` is a platform word inside core's own schema
  while the comment above it says "core names systems, not GitHub". The first
  two are the known backlog item about core knowing platform colors; the third
  is a name that contradicts its own comment — renaming is a config break, so
  it is at least worth a sentence saying why the exception stands.

## B. Bugs — wrong behaviour today

(by package, in reading order)

### B8. `--lane` hard-codes `worktree: true` — and so does `--unlane`

`readLaneFlag`/`readUnlaneFlag` (tracker-linear/projects.ts:155,164) write
`worktree: true` into every lane they touch. Core's schema default is false
("it works in the project checkout itself") and no flag expresses the checkout
lane — the projects wizard can only mint worktree lanes. And `--unlane` names
a lane with **no agent**, which still gets the mark whose description is "the
agent gets its own git worktree": a config that states something about an
agent that is not there.

## C. Rule and boundary violations

### C1. Every optional module imports `@aivi/host` as a library

`ChannelEngine` and `ConversationStore` (discord, slack, linear),
`RunProgress`'s reducer (tracker-linear/runprogress.ts:26), `ToolError`
(browser), `ConfigurationError` (three packages), `CHAT_COMMANDS` — the kit
(`@aivi/plugin`) declares the contracts, but the reusable *implementations*
live in the host and modules import them from there. A third-party
`aivi add @someone/aivi-cool-plugin` therefore depends on the whole host
package — the same surface `aivi update` moves under it. The stated rules are
not broken (the engine never imports the command surface; core names no
platform), but the kit was meant to be the stable half. The two error classes
are a one-line move; the engine and store are a real question, for after rc.

### C2. The host's dreaming transcript names Discord

dreaming.ts:174 — the transcript header the dreamer reads says `"user" lines
from Discord start with the speaker's name and id`. The speaker lines come
from the shared engine for every platform; the host's memory machinery
hardcodes one visitor's shape into the review prompt.

## D. Swallowed errors and dishonest failure paths

### D1. `manualSources` reads a corrupt install record as "nothing installed"

core/config.ts:1162-1170: the read-and-parse of `<home>/app/package.json` is
wrapped in one catch whose comment says "No install record yet: nothing
installed" — but the catch fires on a **corrupt** manifest too, and the manual
knowledge sources silently vanish. Mitigation that keeps this small: the
composed boot path reads the same file and fails loudly, so a corrupt manifest
stops `serve` anyway; the conflation only misleads direct `loadConfig` callers.
Still the AGENTS.md shape of "no swallowed errors" — the catch should at least
distinguish absent from unreadable.

### D4. Two readers of the same file answer the same corruption two ways

`readList` (host/cli/registry.ts:47-64) reads `<home>/app/package.json` and a
corrupt file gets a named, loud error. `manualSources` (core/config.ts:1162-1170)
reads the **same file** and its catch turns the identical corruption into
"nothing installed" — silence. One of the two readings of the same fact should
behave like the other.

### D5. A hung `git fetch` parks the projects-sync job forever

Invocation tasks have no `timeoutMs` knob (shell tasks do), and
`syncProject`'s plain-git path (host/projects.ts:52) runs `git fetch` with only
the host's shutdown signal as a bound. A stalled transfer — not refused, just
quiet — holds the run `running` and its capacity slot indefinitely; nothing
in the scheduler times out invocation work.

### D6. Dreaming transcripts accumulate forever

`dream()` writes a transcript per run into `<state>/dreaming/<runId>.md`
(dreaming.ts:257-258, mode 0600 — the secrecy is right) and nothing ever
removes them; `runs.prune` prunes database rows only. A nightly dreamer leaves
a permanent paper trail of every reviewed conversation while the run rows
that point at it get pruned away.

### D7. A `/link` code can be guessed without limit

Five digits is 100,000 possibilities, fifteen minutes, and `redeemLink`
(channel/commands.ts:117) counts nothing: any channel account may spam
`/link NNNNN` and each try answers a clean matched-or-not oracle; the
'expired' reply additionally distinguishes "this code existed once" from
"never existed". The threat model is a person standing nearby, and platforms
throttle the attacker's own client — but an attempts counter per channel user,
or a longer code, is one line and closes the question.

### D8. An interjection can be lost with only a log line

module.ts:610-619 — when the steer prompt fails, the same text is re-sent as a
queue prompt; if *that* throws too, the error reaches the webhook handler's
generic catch (module.ts:741) — `log.warn('event.failed')` — and the delivery
was acknowledged already, so Linear never resends. The comment at :601
promises "said in the log, never lost"; the person hears nothing. The
conversation deserves the engine's own "I could not deliver that" line.

### D12. The Linear MCP proxy buffers request bodies without a cap

mcp.ts `readBody` accumulates unbounded, while every other body reader in aivi
caps (`readCapped`, `MAX_PUBLIC_BODY`, `MAX_DIARY_BODY`). Loopback is the
threat model, so this is consistency rather than exposure — the cap costs
nothing.

## E. Naming, jargon and unreadable spots

### E1. `lane.agent!` in the fulfilment path can write `agent: undefined` into a run row

`#fulfill` (orchestrator.ts:492-500) re-checks that the lane still **exists**
after a queue wait but takes `lane.agent!` with a non-null assertion. A config
edit that keeps the lane and drops its agent during the wait inserts
`agent: undefined` into `orchestrator_runs` — a run with no worker named. The
walk path cannot hit this (`#pass` skips agent-less lanes); only a parked
delegation can.

### E2. Dead code with an underscore: `_announceVersion`

host/opencode.ts:95-109 — no caller anywhere (its job moved to `acceptVersion`
and `logVersion`). An underscore-prefixed corpse is a comment pretending to be
a function.

### E3. `purgeProject`'s one-element `for` loop

core/projects.ts:35 — `for (const path of [resolve(home, 'projects', id)])`
iterates a literal array of one. Not wrong, just a sentence written as a loop.

### E4. `aivi_config read` of a corrupt config.json answers "Internal error"

host-tools.ts:255 — the read action `JSON.parse`s the live file; a syntax
error escapes as an untyped throw and the routes' error handler answers the
agent with the shapeless 500 "The tool failed on the host; check its log."
Every other refusal in this tool names itself.

### E5. The redirect hook denies `git remote` — including the read-only kind

redirect.ts:12 counts `remote` among the boundary verbs, so
`git remote get-url origin` — a config read that touches no network — is
denied in a worker session with "aivi crosses to the remote through its own
tools". Denying `set-url` is right; denying `-v` misdirects a worker that
wants to *know* its remote, a question no tool answers. The verb list wants a
read/write split, or `remote` wants to leave the boundary.

### E6. Durable writes are not atomic

`writeManifest` (cli/manifest.ts:22), `writeProjectLinear`
(tracker-linear/projects.ts:104) and core's `writeConfigBlock` all `writeFile`
straight over the live file. The restore-on-refusal pattern protects against
a *validation* failure only; a kill mid-write leaves truncated JSON where the
home's config was, and the next boot's only complaint is a parse error.
temp-file-plus-rename is three lines in each place.

## F. Test gaps at the boundaries that matter

- **The dreaming walk (B6) is tested against a fake that returns whatever the
  test asks for** — the ordering assumption the whole walk rests on is never
  pinned, in code or against the live API.
- **No test that repeated wrong `/link` guesses are refused (D7)** — because
  nothing refuses them.
- **Closed 2026-10-03 — `runTurn`'s fail-policy hang is pinned**: the fake
  now parks its `wait` as the real server parks it on a pending permission,
  and the standing verdict is tested to fail the turn at once.
- **Crash-mid-write (E6)** has no test anywhere; the restore tests only cover
  the clean validation failure.

## Suggested order of repair

1. **The claims that promise what is not there (D9, D10, D11)** — *done
   2026-10-03, see Disposition.*
2. **B4, B5 — fixed 2026-10-03; B3, B6 — closed** (see Disposition). **B8** remains.
3. **D1/D4 together** (one reader of app/package.json, named loudly), D5-D8,
   E1-E5 — small honest fixes.
4. **E6 and C1** — the atomic-write trio and the error-classes-into-kit move
   are the two refactors worth doing before anything external installs a
   plugin; C1's engine/store half can wait for its own plan.

## Disposition

- **B4, B5 — fixed 2026-10-03.** `runTurn` says a `fail` verdict that
  already stands **before** arming the wait: the park is an abort that only
  fires forward, so a permission pending from before the prompt used to
  hang the turn on the very wait that permission holds (the policy stays
  advertised; the fake now parks its `wait` as the real server does and
  the turn is pinned to fail in words). `Dispatcher.release()` takes the
  same rule as every other ending (the operator's ruling: *confirm kill
  before release*): an expiring lease is confirmed through `expire` before
  the slot is freed — unconfirmed, the slot stays held, the lease stays
  expiring, and the strike clock keeps trying; the stale `strikes` entry a
  released-mid-expiry lease used to leave is cleared on every release.
- **B3, B6 — closed 2026-10-03, no code touched** (the operator's rulings).
  B3: "we do not just remove dirs" — the readdir-to-stat window is a state
  nobody creates. B6: one live call answered it — OpenCode 2.0.18 answers
  `session.list` with `order: 'desc'` strictly descending by `time.updated`
  on 50 live sessions (creation order visibly is not), so the dreaming
  walk's early stop is correct as written.
- **D9, D10, D11 — fixed 2026-10-03.** The closing note's idempotence marker
  is a trailer aivi controls and reads only as a comment's last line, so a
  worker quoting its session id in prose no longer silences the closing
  (pinned by test). `aivi_jobs` answers an unreadable agent list with the
  honest 503 the create path already gave the same condition, never a
  confident "No agent exists". The forge's review read asks GitHub for
  `hasNextPage` on both connections and says `review.facts.truncated` when
  the read could not hold everything — the worker is not left believing a
  150-thread review was 100 threads.
- **B1, B2 — fixed 2026-10-03** (the operator's ruling: the board is the
  stop's memory). The HITL label rides before the run ends on both module
  stop paths; an interrupt OpenCode would not answer carries
  `stop-unconfirmed` and says so; a stopped run's worktree is torn down.
- **D2, D3 — fixed 2026-10-03** (the operator's ruling: "opencode first,
  linear second"). The answer's delivery prompts OpenCode before the books
  move: a refused prompt leaves the run parked on its open form, re-armed,
  and said in the conversation — the answer is giveable again. A books-guard
  miss answers `undefined` and says `answer.duplicate` instead of
  pretending; the double prompt itself stays by design (both are true
  answers), pinned by test.
- **B7 — removed 2026-10-03** (the operator's ruling: "remove that timeout
  option entirely and then in a future ticket we can add one to the
  dispatcher"). `turnTimeoutMs` is gone from Discord, Slack and Linear
  configs and from the `ChannelEngine`: it bounded chat turns only while
  its Linear description promised a worker-turn bound that never existed
  (worker turns were never bounded — the dispatcher's idle clock times
  silence, not turns). Until the dispatcher grows a turn bound
  ([plans/orchestrator.md](../plans/orchestrator.md)), no clock bounds a
  turn; a hung assistant turn holds one of `maxConcurrent` slots and dies
  with OpenCode's own errors or shutdown.
- **Biome diagnostics and suite slowness — fixed 2026-10-03** (the
  operator's order: "Biome has a bunch of issues you did not fix. And the
  tests are slow as fuck... I expect no more than 100ms per test. I
  tolerate a couple of 1s tests because they are truly valuable.").
  `biome check .` reports nothing: the leftovers of the dead-code sweep
  (its `--write` pass had skipped the unsafe fixes) are reviewed and
  applied one by one. The suite went 21s → 11s wall and no test waits a
  real second any more by construction: the dispatcher and the
  keep-alive take **numbers** at the unit (the duration strings stay the
  config's surface), the GitHub client no longer carries octokit's
  throttling plugin (a Bottleneck that held *every* write one full
  second, rate limit or not), and the git fixtures are built once per
  file and copied per test instead of ten `git` spawns each. The tests
  that still bought their answers by spawning git and child processes —
  the forge, the worktree teardown, the project sync, the git tools, the
  CLI mechanism, the exec relay — are **units** now (ruled 2026-10-03:
  "make those testable as units... we do not have to test the libraries
  we use"): each git and child crossing is an injected answer, every
  call is on record, and what the tests pin is our decisions — which
  argv where, which refusal means what. Whether git really merges and
  moves files stays git's own unit and the live gate's subject
  (`npm run smoke`). The suite runs 515 tests in about 3.5s; the one
  test that waits a real second is the shell timeout's blocking
  classification, a floor our own schema sets (`timeoutMs ≥ 1000`).
- The rest: operator's call on each.

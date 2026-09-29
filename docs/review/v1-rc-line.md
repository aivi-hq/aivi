# Review: the v1 rc line (2026-09-30)

Scope: everything written 2026-09-28 through 2026-09-30 — `9dc3da0` (the pure
host) through `3d5fcfe` (the module-id rename): the exec door and its relay,
`aivi configure`, the project-section compose mechanism, the tracker seam, the
forge contract and `@aivi/forge-github`, and the rename itself. Read by hand,
top to bottom, no child agents. **No code was edited for this review**; every
line below is a finding for the operator to decide on.

The verdict first, because it is mostly good: the forge boundary (remote, not
git), the module-id/platform-id split, the compose closure and the registry's
boot order all hold in the code, not just in the plans. The contracts read as
decided documents, the comments carry their reasons, and the new packages
carry real tests. What follows is one class of genuine bug, one live boundary
violation with a credential consequence nobody wrote down, and a long tail of
consistency and hygiene findings.

## A. Bugs — wrong behaviour today

**A1. The Linear installer still reads the *old* config key.**
`packages/tracker-linear/src/setup.ts:167` reads
`ctx.config.plugins?.linear` — but the rename commit moved the block to
`plugins.tracker-linear` and updated only the *write* at `:456`. Three
consequences, in order of harm: (a) re-running `aivi add` on a configured
home never sees the existing block, so the "already has N apps" guard at
`:169` never fires and the app-id prompt is asked again; (b) worse, the write
at `:456` spreads `...existingBlock`, which is now always `undefined` — so a
second app written into a configured home **silently drops every field the
block already held** (`agent`, `resource`, `primary`, `listener`, `mcp`,
`host.public` lives elsewhere, but everything in the block is lost); (c) the
prefill of `configured[0]` never happens. Nothing caught this because
`packages/tracker-linear/test/` has **no setup.test.ts at all** — the only
631-line installer of the five plugins is the one without a setup test
(discord, slack and forge-github each have one). Fix: read
`?.[MODULE_ID]`, and give the installer at least the three tests its siblings
have (writes both files; refuses an already-configured home; never writes on
a refused token).

**A2. The exec door can be talked into spawning two children per session.**
`packages/host/src/api/exec.ts:183` refuses a second `start` only when
`session.pty || session.pipe` is already set — but `session.pty` is assigned
at `:216`, *after* `await importPty()` at `:207`. Two `start` frames sent
back-to-back (a buggy or malicious client) both pass the guard and spawn two
`aivi` children with the operator's bearer; the second assignment overwrites
the first, so `kill()` reaches only one and the audit records one session.
Set a `starting` flag before the await, or assign a placeholder.

**A3. `aivi -r` loses stdin when stdout is a TTY but stdin is not.**
`packages/cli/src/exec.ts:83-84`: `piped` is decided from **stdout** alone;
`terminal` additionally requires stdin to be a TTY. `echo x | aivi -r chat`
from a laptop asks the server for a PTY (`start.pty` stays true at `:132`),
but the client never enters raw mode and never forwards stdin data — the
remote command waits for input that was silently dropped. Decide PTY vs pipes
from `terminal`, not from `piped`, or forward stdin whenever it has data.

## B. The live boundary violation — a fetch that attributes to the human

The ruling (forge-github.md, 2026-09-29) is: *anything that reaches `origin`
authenticates, so it belongs to the forge; aivi never silently acts as the
person.* The forge package honours it to the letter — per-invocation
`credential.helper=` off, HTTPS named on the command line, no token ever
written into a repo. And then the host, on a schedule, does exactly the
forbidden thing:

**B1. `packages/host/src/projects.ts:38`** — the `projects.sync` job runs a
plain `git fetch --quiet --prune` in every project's `source/`, with the
host's ambient environment: no `GIT_TERMINAL_PROMPT=0`, no credential-helper
control. On macOS with the usual `osxkeychain` helper configured globally, a
fetch of a private repo **succeeds as the human** — a read attributed to the
person, silently, every five minutes. Without a helper it fails or (worst
case) blocks on a prompt. The forge-github module header says this transfer
"lands with the orchestrator", which is true of the *machinery*, but no
document records the *credential consequence* — that between a forge-github
clone and the orchestrator extraction, every scheduled sync is the person's
fetch, not aivi's. The clone itself deliberately leaves no credential behind,
so the sync falls back to the machine's ambient identity. Either gate the
sync behind the forge registry now (skip it when a forge is configured), or
record the consequence in `docs/plans/forge-github.md` where the operator
accepting the interim state will actually read it.

**B2. Same consequence, smaller door: `packages/tracker-linear/src/worktree.ts:91`**
— `ensureWorktree` runs `git fetch --quiet --prune origin` with the ambient
environment before creating a worktree. Every worker start is a fetch as
whomever the machine's helper knows. This one is inside the code the
orchestrator extraction is about to move anyway; it earns the same
treatment as B1.

## C. Where a contract says one thing and the code does another

**C1. `blockedByStates` — the contract lies about who decides "finished".**
`packages/plugin/src/tracker.ts:47-49` promises: "the states … in the
platform's own words; **the platform answers which of them are finished**."
The adapter (`packages/tracker-linear/src/tracker.ts:93`) passes Linear's raw
state-type words through, and the decision code compares them itself:
`packages/tracker-linear/src/module.ts:421` —
`issue.blockedByStates.some(t => t !== 'completed' && t !== 'canceled')`.
That is Linear's vocabulary inside the machinery the seam header at `module.ts:1-11`
swears is Linear-free ("decision code imports no Linear types"). A second
tracker would have to teach *module.ts* its finish words. The neutral fix is
small: the adapter narrows — e.g. `blockedByUnfinished: boolean` (or
`blockedBy: { state: TrackerState, finished: boolean }[]`, with `TrackerState.type`
kept for whoever wants the raw word) — and the comparison moves behind the
adapter, which is where `webhook.ts`/`client.ts` already know `completed` and
`canceled`. The same hardcoded pair reappears at
`packages/tracker-linear/src/setup-project.ts:66` — there it is *allowed*
(it is Linear's own contributor file), which is exactly why the module.ts one
matters: the rule is "Linear words live in Linear's files", and module.ts is
not one of them.

**C2. `routed.linear` — the renamed section, still named `linear` in the
view.** `packages/tracker-linear/src/projects.ts` correctly reads the
`tracker-linear` section (`SECTION` at `:22`), but the typed view keeps the
field `linear` (`RoutedProject.linear`, type `ProjectLinear`), and the
decision code reads `routed?.linear.lanes` at `module.ts:345` and `:455`.
Inside the plugin this is legal — but the file then says the module "speaks
only the Tracker contract", and `routed.linear.lanes` is the one place it
speaks the *old config key* instead. Rename the view field and type
(`routed.tracker.lanes` / `TrackerProject`, or `routed.lanes` outright); it
is a plugin-local name with no persisted bytes behind it, exactly the kind
the ruling said was free to move.

**C3. The `AiviPlugin` contract never states the module-id rule it now
guarantees.** `packages/plugin/src/plugin.ts:19-20` defines `id` as "the
module id: the `plugins.<id>` config key, the logger category, the `/status`
id" — accurate — but says nothing of the 2026-09-30 ruling that it **is the
package's short name**, which is now the stated rule in configuration.md and
CONTEXT.md and the reason a third-party package "brings its own id" can never
collide. The contract doc is where a plugin author will look; it should carry
the convention (and the platform-id caveat). Small nit in the same file,
`:26`: "`projects.<id>.<id>`" uses the same placeholder twice for two
different ids — write `projects.<projectId>.<moduleId>`.

**C4. "logger category" is a convention, not a mechanism.** `plugin.ts:19`
and the module-id docs say the module id *is* the log category; what actually
happens is each module choosing `services.log.getChild(MODULE_ID)` for itself
(all five now do — tracker-linear `module.ts`, both channels, forge-github
`module.ts:26`), and core's `CATEGORY_COLORS` (`packages/core/src/log.ts:39-40`)
hand-listing each one. Nothing stops a module logging under a foreign
category, and a new first-party package silently gets an uncoloured category
until someone edits core. Acceptable as convention; worth one sentence saying
so, or a colour fallback that doesn't need a core edit per plugin.

## D. Error classes — fatal-or-retrying is a decision, make it deliberately

The supervisor treats `ConfigurationError` as fatal-stopped and every other
error as degraded-and-retry-forever (`packages/host/src/modules.ts:110-124`).

**D1.** `packages/tracker-linear/src/module.ts:102` — a Linear team claimed
by two projects throws a plain `Error`. The message literally begins
"Linear config:" — it *is* a configuration error, but it lands in the
retrying class: the module will hammer a decision no retry can change and
`/status` will call it degraded. Make it `ConfigurationError`.

**D2.** `packages/forge-github/src/forge.ts:150-152` — "a pull request aivi
cannot see is said, not answered empty" throws a plain `Error` for a
permanent permission condition (invisible repo); same argument as D1, weaker,
because a 404 can be transient replication. Worth a thought, not a crime.

**D3. The forge setup has no "already configured" refusal.** Discord
(`channel-discord/src/setup.ts:63-67`) and Slack refuse to re-run on a
configured home and tell the person to edit the block; Linear refuses above
one app (`tracker-linear/src/setup.ts:169`); forge-github's setup
(`forge-github/src/setup.ts`, the `already?.app` prefill) happily re-runs the
whole app-and-key ceremony on a configured block and overwrites both. The
three-way inconsistency is the finding; pick a house rule (refuse, like the
channels) and make forge follow it.

## E. Silent limits and unbounded reads

**E1.** `packages/forge-github/src/forge.ts:94` — `reviews(last: 50)` is
fixed, and the REST reads cap at `per_page: 100` for threads and comments; a
review with more than 100 threads or 50 reviews is **silently truncated** —
and "here is everything the review said" is the one promise that must not be
almost-true. Either paginate to a stated bound or put the truncation into
`ReviewFacts` as a field.

**E2.** `packages/forge-github/src/setup.ts:138` — `total_count >= 100`
prints "more than 100" when it is exactly 100.

**E3.** `packages/tracker-linear/src/mcp.ts:128` — `readBody` has no size
limit and the upstream request has no timeout: a local process can make the
host buffer an unbounded request, and a hung Linear upstream holds a socket
and its buffered body until `stop()`. Loopback-only shrinks the risk; a
max-body and a timeout are two lines each.

**E4.** `packages/tracker-linear/src/setup.ts:504-512` — `latestId()` walks
the *entire* request diary, and `waitDiary` calls it inside every 2-second
tick (`:558`) for up to 90 seconds. On a big diary that is a full scan every
tick. A `MAX(id)` query, or remembering the last id instead of re-deriving
from zero, fixes both.

**E5.** `packages/tracker-linear/src/setup.ts:40` — `probeWindowMs()` is
`Number(env)` unguarded: `AIVI_PROBE_WINDOW_MS=abc` makes every wait expire
instantly (setTimeout with NaN fires immediately), and the installer reports
"nothing arrived" for a perfectly good webhook. Parse and fall back.

## F. Credential hygiene

**F1.** `packages/forge-github/src/github.ts` — `runGit` spawns git with
`env: { ...process.env, ...credential }`: every secret in `<home>/.env`
(Linear secrets, bot tokens, the GitHub PEM itself) is handed to each git
child. git is a trusted binary and doesn't leak its environment, but the
host's own shell-task machinery scrubs exactly this set
(`packages/host/src/runtime.ts:205`, the 522640b lesson) — a forge transfer
deserves the same closed environment (`PATH`, `HOME`, `GIT_*`, and the
credential, nothing else).

**F2.** `packages/forge-github/src/setup.ts:115` — the setup writes the raw
PEM into the CLI process's own `process.env` so the in-process verification
can use it. Scoped to a one-shot process and commented; noted because
"credentials live in the environment" and this is the one place aivi
synthesises one rather than reading it.

**F3.** Bearer parsing is case-sensitive in both doors — `api/exec.ts`
(`/^Bearer /`) and `api/person.ts:14` (`startsWith('Bearer ')`). Consistent
with each other at least; `Authorization` schemes are case-insensitive by
RFC. Third-party clients sending `bearer …` would be silently anonymous (API)
or refused (exec). One `toLowerCase()` each.

**F4.** `packages/tracker-linear/src/client.ts:163-181` — `fetchToken` has no
timeout; a hung Linear token endpoint parks every caller behind the shared
`refreshing` promise. The module's start would sit in "starting" forever.

## G. The CLI face

**G1. `PLUGIN_ALIASES` (`packages/cli/src/add.ts:23-28`) is now half a
decision.** The aliases (`discord`, `slack`, `browser`, `linear`) are
conveniences that predate the module-id ruling, and the ruling's promise —
"the word you type is the word you write" — is exactly what they break: type
`linear`, write `tracker-linear`. They still map to npm names correctly and
nothing is broken, but three questions are open and only the operator can
answer them: keep the aliases as install shorthand (fine, and the config
docs already say so), **add** `forge-github` (why would it be the odd plugin
out?), and **delete** them at some point so the typed word is the package's
short name everywhere. Related nit: the add/remove usage errors
(`add.ts:203`, `remove.ts:81`, `:88`) enumerate `browser|discord|slack|linear`
— forge-github is already invisible in the help line. And `add.ts` capitalises
the module id for its announcement (`label = moduleId[0].toUpperCase()…`), so
a renamed channel now proudly announces "Channel-discord is running."

**G2.** `packages/cli/src/main.ts:57-60` — `-r`/`--remote` is stripped from
*anywhere* in argv, including after a commander `--` passthrough, and only
the first occurrence is removed (`-r -r` forwards a stray `-r`). Fine for
today's argv shapes; worth remembering when any command grows a `-r` of its
own.

**G3.** `packages/cli/src/service.ts:62` — the LaunchAgent's
`EnvironmentVariables` carries `AIVI_HOME` only, so the host under launchd
inherits launchd's minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`). `aivi add`
and `aivi update` relay to the host and run `npm` there — on an Apple
Silicon machine with homebrew or nvm node, `npm` is not on that PATH, and a
relayed `aivi add` fails with a bare ENOENT. Capture the installing shell's
PATH into the plist (the file is written once, at install, when the real PATH
is known — the natural moment).

**G4.** `packages/cli/src/update.ts` — `updateServer` `JSON.parse`s
config.json without a guard: a file with a trailing comma earns the operator
a raw V8 SyntaxError instead of aivi's honest "config.json does not load".
And `:provisionNode`'s `.catch(() => '')` swallows an engines-lookup failure
offline and proceeds — defensible, but say "could not check engines" rather
than nothing.

**G5.** `packages/cli/src/service.ts` — systemd gets `Restart=on-failure`,
launchd gets `KeepAlive`: a clean host exit restarts on Linux and stays down
on macOS. One restart semantic, or a comment saying the asymmetry is meant.

**G6.** `packages/cli/src/add.ts:49` (and remove.ts:78) — `flags[0]` names
only the first unknown flag; typing two hides the second until the first is
removed. Nit.

## H. `aivi projects add` runner

**H1.** `packages/host/src/cli/project-setup.ts:19-20` — the no-forge note is
written as `source/AGENTS.md`. AGENTS.md is *instruction* carrier by universal
agent convention; today the text is a benign paragraph, but choosing that
filename means anything ever written there is read as instructions by every
agent that walks the tree. `README.md` carries the same honesty without the
convention.

**H2.** `packages/host/src/cli/project-setup.ts` — the "Project name" prompt
is not validated against `PROJECT_ID`; a name with a space walks the whole
contributor flow (network reads, maybe a clone) before the registry's schema
parse refuses it and restores the config. Validate at the prompt, like every
other prompt in the codebase does.

**H3.** The runner's ordering design (roles first, non-role contributors
after, name threaded once) is good; noted only that a contributor that
*throws* mid-flow leaves whatever its own writes already landed (the forge
clone cleans up after itself, a tracker's own `writeProjectLinear` does not
roll back). The cancel line says "Nothing further was written" — true
forward, not backward. One clarifying sentence at the cancel line would make
it precise.

## I. Linear secret-name collision

`packages/tracker-linear/src/config.ts` — `linearSecretNames` uppercases the
app id and maps `-`→`_` to build `LINEAR_<APP>_CLIENT_ID`. Two app ids that
differ only in dash-vs-underscore (`a-b` and `a_b`) map to the **same secret
names** — `requireLinearSecrets` then reads one app's token for the other,
and both webhooks attribute to whichever app's credentials happen to be in
.env. PROJECT_ID allows both spellings, so the config accepts the pair.
Either refuse colliding app ids at cross-field time, or (simpler) include
the app id verbatim in an error when two configured apps resolve to the same
secret names.

## J. Stale words inside the renamed package (documentation drift)

The rename commit swept keys, ids and docs outside the package; these are
inside `packages/tracker-linear/src/` and still say the old key. The first
one is user-facing:

- `tracker.ts:49` — the ConfigurationError tells the operator to set
  **`linear.primary`** — a key that no longer exists. The fix instruction in
  a fatal error message is the most load-bearing sentence in the file.
  (`:43` comment too.)
- `config.ts:140` — comment: "the one app, or `linear.primary`".
- `config.ts:148` — comment: "`linear.agent`".
- `config.ts:176-177` — comment: "`projects.<id>.linear`".
- `config.ts:215` — comment: "`projectDefaults.linear.lanes`".
- `config.ts:226` — comment: "the `linear` sections of a project".
- `config.ts:10-20` — placement: the schema's doc comment ("The Linear
  module. One app does the work…") now sits *above* the MODULE_ID block, so
  two doc comments stack and the first belongs to nothing; move it back onto
  `linearSchema`.
- `module.ts:73` — comment: "the project's `linear` section".
- `setup.ts:450` — comment: "the `linear` block with this app added" —
  directly above the write that writes `tracker-linear`.
- `setup-project.ts:3` — header: "hands back the `linear` section".

## K. forge-github package nits

**K1.** It is the only one of the five plugins without a `MODULE_ID`
constant — `'forge-github'` is hardcoded as the module id (`config.ts`) and
again as the log child (`module.ts:26`). The other four spell it once.

**K2.** `forge.ts:201` — `prForBranch` lists with `state: 'all'` and takes
the newest by creation. `push` treats any hit as "existing" and will not open
a PR beside a **closed** one: a human who closed the PR, then a worker's
final push, gets the closed PR's facts returned as if live. Arguably the
right conservative choice (never re-open against a human's closing) — but it
should be *said* ("the newest PR for this branch is closed"), not returned
silently as `existing`.

**K3.** `forge.ts:242` — `resolveThread` is two mutations with no
idempotency: reply lands, resolve fails (network tick), and the retry posts
the same answer to the thread twice. A person-facing duplicate; a
"already-resolved answers without replying" pre-check would make the retry
safe.

**K4.** `github.ts:104-148` — `GitHubApp.connect` ignores the abort signal
through the JWT→installation-token→installations→repo round trip; a shutdown
during boot waits on GitHub's own timeouts.

**K5.** The test mock `test/github-api.ts:66` routes on `METHOD /pathname`
only — request bodies are recorded but never matched. Which means octokit's
parameter shapes (`pulls.create`'s `base`/`head`/`maintainer_can_modify`,
the GraphQL variable names) are **asserted by nothing but the live gate**.
The plan already promises "one real pull request read" as the gate — this
line is here so nobody mistakes the 46 green tests for proof the request
bodies are right.

**K6.** `setup-project.ts:24-27` — `suggestedProjectId` has no length cap;
GitHub allows ~100-char repo names, and the project id inherits all of it.
PROJECT_ID has no max either, so nothing complains — a directory name that
long flirts with PATH_MAX for the worktrees under it.

## L. Small ones, listed so the list is complete

- `tracker-linear/src/module.ts:138` — `home` derived by
  `loaded.path.replace(/\/[^/]*$/, '')` instead of `dirname()`; works, reads
  as cleverness.
- `tracker-linear/src/setup-project.ts:12` — the contributor logs under
  `['aivi','projects']`, not the module's category; the rule "the module id
  is the log category" now has this one exception inside a first-party
  package. (`host/src/cli/project-setup.ts` logging under `aivi.projects` is
  core's own runner — that one is *fine*.)
- `tracker-linear/src/worktree.ts:51` — `markWorktree` writes four `git config`
  settings as four child processes on every worker start; one batched pass
  would do.
- `tracker-linear/src/webhook.ts` — `Buffer.from(header,'hex')` silently
  truncates on invalid hex; the length check before the HMAC catches every
  real mismatch, so the truncation can only ever make a bad signature *fail*,
  which is honest. Noted as "checked, fine".
- `tracker-linear/src/client.ts:198` — GraphQL-level errors carry HTTP
  status 200 inside `LinearApiError`; callers who switch on `status` must
  know 200 can mean "the API refused". The doc on the class doesn't say.
- `host/src/api/exec.ts:269` — the upgrade handler answers a raw 404 for any
  non-`/exec` upgrade path and destroys the socket; fine while `/exec` is the
  only upgrade, and the first future upgrade will trip over it.
- `cli/src/exec.ts:132` — the client's pipe-mode decision (see A3) is the
  one place `piped` and `terminal` diverge; fixing A3 fixes this line's twin.
- `host/src/cli/context.ts:41-42` — `context()` loads the composed config and
  *then* the registry separately; `loadComposedConfig` reads the registry
  internally, so every CLI command pays two manifest reads and two
  (cached) imports. Correct, measurable, ignorable — noted for the day
  `aivi --help` feels slow.

## What is right, said once so the review isn't only a list of stings

The compose closure (`core/src/config.ts:725-760`) is the correct mechanism:
closed schema, plugin-owned blocks and sections, unlisted block fails
validation, editor schema follows. The registry's boot order and the
enabled/listed split are exactly as planned and the tests at
`host/test/registry.test.ts` prove both faces. `channel/store.ts`'s quoted
identifiers with the platform-id comment, `contract.ts`'s platform-vs-module
id prose, and the two ids in every plugin's header mean the 2026-09-30
ruling is now readable from the code itself. The forge contract's
"types-only, provisional by design" framing with the clone deliberately on
the contributor rather than the interface is the right cut. The exec door's
audit-everything posture, the closed child environment, and the
announce-before-disconnect chokepoint are the kind of detail a live-tested
protocol should have and usually doesn't. `webhook.ts`'s constant-time
verification with the replay window, and the diary-watch installer that
proves both systems before writing a byte, are the strongest files in the
repo.

## Suggested order of repair

1. **A1** (stale read + missing setup test) — the only silent data-losing
   bug found.
2. **B1/B2** — gate or document the ambient-credential fetch; the ruling and
   the code disagree *today*.
3. **A2, A3, D1** — one race, one lost-stdin, one wrong error class.
4. **C1** — move the finish-words behind the adapter before the orchestrator
   extraction copies module.ts into the host carrying Linear's words with it.
5. **J** — the stale comments, in the same breath as whatever commit touches
   each file; **G1** (the alias decision) alongside.
6. Everything else as the files come past.

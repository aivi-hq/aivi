# 4 · Remote: the typed flag and its channel (the bolt-on)

Status: planned. Merged with the visibility phase (old phase 5) on 2026-09-28: it
became plumbing on this seam once driving another machine turned
into a typed flag instead of an inferred state. Depends on:
[one-cli.md](one-cli.md); lands easier after phases 2–3. Constrained by rule:
**nothing here may change local execution** — local stays in-process, direct,
optimal. This is a convenience layer.

Goal: discoverability without a metadata matrix — two facts about the machine,
two small command sets, and driving another machine is a typed flag, not an
inferred state. Decided 2026-09-28 (the explicit-flag and streaming shape,
D11 amended and D23 below).

## Requirements

- The aivi port is the **only way in**. Remote people must be able to restart
  aivi and add a person from their laptops.
- They must **not** get shell access: the host executes aivi commands, never a
  shell — argv arrays into the CLI, so "not freely roam the server" is a
  mechanical property, not policy.
- Interactive commands keep working: clack prompts, masked passwords,
  spinners, ctrl+c, resize.

## Two machine states + one typed flag (D11 amended 2026-09-28)

Process state is two facts about this machine, decided once per run from
`~/.config/aivi.json` and the home directory — and nothing else:

| State | Decided by | Help shows | Plain commands run |
| --- | --- | --- | --- |
| `fresh` | no client config, no home here | `setup`, `version`, `upgrade`, `uninstall` — that is it | locally; anything needing a home is **not registered** (decision A, 2026-09-28): a typed command is honestly `unknown command`, and the help header carries the machine fact (`home: none`) |
| `local` | home on this machine | everything (host down is fine: store-direct commands work) | in-process |

`uninstall` belongs to the homeless machine too: the exit ramp exists
wherever the CLI is installed — a CLI that refused to exist without a home
could never be uninstalled.

The old design inferred a third state, `remote`, from a config `url`, and
made the laptop behave as the server. That killed the very command the
client config motivates: `configure` cannot edit the laptop's own config
from a laptop that has been told it is remote. Being explicit is easier
and it teaches: **driving another machine is intent, typed as `--remote`
(alias `-r`)** — `aivi -r add slack`. An operator who lives on the server
ssh's in and runs it there; the flag is for the crossing now and then, not
for a seamless illusion.

**Plain commands never touch the network.** Help is offline, plain
commands act locally, and only `--remote` opens a connection. (`serve` in
`local` while a host already answers: the command itself prints
`server already running` and exits — that is the command's behavior, not a
help-time probe.)

## What `--remote` does (decision D23)

- Reads the client config's `url` and person token, opens the
  [exec channel](#protocol), and relays argv verbatim; the server's
  commander parses. The server knows its own command tree; the client
  knows nothing about it. No config `url`: `no server configured — run
  aivi setup` (the line names the command that creates the record;
  `configure`, landed later, edits one that exists). Server unreachable:
  `host unreachable at <url>` —
  there is no fallback to local; someone who asked for remote gets the
  honest failure, not a different machine's answer.
- `aivi --remote --help` **streams the server's page**: the server renders
  its complete help with its own commander and the client prints it — one
  banner, one usage, one command table, no splicing. The page is the
  server's truth: version skew (laptop CLI 0.9, server 0.8) shows what
  will actually run, which a cached catalog would get wrong.
- Rejected 2026-09-28: a cached command catalog — a server-side listing
  the client fetches and stores under `state/cache/`. It would mean a
  custom help renderer, or rebuilding the server's commands as
  client-side objects just so commander could print them: two workarounds
  around the fact that the server already has a complete, honest help
  page.
- `fresh` streams nothing without the flag: there is no server to ask, and
  the help header — `home: none` — states the machine fact instead of any
  bolt-on answer. Commands that need a home are not registered here at all:
  membership belongs to the provider, decided by not registering, never by
  hiding after the fact.

The "server running" axis needs no per-command flag: a `--remote` command
has the connection as its stated precondition, and a plain `local` command
that needs the host says so when the host is down. `link` gets **no
special treatment** — it is an ordinary untagged command whose
implementation happens to speak HTTP; with `--remote` it is relayed like
any other, with the operator's bearer in its env.

## The sets

- **client-side** — act on the machine you type on; `--remote` is
  *refused by them* with the guard message `this acts on the machine you
  type on`: `setup`, `upgrade`, and `configure` (landed 2026-09-29:
  registered only where a client record exists — existence, not
  parseability). (`upgrade`
  npm-updates the global CLI itself; `add`/`update` are *not* here — they
  act on the server machine and therefore relay.)
- **refuse-relay** — server-side but rejected over the channel: `serve`
  (the server is the thing being driven) and `uninstall` (decision D14:
  deletes the home and kills the relay's own parent). A refused command
  answers with its guard message, never `unknown command`, whatever the
  help showed.

Everything else — `status`, `jobs`, `runs`, `projects`, `people`,
`knowledge`, `link`, channel subtrees, `add`, `update`, `service`
(including its `restart`) — is untagged: in-process in `local`, relayed
with `--remote`.

Landed 2026-09-28: the sets are the *commands'* decision, carried by the
machine fact (`MachineStatus.remote`, born as `AIVI_EXEC_SESSION` in the
door's closed env), not by a channel-side blocklist. The client-side set
answers `this acts on the machine you type on` at the top of its own action;
`uninstall` and `serve` answer their refuse-relay lines; `-r` itself refuses
to chain a second hop. `serve` additionally answers `server already running`
when a host already answers its configured endpoint (one probe at invocation,
never a help-time check). Help shows the truth either way — a refused command
is not hidden, it is refused when run.

## Transport

**The wire carries terminal bytes; commands are not remapped to JSON
operations.** The previously planned `POST /v1/ops/<name>` dispatcher is
rejected: it would define, version, and hand-roll (spinners, prompts, output
shapes) what a normal process already provides. With a byte relay the CLI
itself is the protocol — the client ships argv + TTY bytes, the server runs
the same CLI as a child on a PTY, and the payload is the human's terminal,
which is version-independent by construction.

**Websocket upgrade on the existing HTTP server, not an embedded ssh2
server.** Checked 2026-09-27: ssh2 is alive but single-maintainer, pure-JS
(latest 1.17.0, 2025-08-20), and would still need `node-pty` for PTY
allocation. Its one unique win — a bare OpenSSH client with zero install — is
dead: every remote person installs the aivi CLI to run `aivi setup` anyway.
The relay instead reuses the existing port, bearer auth, request diary, and
version gate; no host keys, no password daemon, no second listener.

Landed 2026-09-28. [operations](../../operations.md#running-remotely) owns
the transport and the visibility table; this section keeps only the two
rejected alternatives and why.

## Protocol

Endpoint: `/exec` as an upgrade on the host's HTTP server — not `/v1/exec`:
the API version lives in a header, not in paths (the same rule as `POST /wake`).
The upgrade never crosses hono — node hands it to the door directly — so the
door runs the existing chain by hand, in the same order the API runs it:
version gate → bearer → person → operator. Opening it
requires the **`operator` role** (decision D16 — the roles store of 2026-09-21
gets its first real customer). The bearer stays a plain token in this phase;
[person id + token pairing](#person-id--token-pairing) is deferred.
A per-source throttle: **decided at landing (2026-09-28) to ship the door
without one** — the upgrade bypasses hono, so
[hono-rate-limiter](https://honohub.dev/docs/rate-limiter) as middleware in
front of the route does not fit, and hand-rolling a limiter is the plumbing
this clause refused to grow. General HTTP-API
rate-limiting stays the separate idea in
[request-rate-limiting](../../backlog/request-rate-limiting.md).

Messages (client → server first):

```json
{ "t": "start", "argv": ["jobs", "add", "…"], "term": "xterm-256color", "cols": 120, "rows": 30 }
{ "t": "start", "argv": ["status"], "pty": false }   // the piped session (D12)
{ "t": "resize", "cols": 100, "rows": 40 }
<binary frames>                      // stdin bytes
```

```json
{ "t": "ready", "pid": 4711 }
<binary frames>                      // stdout+stderr merged, as one PTY sees them
{ "t": "err", "b64": "…" }           // pipe mode only: stderr kept apart
{ "t": "exit", "code": 0 }
{ "t": "error", "message": "…" }     // the protocol's own refusal (start twice, bad start)
```

Server side: `node-pty` spawns
`aivi ...argv` — the CLI binary on PATH, the same tree the operator typed
into (the host parses no argv of its own since the purity pass) — with a
**closed** `env`: `{ PATH, HOME, AIVI_HOME, TERM, AIVI_OPERATOR_BEARER, AIVI_EXEC_SESSION }`
plus `COLORTERM`/`LANG` when the host has them. PATH and HOME are what
`add`/`update` need to exec npm and git; nothing else from the host's
environment travels. `AIVI_EXEC_SESSION=1` is the machine fact the child runs
under — it is the far end of a channel — so the command sets answer their
guard lines themselves (see [the sets](#the-sets)); no argv inspection
decides it. Child close ⇒
`{t:"exit"}` then socket close; socket close ⇒ kill the child. Client side:
`process.stdin.setRawMode(true)`, forward bytes, `SIGWINCH` ⇒ `resize`,
`{t:"exit"}` ⇒ restore + `process.exitCode = code` — restore on **every** exit
path (that is the ctrl+c lesson, applied on the client where it belongs).
Throughput, binary safety, interleaved stdout/stderr: the standard
ttyd/code-server pattern, production-proven.

**Piped output (decision D12):** if the *client's* stdout is not a TTY
(`aivi status | jq` from a laptop), the client requests a non-PTY session —
two pipes, stdout and stderr kept separate, JSON mode intact because the
child's `isTTY` is honestly false. `ssh` vs `ssh -t` semantics; one branch,
no loss. Landed shape: stdout keeps the binary frames (a pipe gets JSON
untouched); stderr rides base64 inside `{t:"err"}` so the two never merge.

## What `--remote --help` renders

Amended 2026-09-28, before landing: there is no render-time visibility
pass. The server streams its own `--help` page as-is — the same tree it
runs — and the two sets answer at *invocation*, from the machine fact the
door stamps into the child's env (`AIVI_EXEC_SESSION`): the client-side
set answers `this acts on the machine you type on`, the refuse-relay set
answers its own refusal. `serve` and `uninstall` are real on the server;
hiding them from the page would decorate the truth for a decision nobody
makes at help time. The page carries the `(remote)` marker so nobody
mistakes whose tree they are reading. That is the whole implementation:
one page, two guard lines, no visibility machinery.

## The remote banner

The streamed page carries a marker, so it is unmistakable that the process
answering is on the server: `(remote)` after the version in the title
line, and the AIVI lettermark in a different color from the theme's blue.
The hex and the drawing belong to the brand module in `@aivi/core`; the
CLI's stand-alone copy
([brand.ts](../../../packages/cli/src/brand.ts) — "keep the two in sync")
gains the same. A stream without color drops the mark as decoration, as
it already does.

````
  ▄▀█ █ █ █ █      aivi v0.8.1 (remote) — the always-on teammate around OpenCode
  █▀█ █ ▀▄▀ █
````

Decided at landing (2026-09-28): **amber `#F59E0B`**, not brand purple
`#7C3AED`. The marker's job is caution — "this answer comes from another
machine" — and purple reads as another brand accent (and sits near
discord's violet), while amber is the universal caution color and
contrasts with the blue it replaces. It entered `BRAND` as `remote` in
`@aivi/core`, and the CLI's stand-alone copy carries the same hex. The
`(remote)` word in the title is plain text from the caller, so a pipe or a
NO_COLOR terminal still reads the word when the color goes; the lettermark
color is the decoration that drops, as it already does.

## Restart — a log line, not a mechanism (decision D13)

There is **no retry, no close-reason vocabulary, no resume, and no step
tracking anywhere**: the child dies with the host, gone is gone. The commands
that can end the host — `service restart`, `service stop`, `update`, and the
plugin `add`/`remove` restarts — print a notice to stdout — normal bytes —
**before** doing the thing that disconnects it:

```
server restarting…      # then launchctl kickstart -k, then the drop
server stopping…        # then the drop
```

The client says `connection lost` and exits with whatever it has. If the host
did not come back, the *next* command discovers that. The whole discipline is:
**announce first, then do the disconnecting thing.** For `update`, npm runs
while the host is alive and the announce+self-restart is the final step.
`uninstall` **refuses** the relay entirely (decision D14). Foreground `serve`
(no service installed) answers `not running as a service`.

Landed 2026-09-28 with one correction to the sentence above: `add` and
`remove` can end the host too, so the notice lives in the chokepoint —
`serviceStop`/`serviceRestart` in `packages/cli/src/service.ts` — and every
caller gets it. The write is a `writeSync` to stdout: the disconnecting call
blocks the event loop in a `spawnSync`, and a queued async write could
strand there while the relay's server is already dying. Both refuse with
`not running as a service` before touching launchctl. `serviceRestart` is
one atomic `kickstart -k` (falling back to the start path when the service
was booted out), and `update`, `add` and `remove` all restart through it —
the old stop-then-start would have left the service booted out whenever the
dying host killed the child in between. operations.md owns the behavior.

## Attribution

The *connection* is already authenticated: the client connects with its
own bearer from the client config, and opening the channel required the
`operator` role. The gap is that the **child process on the server** would
otherwise attribute itself to the server's own `~/.config/aivi.json` token.
So the relay re-exports the caller's already-presented bearer into the child's
env as `AIVI_OPERATOR_BEARER` — no new credential, just the one the channel
already saw — so `whoami`, link creation, and association name the remote
human. The name joins the fixed token names scrubbed from task scripts' env
([configuration.md](../../configuration.md) owns that list).

## Person id + token pairing

**Deferred 2026-09-28**, before this phase was built: the current token-only
mechanism is fine, and the new architecture — every API call already behind
hono middleware, one bearer-resolution seam — makes this a drop-in whenever
it returns. It returns as part of a future **credentials** pass, which will
rethink what the client presents at all; validating a half-measure now
would be plumbing the replacement deletes.

What was decided (D21, kept for the credentials pass): the client config
carries `person.id` next to `person.token`, and the host **validates the
pair** — the token's owner must be the presented person id, else 401.
Guessing one high-entropy value is a search; guessing a matching *person +
token* pair is a product of searches. Anonymous calls stay anonymous (auth
is `none`); the exec channel never sees them (D16). The client-config
semantics stay owned by [people.md](../../people.md).

## Security

- An exec channel is the biggest privilege aivi hands out: a PTY that can run
  `people create` and `service`. Hence the operator gate (D16).
- Tokens already travel plain HTTP today; this adds no new exposure class —
  the stated risk stays the non-loopback bind warning
  ([people.md](../../people.md)). TLS is out of scope.
- Brute force: the bearer stays a plain token this phase; the deferred
  pairing (D21) would multiply the search space whenever credentials land.
  The optional throttle is manners, not the wall.
- **Audit**: every exec session writes one diary line — person **id and
  name**, argv, source address, exit code. When something breaks, we can see
  who did it. Refusals get their own line (reason, address, and the named
  person when a bearer was presented): the door journals every arrival, which
  is exactly what the HTTP diary middleware cannot do for upgrades.

## Packaging

`node-pty` is a **server-side** dependency only (the client is raw mode +
websocket; raw mode is native to node). Landed fact (2026-09-28): the client
websocket is the `ws` package, not node's global — the web-standard client
swallows a refusal entirely (empty error, no status, no body), and D23
promised the server's honest one-liner, not the client's guess at it. `ws`
is a small pure-JS dependency, the same library the door already speaks.
node-pty is a native module: `npm install` fetches
a prebuilt binary per platform (darwin/linux exist). If a machine has none
and the build fails too, that must not take the host down at import time —
the host starts fine and answers exec attempts with `remote exec unavailable
on this host`. (Local commands never touch node-pty, so only remote exec
degrades.) Landed fact (2026-09-28): the macOS prebuilds in the npm tarball
ship `spawn-helper` **without the execute bit** and node-pty's own scripts
never fix the `prebuilds/` copy; the host repairs it once per process before
the first PTY (like VS Code's build step), and a repair that cannot happen
lands in the degradation above, never in a hung host.

## The `configure` command (built 2026-09-29)

Edits the client config itself: the host `url` (and the `home`/`appDir`
paths). It **never forgets the person** — the token is audit evidence, and
audit history is not something a laptop command erases. The most a person
can become is *disabled*, which is a server-side people decision owned by
[people.md](../../people.md), not a feature of `configure`. The typed flag
is what makes it safe: a laptop that has a server `url` configured still
configures its own config, because nothing infers "you are remote" from a
file anymore. Its membership rode the machine fact `MachineStatus.clientConfig`
(the client record's path, or none): `configure` edits that file, so it is
registered only where the file exists — a machine with no record gets `setup`
instead, which creates the first one. Existence, not parseability: a broken
record is exactly what `configure` is for. It is a client-side command, so it
refuses `--remote` like `setup` and `upgrade`, and it shows on the streamed
page because the remote person runs it on the laptop, never through the
channel. (This replaces the earlier "joins the `fresh` allow-list" line: the
allow-list became membership-by-not-registering on 2026-09-28.)

Landed as built, one discovery at the boundary: a *broken* record had made
the machine brick-shaped — `machineStatus` parsed the record, so every
command died on the schema dump, `uninstall` (the exit ramp) included. The
module now has one loader, lenient where the record is only a hint (Node,
appDir, install method); the exec relay — the one site whose bytes are
load-bearing, it signs with them — reads the record itself and fails by
name. `saveClientConfig` still fails outright on a record it cannot read,
and that stands decided (2026-09-29): `aivi setup` should not be running
where a record exists, and clobbering audit evidence is not its
remedy — `configure` is the command that rewrites broken bytes knowing
which fields survived. operations.md
owns the command; `packages/cli/src/configure.ts` is the whole thing.

## Live gates (mock tests do not establish these)

- Fresh laptop: `aivi setup --connect --url --token`, then
  `aivi -r jobs list` (and plain `aivi jobs list` is honestly
  `unknown command`, the header saying `home: none`).
- A clack prompt over the relay (`people create` mint confirm); masked
  password echo; resize mid-prompt.
- ctrl+c mid-command: child SIGINT'd correctly, client terminal restored.
- `aivi -r service restart`: prints `server restarting…` **before** the
  drop; the next command reaches the new host.
- `aivi -r status | jq` from the laptop still gets JSON (pipe mode).
- Refused: `serve` and `uninstall` answer their refusals over the channel;
  `aivi -r setup` (and `-r upgrade`, `-r configure`) answer the
  client-side guard message.

## Checklist

Ordered as built: the channel first (testable in-process), the
flag and what it teaches around it, then the strings and docs.

- [x] `/exec` upgrade route: chain order (gate → bearer → operator, run by
      hand — hono never sees an upgrade), audit line per arrival (person **id
      + name**, argv, source address, exit code; refusals carry their reason).
      The throttle ships out (see Protocol). Landed 2026-09-28.
- [x] Server: node-pty spawn, env contract, `exit`/close semantics, kill on
      disconnect, missing-prebuild degradation — and the spawn-helper repair
      the broken tarball needs. Landed 2026-09-28.
- [x] Client relay: raw mode, SIGWINCH, byte forwarding, exit propagation,
      restore-every-path; pipe-mode session branch. Landed 2026-09-28 — the
      pipe branch is tested in-process; the raw-mode branch (a real terminal)
      is for the dev-home live gate, with `process.on('exit')` as the
      restore guarantee under every path.
- [x] State resolution once per run: the one machine fact — a home here or
      none (`AIVI_HOME` → client record, no probe, no third state anywhere);
      `--remote`/`-r` parsing into the exec channel with the honest
      `no server configured` / `host unreachable` answers; the plain path
      never touches the network. Landed 2026-09-28.
- [x] Membership by not registering (supersedes the decision-A teaching
      error, 2026-09-28): the machine fact rides the help header
      (`home: ~/.aivi` / `home: none`) and is injected into every command
      provider — `registerCommands(program, machine)` and
      `PluginCliContext.machine` — so a provider excludes a command by not
      registering it. A homeless machine registers `setup`, `upgrade`,
      `uninstall` (the exit ramp) and nothing else; a typed non-command is
      commander's own `unknown command`. The logging flags moved off the
      root onto `serve`, the command that logs, so a provider pollutes no
      commands that are not its own.
- [x] `client-side` guard messages against `--remote`; `refuse-relay`
      refusals; `serve`'s `server already running` answer. Landed 2026-09-28:
      the sets are carried by the machine fact (`MachineStatus.remote` from
      `AIVI_EXEC_SESSION`), answered by the commands' own actions, not a
      channel-side blocklist. `MachineStatus` grew a third fact,
      `clientConfig` — the record's path — which decides `configure`'s
      membership the day it lands.
- [x] `--remote --help` streams the server's own page as-is (no render-time
      visibility pass — the guard lines answer at invocation) with the
      `(remote)` banner in both brand modules. Landed 2026-09-28: amber
      `#F59E0B` won the weighing (caution, not brand), entered `BRAND` as
      `remote`; the driven child's machine fact decides the marker, and the
      title's `(remote)` word is plain text that survives colorless streams.
- [x] Announce-before-disconnect in `service restart`, `service stop`, and
      `update`. Landed 2026-09-28: one `writeSync` notice in the chokepoint
      (`serviceStop`/`serviceRestart`), the `not running as a service` guard
      before launchctl is touched, and `update`/`add`/`remove` restarted
      through that one atomic call. No top-level `restart` command: restart
      is `aivi service restart`, relayed like the rest of `service`.
- [x] `AIVI_OPERATOR_BEARER` env + scrub list update in configuration docs.
      Landed 2026-09-28: the name joined `SECRET_ENV` in
      `packages/host/src/runtime.ts` (D15 — an operator's credential never
      reaches a task script, however it entered the environment), the scrub
      test proves it at the executor boundary, and configuration.md names it
      in the Secrets and shell-task paragraphs. The name is stamped by the
      door today but not yet consumed by the CLI — attribution of remote
      commands is the credentials pass's opening.
- [x] Tests: help output per state (fixture configs), guard messages at
      invocation, the right sets per state. Landed 2026-09-28 in
      `packages/cli/test/machine-state.test.ts`, driving the real `main`
      with captured streams: facts resolve once, a homeless machine lists
      `setup`/`upgrade`/`uninstall`, a homed machine shows the whole tree
      and names its home in the header, driven sessions refuse
      `setup`/`upgrade`/`uninstall`/`-r` with the set's own lines, and
      `(remote)` appears on driven pages only. The "hidden commands
      invoked anyway give guard messages, never `unknown command`" clause
      died with the hiding mechanism: a command not registered is not
      there, and `unknown command` is the honest answer (the membership
      row's supersession).
- [x] Docs: [operations.md](../../operations.md) (transport/visibility
      table), [people.md](../../people.md) (exec gate),
      [CONTEXT.md](../../../CONTEXT.md) (vocabulary: relay, exec channel),
      `packages/cli/README.md` (one command table with state and flag
      notes). Landed 2026-09-28: operations.md owns *Running remotely*
      (transport, closed env, the visibility table, the `(remote)` banner,
      the announce-before-drop); people.md's auth section lost its future
      tense about the gate; CONTEXT gains *exec channel / relay* and
      *driven session*; the CLI README's table gained `-r`, the state note,
      and lost the stale `aivi install` rows (also in the channel READMEs).
      The relay's `no server configured` line points at `aivi setup`, the
      command that exists — `configure` stays the plan's later chapter.
- [ ] Changesets (fixed group).

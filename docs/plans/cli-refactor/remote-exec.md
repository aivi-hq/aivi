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
| `fresh` | no client config, no home here | `setup`, `version`, `upgrade` — that is it | locally; anything needing a home answers (decision A): `no home on this machine — run aivi setup, or drive the server: aivi -r status` |
| `local` | home on this machine | everything (host down is fine: store-direct commands work) | in-process |

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
  aivi configure`. Server unreachable: `host unreachable at <url>` —
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
  the decision-A answer teaches the flag instead.

The "server running" axis needs no per-command flag: a `--remote` command
has the connection as its stated precondition, and a plain `local` command
that needs the host says so when the host is down. `link` gets **no
special treatment** — it is an ordinary untagged command whose
implementation happens to speak HTTP; with `--remote` it is relayed like
any other, with the operator's bearer in its env.

## The sets

- **client-side** — act on the machine you type on; `--remote` is
  *refused by them* with the guard message `this acts on the machine you
  type on`: `setup`, `upgrade`, and the planned `configure`. (`upgrade`
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

## Protocol

Endpoint: `GET /v1/exec` as an upgrade on the host's HTTP server (existing
chain: request diary → headers → version gate → bearer → person). Opening it
requires the **`operator` role** (decision D16 — the roles store of 2026-09-21
gets its first real customer) and [person id + token pairing](#person-id--token-pairing).
A per-source throttle rides along **only if it is minimal plumbing** — the
upgrade request is a plain HTTP request, so
[hono-rate-limiter](https://honohub.dev/docs/rate-limiter) as middleware in
front of the route fits or the door ships without it. General HTTP-API
rate-limiting stays the separate idea in
[request-rate-limiting](../../backlog/request-rate-limiting.md).

Messages (client → server first):

```json
{ "t": "start", "argv": ["jobs", "add", "…"], "term": "xterm-256color", "cols": 120, "rows": 30 }
{ "t": "resize", "cols": 100, "rows": 40 }
<binary frames>                      // stdin bytes
```

```json
{ "t": "ready", "pid": 4711 }
<binary frames>                      // stdout+stderr merged, as one PTY sees them
{ "t": "exit", "code": 0 }
```

Server side: `node-pty` spawns
`[nodePath, <home>/…/host/dist/cli.js, ...argv]` with `env` =
`{ AIVI_HOME, TERM, COLORTERM, AIVI_OPERATOR_BEARER }`. Child close ⇒
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
no loss.

## What `--remote --help` renders

The server renders for a remote operator: the full tree minus the
refuse-relay set, hidden through commander's own `helpVisibility` applied
at render time — `serve`/`uninstall` stay *registered* (they are real on
the server) and answer their refusal if invoked anyway. The client-side
commands show naturally: they are built into the thin CLI on every machine
and visible in the server's own local state, so no "add them even if
hidden" logic is needed — and they can never travel, because the
client-side set refuses `--remote` itself. Two states, two small sets, one
render flag — that is the whole implementation; there is no per-command
visibility matrix.

## The remote banner

The streamed page carries a marker, so it is unmistakable that the process
answering is on the server: `(remote)` after the version in the title
line, and the AIVI lettermark in a different color from the theme's blue.
The hex and the drawing belong to the brand module in `@aivi/core`; the
thin CLI's stand-alone copy
([brand.ts](../../../packages/cli/src/brand.ts) — "keep the two in sync")
gains the same. A stream without color drops the mark as decoration, as
it already does.

````
  ▄▀█ █ █ █ █      aivi v0.8.1 (remote) — the always-on teammate around OpenCode
  █▀█ █ ▀▄▀ █
````

Recorded 2026-09-28 for the comparison when the time comes: brand purple
`#7C3AED` versus amber `#F59E0B`, each against the same blue. Neither is
in the brand module yet; the banner build is where the two get weighed.

## Restart — a log line, not a mechanism (decision D13)

There is **no retry, no close-reason vocabulary, no resume, and no step
tracking anywhere**: the child dies with the host, gone is gone. Two commands
can end the host (`service restart`, `service stop`) plus `update`; each
prints its own notice to stdout — normal bytes — **before** doing the thing
that disconnects it:

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

The client config carries `person.id` next to `person.token` (the field
exists; make it required on a connected client — `whoami` already returns the
id), and the host **validates the pair**: the token's owner must be the
presented person id, else 401. Guessing one high-entropy value is a search;
guessing a matching *person + token* pair is a product of searches — brute
force gets multiplicatively harder for the exec door and every bearer call,
at the cost of one comparison. Anonymous calls stay anonymous (auth is
`none`); the exec channel never sees them (D16). The client-config
semantics stay owned by [people.md](../../people.md).

## Security

- An exec channel is the biggest privilege aivi hands out: a PTY that can run
  `people create` and `service`. Hence the operator gate (D16).
- Tokens already travel plain HTTP today; this adds no new exposure class —
  the stated risk stays the non-loopback bind warning
  ([people.md](../../people.md)). TLS is out of scope.
- Brute force: the person id + token pairing multiplies the search space;
  the optional throttle is manners, not the wall.
- **Audit**: every exec session writes one diary line — person **id and
  name**, argv, source address, exit code. When something breaks, we can see
  who did it.

## Packaging

`node-pty` is a **server-side** dependency only (the client is raw mode +
websocket, both native to node). It is a native module: `npm install` fetches
a prebuilt binary per platform (darwin/linux exist). If a machine has none
and the build fails too, that must not take the host down at import time —
the host starts fine and answers exec attempts with `remote exec unavailable
on this host`. (Local commands never touch node-pty, so only remote exec
degrades.)

## The `configure` command (later, client-side)

Edits the client config itself: the host `url` (and the `home`/`appDir`
paths). It **never forgets the person** — the token is audit evidence, and
audit history is not something a laptop command erases. The most a person
can become is *disabled*, which is a server-side people decision owned by
[people.md](../../people.md), not a feature of `configure`. The typed flag
is what makes it safe: a laptop that has a server `url` configured still
configures its own config, because nothing infers "you are remote" from a
file anymore. It joins the `fresh` allow-list the day it exists, and it
shows on the streamed page because the remote person runs it on the
laptop, never through the channel.

## Live gates (mock tests do not establish these)

- Fresh laptop: `aivi setup --connect --url --token`, then
  `aivi -r jobs list` (and plain `aivi jobs list` answers the
  `no home on this machine` teaching error, decision A).
- A clack prompt over the relay (`people create` mint confirm); masked
  password echo; resize mid-prompt.
- ctrl+c mid-command: child SIGINT'd correctly, client terminal restored.
- `aivi -r service restart`: prints `server restarting…` **before** the
  drop; the next command reaches the new host.
- `aivi -r status | jq` from the laptop still gets JSON (pipe mode).
- Refused: `serve` and `uninstall` answer their refusals over the channel;
  `aivi -r setup` (and `-r upgrade`, `-r configure`) answer the
  client-side guard message.
- A wrong pairing (`person.id` not the token's owner) is a 401, logged.

## Checklist

Ordered as built: the pairing and channel first (testable in-process), the
flag and what it teaches around them, then the strings and docs.

- [ ] Person id + token pairing: required `person.id` in the client config
      (setup writes it from `whoami`), host validates the pair on bearer
      resolution; tests for mismatch → 401.
- [ ] `/v1/exec` upgrade route: chain order, operator gate, optional
      hono-rate-limiter middleware, audit line (person **id + name**, argv,
      source address, exit code).
- [ ] Server: node-pty spawn, env contract, `exit`/close semantics, kill on
      disconnect, missing-prebuild degradation.
- [ ] Client relay: raw mode, SIGWINCH, byte forwarding, exit propagation,
      restore-every-path; pipe-mode session branch.
- [ ] State resolution once per run (client config → `fresh`/`local`); no
      third state anywhere. `--remote`/`-r` parsing: config `url` + token →
      exec channel; honest `no server configured` / `host unreachable`
      answers; plain path never touches the network.
- [ ] Decision-A answers: a home-needing command in `fresh` prints
      `no home on this machine — … or drive the server: aivi -r …`;
      the `fresh` help allow-list.
- [ ] `client-side` guard messages against `--remote`; `refuse-relay`
      refusals; `serve`'s `server already running` answer.
- [ ] `--remote --help`: server renders the remote operator's view
      (`helpVisibility` at render time, refuse-relay hidden) with the
      `(remote)` banner in both brand modules (`#7C3AED` vs `#F59E0B`
      weighed here).
- [ ] Announce-before-disconnect in `service restart`, `service stop`, and
      `update` (the notice is printed before the self-stop; no mechanism
      beyond that sentence). No top-level `restart` command: restart is
      `aivi service restart`, relayed like the rest of `service`.
- [ ] `AIVI_OPERATOR_BEARER` env + scrub list update in configuration docs.
- [ ] Tests: help output per state (fixture configs); `--remote setup`
      gives the guard, hidden commands invoked anyway give guard messages,
      never `unknown command`; the remote render shows and hides the
      right sets.
- [ ] Docs: [operations.md](../../operations.md) (transport/visibility
      table), [people.md](../../people.md) (exec gate),
      [CONTEXT.md](../../../CONTEXT.md) (vocabulary: relay, exec channel),
      `packages/cli/README.md` (one command table with state and flag
      notes).
- [ ] Changesets (fixed group).

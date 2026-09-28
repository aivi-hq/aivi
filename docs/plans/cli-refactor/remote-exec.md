# 4 · Remote execution (the bolt-on)

Status: planned. Depends on: [one-cli.md](one-cli.md); lands easier after
phases 2–3. Constrained by rule: **nothing here may change local execution** —
local stays in-process, direct, optimal. This is a convenience layer.

## Requirements

- The aivi port is the **only way in**. Remote people must be able to restart
  aivi and add a person from their laptops.
- They must **not** get shell access: the host executes aivi commands, never a
  shell — argv arrays into the CLI, so "not freely roam the server" is a
  mechanical property, not policy.
- Interactive commands keep working: clack prompts, masked passwords,
  spinners, ctrl+c, resize.

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

- [ ] `/v1/exec` upgrade route: chain order, operator gate, optional
      hono-rate-limiter middleware, audit line (person **id + name**, argv,
      source address, exit code).
- [ ] Person id + token pairing: required `person.id` in the client config
      (setup writes it from `whoami`), host validates the pair on bearer
      resolution; tests for mismatch → 401.
- [ ] Server: node-pty spawn, env contract, `exit`/close semantics, kill on
      disconnect, missing-prebuild degradation.
- [ ] Client relay: raw mode, SIGWINCH, byte forwarding, exit propagation,
      restore-every-path; pipe-mode session branch.
- [ ] Announce-before-disconnect in `service restart`, `service stop`, and
      `update` (the notice is printed before the self-stop; no mechanism
      beyond that sentence). No top-level `restart` command: restart is
      `aivi service restart`, relayed like the rest of `service`.
- [ ] `AIVI_OPERATOR_BEARER` env + scrub list update in configuration docs.
- [ ] Docs: [operations.md](../../operations.md) (transport table for
      commands), [people.md](../../people.md) (exec gate),
      [CONTEXT.md](../../../CONTEXT.md) (vocabulary: relay, exec channel).
- [ ] Changesets (fixed group).

# 5 · Visibility: what help shows, what runs where

Status: planned. Starts with [one-cli.md](one-cli.md) (the `fresh`/`local`
states exist as soon as one CLI answers help), completes with
[remote-exec.md](remote-exec.md).
Goal: discoverability without a metadata matrix — two facts about the
machine, two small command sets, and driving another machine is a typed
flag, not an inferred state. Decided 2026-09-28 (the explicit-flag and
streaming shape, D11 amended and D17 below).

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

## What `--remote` does (decision D17)

- Reads the client config's `url` and person token, opens the
  [exec channel](remote-exec.md), and relays argv verbatim; the server's
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

## Checklist

- [ ] State resolution once per run (client config → `fresh`/`local`); no
      third state anywhere.
- [ ] `--remote`/`-r` parsing: config `url` + token → exec channel; honest
      `no server configured` / `host unreachable` answers; plain path
      never touches the network.
- [ ] Decision-A answers: a home-needing command in `fresh` prints
      `no home on this machine — … or drive the server: aivi -r …`;
      the `fresh` help allow-list.
- [ ] `client-side` guard messages against `--remote`; `refuse-relay`
      refusals; `serve`'s `server already running` answer.
- [ ] `--remote --help`: server renders the remote operator's view
      (`helpVisibility` at render time, refuse-relay hidden) with the
      `(remote)` banner in both brand modules (`#7C3AED` vs `#F59E0B`
      weighed here).
- [ ] Tests: help output per state (fixture configs); `--remote setup`
      gives the guard, hidden commands invoked anyway give guard messages,
      never `unknown command`; the remote render shows and hides the
      right sets.
- [ ] Docs: [operations.md](../../operations.md) (transport/visibility
      table), `packages/cli/README.md` (one command table with state and
      flag notes).
- [ ] Changesets (fixed group).

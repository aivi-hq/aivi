# 5 · Visibility: what help shows, what runs where

Status: planned. Starts with [one-cli.md](one-cli.md) (the `fresh`/`local`
states exist as soon as one CLI answers help), completes with
[remote-exec.md](remote-exec.md).
Goal: discoverability without a metadata matrix — the state is one
per-process fact, commands carry at most one tag, and hiding is commander's
own machinery.

## Three process states (decision D11)

Decided once per run from `~/.config/aivi.json` — never per command, never by
probing the network at help time (help stays instant and offline):

| State | Decided by | Help shows | Commands run |
| --- | --- | --- | --- |
| `fresh` | no client config, no home here | `setup`, `version`, `upgrade` — that is it | locally |
| `local` | home on this machine | everything (host down is fine: store-direct commands work) | in-process |
| `remote` | config `url`, home elsewhere | client + relayable commands; machine commands hidden | relay |

`serve` in `local` while a host already answers: the command itself prints
`server already running` and exits — stated behavior, not a help-time probe.

## The sets

- **client-side** — act on the machine you type on, never relayed, never
  mounted from the home: `setup`, `upgrade`, and the planned `configure`.
  (`upgrade` npm-updates the global CLI itself; `install`/`update` are *not*
  here — they act on the server machine and therefore relay.)
- **refuse-relay** — server-side but rejected over the channel: `serve` (the
  server is the thing being driven) and `uninstall` (decision D14: deletes
  the home and kills the relay's own parent).

Everything else — `status`, `jobs`, `runs`, `projects`, `people`,
`knowledge`, `link`, channel subtrees, `install`, `update`, `service`
(including its `restart`) — is untagged: available in every state,
in-process locally, relayed remotely. `link` gets **no special treatment**:
it is an ordinary untagged command whose implementation happens to speak HTTP;
remotely it is relayed like any other, with the operator's bearer in its env.

The "server running" axis needs no per-command flag: in `remote` the
connection itself is the precondition, and one honest error covers all
commands — `host unreachable at <url>; commands that work offline work
offline on the server machine`.

## The mechanism: commander, not custom code

`commander` already hides registered commands from help with
`helpVisibility('none')` while keeping them invocable. At startup the CLI
walks the mounted tree once and sets visibility from the state. A hidden
command invoked anyway answers with its guard message (`this runs on the
server's machine`), never `unknown command`. Three states × two small sets +
the fresh-mode allow-list — that is the entire implementation (~30 lines).

## The `configure` command (later, client-side)

Edits the client config itself: the host `url` (and the `home`/`appDir`
paths). It **never forgets the person** — the token is audit evidence, and
audit history is not something a laptop command erases. The most a person can
become is *disabled*, which is a server-side people decision owned by
[people.md](../../people.md), not a feature of `configure`. Client-side by
nature, so it joins the `fresh`/`remote` allow-list the day it exists.

## Checklist

- [ ] State resolution once per run (client config → `fresh`/`local`/`remote`).
- [ ] `client-side` + `refuse-relay` sets; `helpVisibility` pass at startup;
      guard messages; `serve`'s `server already running` answer.
- [ ] Tests: help output per state (fixture configs); invocation of a hidden
      command produces the guard, not `unknown command`.
- [ ] Docs: [operations.md](../../operations.md) (transport/visibility table),
      `packages/cli/README.md` (one command table with state notes).

# @aivi/cli

The aivi CLI. One `setup` signs a machine in or creates the server;
`service` runs it in the background; `update`/`upgrade` keep it current;
`uninstall` removes everything. It never imports host code statically —
every operator command is mounted in-process from the installed server
(`@aivi/host/cli`) onto the same command tree.

## Install

```sh
npm i -g @aivi/cli
```

## Commands

| Command | What it does |
| --- | --- |
| `aivi setup` | Sign in to an existing host or create the server here |
| `aivi configure` | Edit this machine's client record: host url, home, app dir. Listed only where a record exists; the signed-in person stays |
| `aivi link [PLATFORM]` | Mint a one-time code that links a channel account to your person |
| `aivi add browser\|discord\|slack\|SPEC` | Add a plugin to the server home |
| `aivi serve` | Start the server in the foreground |
| `aivi update` | Update the installed server and plugins |
| `aivi upgrade` | Update this CLI through its install method |
| `aivi uninstall` | Delete the aivi home, client config, and this CLI |
| `aivi service install\|uninstall\|start\|stop\|restart\|status\|logs` | Manage the background service |
| `aivi jobs\|runs\|people\|projects\|sources\|knowledge\|status\|config\|discord\|slack\|linear …` | Mounted in-process from the installed server (`@aivi/host/cli`) |
| `aivi --remote\|-r COMMAND` | Type the command on the machine the host runs on; the answer's banner says `(remote)` |

What `aivi --help` lists is what this machine can do. The header line names
the machine (`home: ~/.aivi`, or `home: none` before any setup), and a
machine without a home lists only `setup`, `upgrade` and `uninstall` — the
way in and the way out. Over `--remote`, commands that would act on the
machine you type on refuse with that answer; the rest run on the server's
home. [Running remotely](../../docs/operations.md#running-remotely) has the
whole table.

## Home

`~/.aivi` (or `AIVI_HOME`). Holds `config.json`, `.env`, `app/` (the
installed server), and `state/`. The client config at
`~/.config/aivi/config.json` records the home and the app directory.

## Docs

[getting started](../../docs/getting-started.md) ·
[operations](../../docs/operations.md)

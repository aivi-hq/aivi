# @aivi/cli

The thin aivi CLI. One `setup` signs a machine in or creates the server;
`service` runs it in the background; `update`/`upgrade` keep it current;
`uninstall` removes everything. It never imports host code — it forwards
every operator command into the installed app.

## Install

```sh
npm i -g @aivi/cli
```

## Commands

| Command | What it does |
| --- | --- |
| `aivi setup` | Sign in to an existing host or create the server here |
| `aivi link [PLATFORM]` | Mint a one-time code that links a channel account to your person |
| `aivi install discord\|slack\|SPEC` | Add a plugin to the server home |
| `aivi serve` | Start the server in the foreground |
| `aivi update` | Update the installed server and plugins |
| `aivi upgrade` | Update this CLI through its install method |
| `aivi uninstall` | Delete the aivi home, client config, and this CLI |
| `aivi service install\|uninstall\|start\|stop\|restart\|status\|logs` | Manage the background service |
| `aivi jobs\|runs\|people\|projects\|sources\|knowledge\|status\|config\|discord\|slack\|linear …` | Forwarded to the installed app |

## Home

`~/.aivi` (or `AIVI_HOME`). Holds `config.json`, `.env`, `app/` (the
installed server), and `state/`. The client config at
`~/.config/aivi.json` records the home and the app directory.

## Docs

[getting started](../../docs/getting-started.md) ·
[operations](../../docs/operations.md)

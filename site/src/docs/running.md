---
title: Running aivi
description: Keep the server healthy, read its logs, update it, and back up the home.
order: 13
group: Operate
---

aivi is one long-running server. Most days it needs nothing more than a working service and a glance at the run history. This page covers the commands that keep it that way.

## Foreground or service

`aivi serve` runs the host in the foreground. Use it while setting things up, or when you want the log in front of you.

`aivi service install` writes a per-user service and starts it. On macOS it is a LaunchAgent with `KeepAlive`. On Linux it is a systemd user unit. The service runs the server's boot file directly, so it behaves the same as the foreground command.

```sh
aivi service install
aivi service status
aivi service restart
aivi service stop
aivi service logs
```

A headless Linux machine needs lingering enabled, or the user service stops when the session ends:

```sh
loginctl enable-linger "$USER"
```

Setup offers the service near the end. Taking it means the server comes back after a reboot and `aivi serve` becomes a debugging command.

## Status and health

```sh
aivi status
aivi config check
aivi jobs list
aivi runs list
```

`status` reports the host, the API, the knowledge index and each module. A module can be `starting`, `running`, `degraded` or `stopped`. A degraded module keeps retrying in the background with backoff, and the rest of the server stays up. Its last error and next retry are in the status output.

`config check` validates the live config without starting anything. It catches missing project directories, unknown pools, bad cron expressions and plugin blocks that belong to no listed plugin. A configuration error in a module is fatal for that module, not for the host.

If the host itself will not start, check the paths first:

```sh
ls ~/.aivi
aivi service logs
```

The home must contain a `config.json`. aivi never deletes a home without one, which protects against a wrong `AIVI_HOME`.

## Logs

Every command mirrors its log to stderr. On a terminal it is formatted for reading. When piped, it is one JSON object per line.

`aivi serve` also appends JSON lines to `~/.aivi/state/logs/aivi.log`. The file is rotated, so it does not grow without bound.

```sh
aivi service logs
aivi serve --log-level debug
```

The log category shows where a line came from, such as `aivi.host`, `aivi.host.discord` or `aivi.knowledge`. The request diary is separate from the log. It records every request that reaches the host, including refused bearers and webhook calls, with credential headers marked `[present]` rather than stored.

```sh
aivi host clear-logs --older-than 30d
```

## Updates

```sh
aivi update
aivi upgrade
```

`aivi update` brings the installed server and plugins to the newest compatible releases. It checks the Node requirement, installs while the server keeps answering, restarts it, and probes health before it calls the update done. A plugin that cannot work with the new host stays on its current version and is logged as disabled.

`aivi upgrade` updates the CLI itself. The CLI, host and plugin kit share one version group, so the CLI's version is also the API version it speaks.

There is no rollback command. Sessions survive because their state is in SQLite and OpenCode's own storage. If an update goes wrong, the log and the installed versions in `~/.aivi/app/package.json` are the first things to read.

## Backups

The home is the unit to back up. It holds the config, the database, the memory, the projects and the OpenCode agents.

A cold copy is simplest:

```sh
aivi service stop
cp -R ~/.aivi ~/backups/aivi-$(date +%F)
aivi service start
```

The client config on a workstation is separate. It lives at `~/.config/aivi/config.json` and holds the host URL, the person's token and a cached identity. Back it up if losing the workstation would mean minting a new token.

The search index and the editor schema are disposable. They can be rebuilt. The database, `config.json`, `.env`, `memory/` and the projects are the parts worth keeping.

## Secrets and access

Channel tokens and other host secrets live in `~/.aivi/.env` with mode 0600. They are not written into conversation content, and shell tasks do not inherit them unless a task sets one in its own `env` map.

The API answers on loopback by default. Changing `host.bind` to a LAN, tailnet or public address lets other machines reach it. Anyone who can reach the address can use the open commands, so put it behind a trusted network or a proxy. Set `host.public` to the address people should use in printed links.

A bearer token identifies a person. It does not grant access by itself, with one exception: people management and the remote exec channel require the `operator` role. Keep the operator token on the server or in the client config, not in a chat message.

## Running commands remotely

From a signed-in workstation:

```sh
aivi -r status
aivi -r jobs list
aivi -r runs show RUN_ID
```

`-r` opens the host's exec channel and runs the same CLI on the server. The command surface is not remapped, so help and flags are the server's own. Setup, configure, upgrade, serve, uninstall and a second `-r` are refused from a driven session because they act on the machine you type on.

The exec channel requires an operator bearer. Every arrival, accepted or refused, writes one diary line with the person, the argv, the address and the exit code.

## A short recovery checklist

1. Run `aivi status` and read which module is unhealthy.
2. Run `aivi config check` if the problem started after an edit.
3. Follow `aivi service logs` around the time of the failure.
4. Check `aivi runs list --state blocked` before resolving anything. A blocked run is waiting for proof, not for a queue nudge.
5. If the server will not start at all, verify the home path and that `config.json` is present and valid JSON.
6. If a channel module is degraded, verify the platform tokens and that the bot still has access to the channels it is configured to use.

The repository's [operations guide](https://github.com/aivi-hq/aivi/blob/main/docs/operations.md) has the full startup, shutdown and dispatch behavior. The [configuration reference](https://github.com/aivi-hq/aivi/blob/main/packages/host/docs/configuration.md) lists every field.

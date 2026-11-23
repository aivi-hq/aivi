---
title: Plugins
description: Everything is a plugin, and nothing runs until you add it.
order: 6
group: Plugins
---

The core is small. Channels, trackers, forges, the browser and voice are plugins. A fresh install is the host, the scheduler, search and the assistant. Nothing else loads until it is in the home's `aivi-plugins` list.

## Add and remove

```sh
aivi add discord
aivi add @aivi/tracker-github
aivi remove browser
```

`aivi add` installs the npm package, runs the plugin's own setup, writes its `plugins.<module>` block and secrets, adds the package to `aivi-plugins`, rebuilds the editor schema, and restarts the service. A setup that stops leaves the package installed but inert, because the list entry is what enables the module.

These short names are aliases:

| Short name | Package |
| --- | --- |
| `discord` | `@aivi/channel-discord` |
| `slack` | `@aivi/channel-slack` |
| `linear` | `@aivi/tracker-linear` |
| `browser` | `@aivi/browser` |

Everything else is added by package name, such as `@aivi/forge-github`, `@aivi/tracker-github`, `@aivi/voice` or `@aivi/google-meet`. The full package name always works too.

## Roles, not brands

A channel connects a chat platform. A tracker owns tickets and lanes. A forge owns repositories, branches and pull requests. Core asks for the role, and a plugin fills it. Linear and GitHub ship today. Another tracker or forge can arrive as a package without changing core.

A plugin can also claim tools, a project setup step, CLI commands and scheduled operations. That is why a plugin can add a capability, not only a connection.

## Built-in plugins

| Plugin | What it adds |
| --- | --- |
| [Discord](plugin-discord.html) | Channels, DMs, threads, search and reports |
| [Slack](plugin-slack.html) | Socket Mode channels, DMs, threads and slash commands |
| [Linear](plugin-linear.html) | Tickets, lanes, delegation and agent sessions |
| [GitHub](plugin-github.html) | A forge for clones and pull requests, and a Projects board tracker |
| [Browser](plugin-browser.html) | A persistent Chrome profile with session-owned tabs |
| [Voice and Meet](plugin-voice-meet.html) | Speech in calls, and aivi in a Google Meet |

## The rule

The config block describes a plugin. The `aivi-plugins` list enables it. A block without a list entry does nothing, and a list entry without a block takes the plugin's defaults or says what it needs. `aivi status` shows what is loaded and what failed.

To write a plugin, start with the [plugin kit](https://github.com/aivi-hq/aivi/blob/main/packages/plugin/README.md).

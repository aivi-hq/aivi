---
title: Getting started
description: Install aivi, create a server, and check that it answers.
order: 1
group: Start here
---

This guide takes a fresh machine to aivi answering questions and accepting work. You need about ten minutes, a terminal, and a machine that can stay on while people use it.

## What you need

- Node 26.12 or newer, below version 27, and npm.
- A macOS or Linux machine. A small Mac mini, a spare desktop or a Linux server all work.
- OpenCode v2 if you want to use the seeded agents in the editor. aivi can install the server without it, and setup will print the plugin commands to run later.

The machine should stay awake. aivi runs jobs on its own schedule, and a sleeping laptop misses them.

## Install the CLI and create the server

```sh
npm i -g @aivi/cli
aivi setup
```

Setup is a short conversation. It asks whether this machine creates a new server or connects to one that already exists. For a new server it also asks for a name, whether this machine signs in as the operator, and whether the server should run in the background.

Take the background service when the machine is meant to stay on. Setup installs it, waits for the server to answer, and ends with a verified line:

```text
Signed in as Ada. The server runs in the background; `aivi service logs` follows it.
```

If you choose the foreground instead, the same setup ends by telling you to run `aivi serve` in a terminal. Keep that terminal open while you use aivi.

A headless server prints a URL and a token at the end. Take both to the machine where you use OpenCode and run `aivi setup` there, choosing the option to connect to an existing host.

## Check that it runs

```sh
aivi status
aivi whoami
aivi jobs list
```

`status` reports the host, its modules and the knowledge index. `whoami` shows the person this terminal signs in as. `jobs list` shows the schedules aivi owns, including the maintenance jobs it seeds for itself.

If the server is in the background and something looks wrong, follow the log:

```sh
aivi service logs
```

## Use it in OpenCode

`aivi setup` installs the aivi OpenCode plugin and writes the client config at `~/.config/aivi/config.json`. The plugin finds the host from that config, whether the host runs on this machine or on another one. If OpenCode is not on `PATH` during setup, the command prints the `opencode plugin add` lines to run later.

Use OpenCode normally in your project. The aivi tools are registered for the location that loads the plugin. The host's seeded agents live in `~/.aivi/.opencode/agents/`; they are the ones aivi runs for channels, jobs and tickets. To use one in native OpenCode, copy it to `~/.config/opencode/agents/` or a project's `.opencode/agents/`, or write your own agent and let it use the aivi tools.

Ask the assistant to list the projects and search the configured documents. With no project yet, it can still answer from the core knowledge sources.

## Add a project

A project is a directory under `~/.aivi/projects/`. It can hold a git checkout, its own memory, and the worktrees aivi uses for ticket work.

```sh
aivi projects add
```

The command is interactive. It asks the configured forge to clone a repository and the configured tracker to map a board. With neither configured, it creates a repo-less project: a directory with memory and knowledge but no source checkout. That shape is useful for research work and for documents that do not live in a repository.

Restart the server after adding or removing a project, because the host reads the projects directory at startup.

```sh
aivi service restart
```

## Add a chat channel

Discord and Slack are the two built-in chat channels. The plugin asks its own platform questions, verifies the tokens, and writes the config for you.

```sh
aivi add discord
```

`discord` is the short name for `@aivi/channel-discord`. The full package name works too. For Slack, use `aivi add slack` or `@aivi/channel-slack`.

The command prints how to create the Discord application and asks for the bot token and the channel IDs. When it finishes, the module is running. For Slack, run `aivi add slack` instead and use the manifest the CLI prints.

People need a link before aivi will listen to them. Mint a code for yourself:

```sh
aivi link discord
```

Then send `/link <code>` to the bot on Discord. The code expires after 15 minutes and works once. The link is also the admission: linked people can DM aivi and are heard in the channels where it listens.

## First useful things to ask

- "What did we decide about the database upgrade?"
- "Summarize the open work on the website project."
- "Every Monday at 09:00, post a summary of last week's merged pull requests."
- "Search the docs for the retry policy and show me the source."

The assistant can create jobs, search knowledge and read project documents. Ticket work is separate, and it needs a tracker and a project with lanes.

## Where to go next

- [Ways to use aivi](ways.html) explains the three roles and how they combine.
- [Projects and tickets](projects.html) covers lanes, worktrees and delegation.
- [Chat and knowledge](chat-knowledge.html) covers channel commands and the search index.
- [Jobs and memory](jobs-memory.html) covers schedules and the nightly dreaming pass.
- [Running aivi](running.html) covers the service, logs, updates and recovery.

The full reference lives in the repository. The [operations guide](https://github.com/aivi-hq/aivi/blob/main/docs/operations.md) is the place to look when a run ends in `blocked` or a module stays `degraded`.

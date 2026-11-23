---
title: First five minutes
description: Install aivi, ask it something, and hand over the first piece of work.
order: 0
group: Start here
---

This is the short path. The full install, configuration and recovery details are in [Getting started](getting-started.html) and [Running aivi](running.html).

## Put it on a machine that stays on

```sh
npm i -g @aivi/cli
aivi setup
```

Setup asks whether this machine creates a server or connects to one. Take the background service when the machine stays on. Setup ends with a verified sign-in, not a promise.

## Ask it something only your team knows

With the aivi OpenCode plugin installed, use OpenCode normally in your project. The plugin finds the host from `~/.config/aivi/config.json`, whether the host runs here or elsewhere. Then try one of these:

- "What did we decide about the database upgrade?"
- "Find the retry policy and show me where it is written."
- "Summarize the open work on the website project."

The answer carries the file and the date. When aivi cannot find a source, it says that instead of guessing.

You can also ask in Discord or Slack after `aivi add discord` or `aivi add slack`. Those short names install `@aivi/channel-discord` and `@aivi/channel-slack`; the full package names work too.

## Give it a job

Ask in ordinary language:

> Every Monday at 09:00, post a summary of last week's merged pull requests.

It creates the job, repeats the next occurrence, and posts the result where you asked. You do not need to write a cron expression or a config file.

## Hand it a ticket

With a tracker and a project configured:

```sh
aivi projects add
```

Move a ticket into a lane that names an agent. aivi picks it up, works in its own checkout, and posts progress in the ticket. If it needs a decision, it asks and waits. A person can stop it at any time.

## Five things to show a colleague

1. Ask for a decision and open the source it cites.
2. Ask for a reminder in two hours.
3. Move a ticket and watch the run appear.
4. Invite aivi to a Meet (with the voice and Meet modules) and ask what was decided afterwards.
5. Ask what changed in a project last month.

## Where the details are

- [Getting started](getting-started.html) for the full install and the first project.
- [Ways to use aivi](ways.html) for the three roles and how they combine.
- [Projects and tickets](projects.html) for lanes, worktrees and stops.
- [Chat and knowledge](chat-knowledge.html) for commands and search.
- [Jobs and memory](jobs-memory.html) for schedules and dreaming.
- [Running aivi](running.html) for the service, logs and updates.

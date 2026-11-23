---
title: Ways to use aivi
description: One server can be a team's shared memory, a private assistant, and a colleague who owns work.
order: 2
group: Start here
---

aivi is one server with one memory, but people meet it in different roles. A small team may use all three at once. A single person may only need the second. The roles share the same knowledge index, the same scheduler and the same model capacity, so adding one does not create a second installation to maintain.

## With a team {#team}

The team role is mostly about access to context. People ask questions in the chat they already use, and aivi answers from the documents, decisions, memories and past conversations that it indexed.

A useful exchange looks like this:

> **Maya:** Why did we drop the Redis cache from billing?
>
> **aivi:** It was removed on 14 October because the invalidation bugs cost more than the cache saved. The decision is in `decisions/billing.md`. The queue is Postgres-backed now.

The answer carries its source, so the next person can check it. When the source is a conversation rather than a document, aivi says that too.

### What to configure

1. **Core knowledge.** Point `knowledge` at the team's handbook, decisions and notes. The `projectDefaults.knowledge` setting describes what a repository's `docs/` holds, so every project gets the same convention without a per-project list.
2. **A chat channel.** Run `aivi add discord` or `aivi add slack`, then link the people who should be heard. Unlinked accounts are ignored, which keeps a busy server from answering strangers.
3. **A tracker and a forge, if you want ticket work.** The tracker owns the board. The forge owns the repository and the pull requests. Without them, the chat and knowledge roles still work.

### What it feels like

A linked person can DM the bot or open a thread. Each conversation keeps its own OpenCode session, so two threads do not share a transcript. A message that arrives while a turn is running interjects by default, and `/queue` puts the message behind the current turn instead.

The assistant reads project knowledge but does not edit a checkout from a chat conversation. That separation is deliberate: chat answers questions, while workers do ticket work.

## As a personal assistant {#personal}

The personal role is the same server with a smaller audience. It keeps your notes searchable, remembers what changed, and runs work on a schedule while you are elsewhere.

Useful habits:

- Keep a `notes/` or `docs/` directory as a core knowledge source. aivi indexes it in place.
- Ask for a daily brief at a time you actually read it. The job can post into a DM or a private channel.
- Use the browser for sites that need your existing logins. The Chrome profile is persistent, and each session gets its own tabs.
- Let dreaming run at night. It turns the day's conversations into dated facts and moves superseded notes into an archive.

### What to configure

1. **Core knowledge.** Add your notes, journals and reference documents as core sources. The memory home is registered automatically.
2. **A browser, if you need one.** Run `aivi add browser`. It asks for no platform secret because it uses a local Chrome profile.
3. **A morning or evening job.** Ask the assistant in a native OpenCode session, or add a job from a task file. [Jobs and memory](jobs-memory.html) has the shape.

A personal install does not need a tracker, a forge or a chat platform. The assistant, the scheduler and the knowledge index are enough.

## As a colleague {#colleague}

The colleague role is where aivi owns work rather than only answering questions. It needs a tracker, a project, and at least one lane that names a worker agent.

The flow is ordinary ticket work:

1. A ticket enters a lane that names an agent.
2. The orchestrator checks that the ticket is eligible and that capacity is free.
3. A worker starts in the project, with the agent the lane names.
4. The worker reports progress, asks questions when it is stuck, and ends the run.
5. The tracker records the outcome. A person reviews the result.

When the lane sets `worktree: true`, the worker gets its own git worktree on the branch the tracker names. The project's clean checkout is never the working directory. That isolation is what makes a stop cheap: the worktree and its local commits go away, while anything already pushed stays.

A stopped ticket stays where the person left it. aivi adds the human-needed marker unless the person's own move already did. Lifting the marker is what lets the work be taken again.

### What to configure

1. **A project.** Run `aivi projects add` with a forge and tracker configured, or create a repo-less project for research.
2. **Lanes.** The tracker's project section maps board states to lanes. A lane can name an agent, act as a queue, or stay human-only.
3. **Worker agents.** The host's seeded `product`, `dev` and `review` files are a starting point. Edit them in `~/.aivi/.opencode/agents/` or replace them with your own.
4. **Capacity.** Set `dispatcher.pools` so ticket work, chat, jobs and dreaming share a known number of model slots.

The full contract for stops, blockers, questions and recovery is in the repository's [orchestrator guide](https://github.com/aivi-hq/aivi/blob/main/docs/orchestrator.md).

## Using more than one role

The roles combine in a few common patterns:

| Pattern | How it works |
| --- | --- |
| Team chat and ticket work | Discord or Slack for questions, Linear or GitHub for work. The same assistant answers in chat, and workers do the tickets. |
| Personal assistant with a project | You ask in native OpenCode, and the project supplies a checkout and its own memory. No chat platform is needed. |
| A team of one | One person, one project, one private channel. The team and personal roles collapse into the same setup. |

The important boundary is that chat conversations read project knowledge while workers act inside a project. That keeps a question from turning into an unplanned edit.

## Choose a starting point

- **For yourself:** finish [Getting started](getting-started.html), then read [Jobs and memory](jobs-memory.html).
- **For a team:** finish [Getting started](getting-started.html), then read [Chat and knowledge](chat-knowledge.html) and [Projects and tickets](projects.html).
- **For ticket work:** read [Projects and tickets](projects.html) first, because the lane and worktree decisions shape everything else.

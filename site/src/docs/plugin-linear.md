---
title: Linear
description: Let aivi work Linear tickets through lanes and agent sessions.
order: 9
group: Plugins
---

`@aivi/tracker-linear` makes Linear the tracker. It receives webhooks, maps teams and board states to lanes, delegates work to OpenCode agents, and reports through Linear's agent sessions.

```sh
aivi add linear
```

The short name installs `@aivi/tracker-linear`. aivi must already be running, and `host.public` must be an HTTPS address Linear can reach. The installer creates and installs the app, proves the webhook with a throwaway ticket, and writes the secrets.

## Setup

1. Open Linear's application settings and create an app.
2. Register the callback URL and the webhook URL the installer prints. The webhook path ends in `/linear/webhooks/app/<app id>`.
3. Subscribe to Issues and Agent session events.
4. Install the app into the workspace.
5. Run `aivi add linear` and open the install link when it asks.

The credentials are `LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET` and `LINEAR_WEBHOOK_SECRET`. The app's own grant is the webhook's authentication.

## A project

```sh
aivi projects add
```

The project setup asks which Linear teams work the repository, then asks every board state what kind of lane it is:

| Answer | Meaning |
| --- | --- |
| Agent | Aivi may delegate tickets here to a worker. |
| Human | Aivi ignores tickets here. A person moves them. |
| None | The state is not part of aivi's workflow. |

An Agent answer asks which agent works the lane and whether it works in its own checkout. The lanes are written in board order to the project's core `lanes` array. One queue lane can hold work while the working lanes are full.

```json
{
  "projects": {
    "shop": {
      "tracker-linear": { "teams": ["team-id"] },
      "lanes": [
        { "name": "Todo", "queue": true },
        { "name": "In Progress", "agent": "dev", "worktree": true },
        { "name": "Review", "agent": "review" }
      ]
    }
  }
}
```

The human-needed label must exist in every mapped team. A ticket carrying it is never delegated, and a hand delegation is refused with an explanation.

## What a worker gets

A worker starts in the project with the lane's agent. It reports progress and outcomes in the Linear agent session, asks questions when it needs a person, and can stop when the ticket leaves its lane or a person stops it. The human assignee stays responsible.

The full platform page is [Linear](https://github.com/aivi-hq/aivi/blob/main/docs/linear.md).

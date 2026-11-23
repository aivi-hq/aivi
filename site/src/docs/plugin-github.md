---
title: GitHub
description: The GitHub forge and Projects tracker, installed as separate plugins.
order: 10
group: Plugins
---

GitHub is two plugins that share one GitHub App. Install the role you need, or both.

| Package | Role |
| --- | --- |
| `@aivi/forge-github` | Clones projects, syncs the checkout, pushes branches, opens pull requests and carries review threads |
| `@aivi/tracker-github` | Reads a GitHub Projects board, works issues, moves lanes and writes the run's status comment |

There is no `github` short name. Use the package name:

```sh
aivi add @aivi/forge-github
aivi add @aivi/tracker-github
```

## One app

Both plugins read the same app identity from `.env`:

- `GITHUB_APP_ID`
- `GITHUB_APP_PRIVATE_KEY`
- `GITHUB_WEBHOOK_SECRET`

Install the GitHub App on the account or organization that holds the repositories. aivi uses one installation, and a project's `origin` decides which repository it is. The app needs Issues and Organization projects write access.

The tracker's webhook delivers `issue_comment`, `issues` and `projects_v2_item` to `<host.public>/github/webhooks`.

## The forge

The forge knows a project from its checkout's remote. It does not need a config block, and it does not name repositories. When the remote is a GitHub repository, `projects-sync` can authenticate through the app, and a worker gets the git tools: sync, push, open a pull request, read reviews, respond and submit a review.

A project with no forge still works. It simply gets no clone, no pull request and no review tools.

## The tracker

The project names its board and the repositories that hold its issues:

```json
{
  "projects": {
    "website": {
      "tracker-github": { "board": 1, "repos": ["acme/shop"] },
      "lanes": [
        { "name": "Todo", "queue": true },
        { "name": "In Progress", "agent": "dev", "worktree": true },
        { "name": "Review", "agent": "review" }
      ]
    }
  }
}
```

`aivi projects add` creates the `needs-human` label and asks what every board Status option means, then writes the lanes. A lane that names an agent is worked. A lane that names none waits for a person. One queue lane can hold work while the workers are full.

The tracker's settings live in `plugins.tracker-github`: `agent`, `pool`, `progress`, `trust` and `humanLabel`. `trust: "members"` is the default, so only owners, members and collaborators can reach aivi through comments.

The full pages are [GitHub forge](https://github.com/aivi-hq/aivi/blob/main/packages/forge-github/docs/github.md) and [GitHub tracker](https://github.com/aivi-hq/aivi/blob/main/packages/tracker-github/docs/github-tracker.md).

# GitHub — the tracker's configuration

The `plugins.tracker-github` block is the GitHub tracker's whole setup; the
module runs when `@aivi/tracker-github` stands in the `aivi-plugins` list. The
key is the package name; the database's prefix, the conversation ids
(`github:…`), the webhook route `/github/webhooks` and the `aivi github`
command keep the platform's short name, since those say who a conversation is
on rather than which package speaks for it.

```json
{
  "plugins": {
    "tracker-github": {
      "agent": "assistant",
      "humanLabel": "needs-human",
      "resource": "local-model",
      "progress": "tools"
    }
  }
}
```

| Field | Meaning |
| --- | --- |
| `agent` | The OpenCode agent that answers people on GitHub — comment mentions no run is working: the **assistant**. A hand delegation is never its to answer: those get the fixed refusal. Default: `assistant` |
| `humanLabel` | Issues carrying this label are never worked automatically; a failed closing and a hand-delegation refusal mark with it. Unlike Linear, where it must pre-exist, `aivi projects add` **creates** it in every mapped repository |
| `resource` | Pool an assistant turn takes a slot in (must exist in `scheduler.resources`) |
| `progress` | `silent`, `status` or `tools`: what the status comment shows while a worker runs |

The project entry routes by **board and repository**. One board is one
project's whole board; a repository feeds at most one project. The workflow
is not a GitHub field: it is **core's** lane array on the project,
`projects.<id>.lanes` — left to right, the order **is** the priority, and the
names are the board's own `Status` options:

```json
{
  "projects": {
    "website": {
      "tracker-github": { "board": 1, "repos": ["acme/shop"] },
      "lanes": [
        { "name": "Todo", "queue": true },
        { "name": "In Progress", "agent": "dev", "worktree": true },
        { "name": "Review", "agent": "reviewer" }
      ]
    }
  }
}
```

A lane naming an `agent` is worked; one naming none is worked by humans; a
Status option named nowhere in the array is silence. `queue: true` marks the
workflow's **one** queue lane, with the same load rules as Linear's wizard.
**Closed Status options (GitHub's own `status: DONE`) are never written**: the
tracker recognizes them by that flag, and a run ending in the last configured
lane moves nowhere — a person closes the ticket. `aivi projects add` writes
the array for you. `board` and `repos` are never defaulted.

The board's `Status` options are the lanes, and aivi **never creates or
renames** them (D4): a lane whose option the board does not carry is said, not
guessed past. The delegate is the board's `Agent` single-select, with the
option named for the app itself (`aivi-agent`) — apps cannot be assignees on
GitHub (proven 403), so the board carries the delegation in a field aivi
created (D5). `aivi projects add` creates that field on a yes; routing reads
the field, not the view.

Credentials are never in JSON, and the app is never the tracker's own. The
forge and the tracker are **one app** (D3): its identity is the bare
`GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` in `<home>/.env`, shared with
`@aivi/forge-github` through `@aivi/github` — installing either asks once. The
webhook's HMAC secret is `GITHUB_WEBHOOK_SECRET`, beside them. The app's
webhook must deliver `issue_comment`, `issues` and `projects_v2_item` to
`<host.public>/github/webhooks`; `aivi add @aivi/tracker-github` proves all
of it — grant, events, URL, and the secret against live deliveries — before
it writes a byte. Restart `aivi serve` to load the tracker.

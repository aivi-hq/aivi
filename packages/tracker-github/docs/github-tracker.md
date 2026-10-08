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
      "progress": "tools",
      "trust": "members"
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
| `trust` | Who comments may reach aivi — form answers, run steering, the assistant. `members`: GitHub's own `author_association` of OWNER, MEMBER or COLLABORATOR only; `everyone`: any GitHub user. A read per delivery, so a promotion or a removal lands at once. Default: `members` |

On a public repository anyone may comment. The trust line sits on the
comment event alone — one gate for all three paths — and a comment below it
is heard as nothing: no reply (silence does not advertise the bot), no log
line (drive-by comments are a public repository's weather). The other two
events need no gate: a lane or label move needs write access GitHub itself
enforces.

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
**GitHub says nothing about what a Status option means** — options carry no
state flag, and a board workflow's rule is not in the API (probed live
2026-10-08). So the wizard asks what every option is, in board order:
**Agent** (aivi delegates tickets there to an agent), **Human** (aivi ignores
tickets there; it is only ever used as a queue or a destination), or **None**
(the option is not part of aivi's workflow: never read, never moved into).
A ticket's open or closed state is the board's workflows' business; aivi
never works a closed ticket and ignores everything else about it.
`aivi projects add` writes the array for you. `board` and `repos` are never
defaulted.

The board's `Status` options are the lanes, and aivi **never creates or
renames** them (D4): a lane whose option the board does not carry is said, not
guessed past. The delegate is the board's `Agent` single-select, with the
option named for the app itself (`aivi-agent`) — apps cannot be assignees on
GitHub (proven 403), so the board carries the delegation in a field aivi
created (D5). `aivi projects add` creates that field on a yes and appends it
to every view's visible fields — the view configuration **replaces**, so each
view is read first and written back whole; running the wizard twice writes
nothing the second time. Routing reads the field, not the view; the view is
so operators can see the delegation.

Credentials are never in JSON, and the app is never the tracker's own. The
forge and the tracker are **one app** (D3): its identity is the bare
`GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` in `<home>/.env`, shared with
`@aivi/forge-github` through `@aivi/github` — installing either asks once. The
webhook's HMAC secret is `GITHUB_WEBHOOK_SECRET`, beside them — the installer
asks for it only when the home does not already hold one, and the wait proves
whichever it has. The app's
webhook must deliver `issue_comment`, `issues` and `projects_v2_item` to
`<host.public>/github/webhooks`.

`aivi add @aivi/tracker-github` proves the grant before it writes a byte:
the app's own JWT reads the permissions (Issues and Organization projects,
both write), the subscribed events, and where the webhook points. Then one
wait proves the secret against a live delivery: the installer re-asks GitHub
for its own newest `installation` delivery and watches the replay land at
this aivi's route with a seal that verifies; with no such delivery in the
history, the person installs or approves the app while the wait runs. This
installer **writes nothing at GitHub**. A live aivi is asked as a choice,
never presumed: no health answer offers "I started the server. Retry" or
"Continue anyway", and continuing writes the configuration with UNVERIFIED —
the unproved fact is precisely "GitHub can reach this machine" — in the
summary. The board itself is probed by `aivi projects add`, where the board
id is in hand: a test card pays the tracker's every mutation — Status moves
to the next option in board order the card is not on — and the diary must
echo each delivery back seal-verified. The eyes reaction is paid and read
back, not waited for: GitHub posts reaction events only to subscribers, and
aivi is not one. Then the card is cleared, archived, its reaction and comment
deleted, and closed not-planned — unless a workflow on the board closed the
card first, in which case aivi says how GitHub left it. GitHub has no API to
delete an issue. Restart `aivi serve` to load the tracker.

# Linear — the tracker's configuration

The `plugins.tracker-linear` block is the Linear module's whole setup; the
module runs when `@aivi/tracker-linear` stands in the `aivi-plugins` list.
The key is the package name; the database's prefix, the webhook URL Linear's
dashboard holds and the `aivi linear` command keep the platform's short
name, since those say who a conversation is on rather than which package
speaks for it.

```json
{
  "plugins": {
    "tracker-linear": {
      "agent": "aivi",
      "primary": "aivi",
      "apps": { "aivi": {}, "reviewer": {} },
      "logMisroutes": true,
      "humanLabel": "needs-human",
      "resource": "local-model",
      "progress": "tools"
    }
  }
}
```

| Field | Meaning |
| --- | --- |
| `agent` | The OpenCode agent that answers people on Linear — comment mentions above all: the **assistant**. A hand delegation is never its to answer: those get the fixed refusal. Default: `assistant` |
| `primary` | The app that carries the workspace's data feed, signs the bare `LINEAR_*` secrets and authorises the Linear MCP. Default: the one app; required once several apps are configured |
| `apps.<id>` | A Linear OAuth application acting as an app user. The primary does the receiving; every other app is a **face** — a name and icon in Linear's UI with its own credentials, no routing meaning |
| `logMisroutes` | `true`: log at warn a webhook delivered to the wrong endpoint — a data change on a face's route. It is dropped either way |
| `humanLabel` | Issues with this label are never worked automatically — the only "not that one again" there is (a stop remembers nothing); a session created on one is refused with an explanation, and a failed closing or an unkillable worker marks the ticket with it |
| `resource` | Pool a worker turn takes a slot in (must exist in `scheduler.resources`) |
| `mcp` | On by default: the module serves Linear's hosted MCP on loopback (default port 4101), authorised with the app-actor token, so agents can act in Linear and writes attribute to the app; `false` disables it |
| `progress` | `silent`, `status` or `tools`: what the ephemeral activities show while a worker runs |

The project entry routes by Linear **team** (a repository may list several
teams — one checkout, several teams; a team belongs to at most one project;
Linear *projects* (epics) play no routing part). The workflow itself is not a
Linear field: it is **core's** lane array on the project,
`projects.<id>.lanes` — left to right, the order **is** the priority:

```json
{
  "projects": {
    "website": {
      "tracker-linear": { "teams": ["linear-team-id"] },
      "lanes": [
        { "name": "Todo", "queue": true },
        { "name": "In Progress", "agent": "dev", "pool": "worker", "worktree": true },
        { "name": "Review", "agent": "reviewer" },
        { "name": "Release" }
      ]
    }
  }
}
```

A lane naming an `agent` is worked; one naming none is worked by humans; a
tracker state named nowhere in the array is silence. `next` and `previous`
override where a success and a failure move the ticket — neighbours by
default, and a stop never moves. `queue: true` marks the workflow's **one**
queue lane: fresh work waiting for capacity, an extension of the worker lane
it feeds; the load says so loudly for two queue lanes, a queue lane naming
an agent, or a queue whose next lane (by order or by `next`) works nothing.
`pool` names the dispatcher pool the lane's work draws capacity from.
`worktree: true` gives the worker its own git worktree; default false works
the project checkout itself, where the agent file's own `edit` deny is the
only guard. **Closed states (Done, Canceled, Duplicate) are never written**:
the tracker recognizes them by type, and a run ending in the last configured
lane moves nowhere. `aivi projects add` writes the array for you — names,
agents, worktrees, and the one queue question. `teams` is never defaulted.
`workspaceId` is optional and only needed when the installation spans Linear
workspaces; `projectDefaults.tracker-linear.workspaceId` supplies it to every
project that omits its own. The mapped agent is resolved by OpenCode's
ordinary discovery for the session's directory; an unknown agent file is
OpenCode's own error at session start, not a config error.

Credentials are never in JSON. The **primary** app reads the bare
`LINEAR_CLIENT_ID`, `LINEAR_CLIENT_SECRET` and `LINEAR_WEBHOOK_SECRET` — the
bare names mean *the one app*. Every other app follows the convention
`LINEAR_<APP>_CLIENT_ID`, `LINEAR_<APP>_CLIENT_SECRET` and
`LINEAR_<APP>_WEBHOOK_SECRET` (`<APP>` is the app id upper-cased with `-` as
`_`, so `dev-app` reads `LINEAR_DEV_APP_CLIENT_ID`). The Linear MCP, when
enabled (`plugins.tracker-linear.mcp`), is served by the module itself on
loopback and authorised with the primary's app-actor token.

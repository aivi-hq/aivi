# Linear module: plan

Status: agreed scope 2026-09-16, nothing built. This is a working checklist,
not the behaviour document; when a step lands, tick it here and write the
behaviour into the owning page ([linear.md](../linear.md) once it exists,
[configuration.md](../configuration.md) for fields and secrets). Items marked
**verify** are facts the docs could not settle; each is a live gate before the
step that depends on it. Requirements this serves: [requirements.md](../requirements.md)
§2, §4, §5.

## Vocabulary (Linear's words, used as Linear uses them)

| Word | Meaning |
| --- | --- |
| app | One Linear OAuth application, acting as an *app user* in the workspace (Linear's UI calls these "agents"). Has its own client id, secret and webhook signing secret. Config: `linear.apps.<id>` |
| delegate | The issue field `Issue.delegate`: the app user working the issue while the human `assignee` stays responsible. "aivi delegates an issue to an app" |
| agent session | Linear's `AgentSession`: one unit of agent work on an issue, visible in the issue, with states `pending/active/awaitingInput/error/complete/stale` that Linear derives from activities |
| activity | What an app emits into an agent session: `thought`, `action`, `elicitation`, `response`, `error`; a person's messages arrive as `prompt` activities, optionally with `signal: "stop"` |
| lane | aivi's word for a team workflow state, by name (`In Progress`, `Review`). `projects.<id>.linear.lanes` maps lane → app |
| worker | The OpenCode session aivi runs for one agent session: in its own worktree under `<home>/projects/<id>/worktrees/`, with the app's mapped OpenCode agent, kept for the whole run |
| listener | The part of the module that reacts to issue changes and delegates eligible issues; on or off by configuration |
| interactive | A person opening OpenCode in the checkout and talking to the same agent file. Not aivi's concern beyond staying out of the way |

Renames from today's validation-only config: `linear.applications` → `linear.apps`.

## Decisions taken (2026-09-16)

- **An agent session is a conversation.** The module is built on the channel
  machinery (`ConversationStore`, `ChannelEngine`, progress, turn runner):
  conversation id = agent session id, turn id = the activity id (dedupes
  webhook retries), `created` = first message carrying `promptContext`,
  `prompted` = a follow-up, `stop` signal = `stopTurn`, the verified final
  answer = one `response` activity, progress = *ephemeral* `thought`/`action`
  activities (Linear replaces each with the next, like the edited
  placeholder). Three extensions to the shared machinery: a per-conversation
  binding (agent + directory + project + issue), an interruption policy for
  workers (a stop ends the turn `stopped` and releases; only an unverifiable
  stop is `blocked`; nothing is silently discarded), and the project lock.
- **Auth is `client_credentials`.** Per app: `LINEAR_<APP>_CLIENT_ID`,
  `LINEAR_<APP>_CLIENT_SECRET`, `LINEAR_<APP>_WEBHOOK_SECRET` in `.env`
  (`<APP>` = app id upper-cased, `-` → `_`). The 30-day token lives in memory
  only, is fetched at start and refetched on 401. Scopes
  `read,write,app:assignable,app:mentionable`. No redirect flow, no token in
  state.
- **Webhooks arrive on the host listener** at
  `POST /v1/linear/webhooks/<app>`, verified by HMAC (`Linear-Signature` over
  the raw body) and `webhookTimestamp` within 60 s, acknowledged within 5 s,
  processed after. Bearer auth does not apply to this route. How the URL is
  reached (tailscale funnel, cloudflared, a reverse proxy, aivi in the cloud)
  is deployment, documented, not code; the operator gives Linear
  `<public base>/v1/linear/webhooks/<app>`.
- **The 10-second acknowledgement is the module's, not the agent's.** On
  `created`, one `thought` is emitted before anything else ("Starting …" or
  "Queued behind another worker in <project>"), so a busy project never shows
  as unresponsive.
- **One worker per project, one worker per issue.** The lock is a check in
  the claim transaction over the module's own `sessions` rows (`project`,
  `issue` columns): a turn is claimable only when no other conversation of
  that project has a `running`/`replying`/`blocked` turn. The limit is one
  today; worktrees make it a number later. A second `created` for an issue
  that already has a pending worker gets an `error` activity naming it.
  Scope: Linear workers only; jobs and channels do not take the lock yet
  ([projects-and-capacity](../backlog/projects-and-capacity.md)).
- **Each worker runs in its own git worktree**, never in the project's
  `source/` checkout: `git fetch origin`, then `git worktree add
  <home>/projects/<id>/worktrees/<agent-session> -B <issue.branchName>
  origin/<default>` (the branch name is Linear's, from the workspace's
  branch-format setting; an existing branch is reused). The worker's
  directory is that worktree, so `source/` stays clean and indexable, and a
  stopped worker leaves nothing for the next one to trip over. Worktrees
  stay for inspection and are pruned by retention (`runs.prune`-style age,
  never while their turn is pending). Pushing and PRs are the agent file's
  business. Ignored files (`node_modules`, `.env`) are per worktree, as in
  plain git; a per-project `worktree: { copy, setup }` is a later escape hatch.
- **Stop means stop, like a cancelled CI job.** Linear's `stop`, the HITL
  label added mid-run, the lane leaving its mapping, the delegate removed:
  `stopTurn` + `session.interrupt`, one `error` activity saying what
  happened, where the OpenCode session and the worktree are; the turn ends
  `stopped` and the project lock is released. `blocked` (lock held until
  `aivi linear resolve`) is only for the unverifiable case: OpenCode
  unreachable during the interrupt, or a restart finding a worker whose
  session still shows work in progress. Graceful agent-first cleanup is the
  later upgrade for the cases where undo matters (a test database migration);
  the worktree is what makes "clear" safe without it
  ([requirements](../requirements.md#changes-while-work-is-active) and AGENTS.md
  are updated to this).
- **Lane automation is the listener, off by default until it has been seen
  live.** Issue `update` webhooks whose `stateId` changed: resolve project by
  `data.projectId` (and `organizationId` when `workspaceId` is configured),
  lane by state *name*, app by lane, agent by app; eligible when the issue has
  no delegate, no HITL label, and no pending worker; then
  `agentSessionCreateOnIssue` and `issueUpdate(delegateId)`. Issue events are
  subscribed on exactly one app's webhook (documented) so every change is
  seen once; a second app's copy is a harmless no-op because eligibility is
  re-read.
- **The HITL label** (default `needs-human`, configurable) blocks the
  listener and is refused even on a hand delegation (an `error` activity
  explains). It is a label, not a state, so it composes with any lane.
- **aivi does not move issues between lanes.** Completion is the `response`;
  the agent file may move the issue through its own tools, or a person does.
  Linear's "move to the first `started` state on delegation" recommendation is
  a later option.
- **Worker agent files** are ordinary OpenCode agents: defaults in
  `<home>/.opencode/agents/<name>.md`, per-project override in the
  repository's own `.opencode/agents/<name>.md` (present in every worktree;
  same name wins, native merging). Whether OpenCode discovers the home's
  `.opencode` from inside `<home>/projects/<id>/worktrees/<x>` is **verify**
  #3; if it does not, the module passes the resolved file explicitly and
  [projects.md](../projects.md) is corrected.
- **The home groups a project in one directory** (decided 2026-09-16, its
  own step before the module): `<home>/projects/<id>/source` (the clean
  checkout), `<home>/projects/<id>/memory` (was `<home>/memory/<id>`),
  `<home>/projects/<id>/worktrees/` (workers). `<home>/memory` is org memory
  only, which removes the nested-collection special case in knowledge. A
  project is discovered as a directory of `<home>/projects` with a `source/`
  or a `memory/`; one with only `memory/` is *removed*. `source/` is kept
  current by a system job `projects.sync` (`git fetch` + fast-forward of the
  default branch, then reindex), because merges on GitHub otherwise never
  reach what is indexed. No automatic migration: a bare checkout at
  `<home>/projects/<id>/.git` is a `ConfigurationError` at start that says
  which two `mv`s to run.
- **No `@linear/sdk`.** Six GraphQL operations over `fetch` keep the
  dependency footprint where the principles want it.
- **Configuration lives in `aivi.json`** (`linear` on, `projects.<id>.linear`
  lanes), not a separate module file: it is routing config validated together
  with projects, and small. Presence of `linear` enables the module.

## Configuration sketch

```json
{
  "linear": {
    "apps": { "dev": { "agent": "developer" }, "review": { "agent": "reviewer" } },
    "listener": false,
    "humanLabel": "needs-human",
    "resource": "local-model",
    "progress": "tools",
    "turnTimeoutMs": 7200000
  },
  "projects": {
    "website": {
      "linear": {
        "projectId": "…",
        "workspaceId": "…",
        "lanes": { "In Progress": "dev", "Review": "review" }
      }
    }
  }
}
```

`workspaceId` optional (single-workspace default). One OpenCode agent maps to
at most one app (existing check). Secrets: [decisions](#decisions-taken-2026-09-16).

## Checklist

### 0. Verify before building on it

- [ ] **verify 1** (setup detail, not a blocker) Whether an app authorised
      only through `client_credentials` also receives `AgentSessionEvent`
      webhooks, or whether Linear needs one browser-based (`actor=app`)
      authorisation per app to create the workspace webhook. Either way tokens
      come from client credentials; the answer decides one paragraph of setup
      in `docs/linear.md`.
- [ ] **verify 2** `agentSessionCreateOnIssue` + `issueUpdate(delegateId)` by
      the app itself: does a `created` webhook follow, or must the module
      start the worker from the mutation result? (Design assumes the latter is
      safe either way: the mutation result starts it, a later `created` for
      the same session id is a dedupe no-op.)
- [ ] **verify 3** `agent.list` with `directory: <home>/projects/<id>/worktrees/<x>`
      returns agents from `<home>/.opencode/agents/` and prefers the
      worktree's `.opencode/agents/` file of the same name. Record the result
      in [projects.md](../projects.md).
- [ ] **verify 4** The `stop` signal's payload shape (`agentActivity.signal`),
      `Issue.branchName` in the session payload or by query, and the
      delegate-removed notification (`issueUnassignedFromYou`) as they arrive
      today; the Webhooks schema explorer is the reference.

### 0b. Home layout: one directory per project

- [ ] Discovery: `<home>/projects/<id>/{source,memory,worktrees}`; a
      project with `memory/` but no `source/` is *removed*; a bare
      `projects/<id>/.git` is a `ConfigurationError` with the two `mv`s.
- [ ] Knowledge: project sources relative to `source/`; the project `memory`
      source is `projects/<id>/memory`; `<home>/memory` is org only; drop the
      nested-collection exclusion.
- [ ] Dreaming: memory homes and the prompt's list of them follow.
- [ ] CLI: `projects add` clones into `source/`; `remove` deletes `source/`
      (and `worktrees/`); `purge` deletes the directory; `list` shows what
      each has.
- [ ] System job `projects.sync` (task kind; seeded like `retention`,
      `scheduler.projectsSync`, `false` removes it): per project `git fetch`
      and fast-forward of the default branch in `source/`, never with local
      changes, then `knowledge.index`.
- [ ] Docs: [projects.md](../projects.md), [configuration.md](../configuration.md),
      [knowledge.md](../knowledge.md), [dreaming.md](../dreaming.md), CONTEXT
      vocabulary row `project`, `example/`.

### 1. Configuration and vocabulary

- [ ] `linear.applications` → `linear.apps`; add `listener`, `humanLabel`,
      `resource`, `progress`, `turnTimeoutMs`; `workspaceId` optional.
- [ ] Secret names resolved from app ids; missing secrets are a
      `ConfigurationError` at start, never a log line with a value.
- [ ] `npm run schema`; [configuration.md](../configuration.md) fields, secrets,
      `.env` order; AGENTS.md wording ("only config validation exists" →
      what is built).

### 2. Linear client

- [ ] `packages/linear/src/client.ts`: token by `client_credentials`
      (in-memory, refetch on 401, one in-flight refresh), GraphQL over `fetch`.
- [ ] Operations: `viewer { id }` (the app user id, at start), `agentActivityCreate`
      (all five types, `ephemeral`), `agentSession(id)` (issue, state,
      activities for reconstruction), `issue(id)` (state, labels, delegate,
      project), `agentSessionCreateOnIssue`, `issueUpdate` (delegate).
- [ ] Tests against a mock GraphQL server: token refresh, 401 path, error
      envelopes.

### 3. Webhook route on the host listener

- [ ] Host: modules can register a public route (`HostServices.routes`), the
      only routes outside bearer auth besides `/health`; raw body captured.
- [ ] `POST /v1/linear/webhooks/<app>`: signature (timing-safe) + timestamp
      window, 200 at once, then dispatch; unknown app → 404; bad signature → 401
      (logged without the body).
- [ ] Tests: signed fixture accepted, tampered body refused, stale timestamp
      refused, delivery id logged.

### 4. The worker loop (agent session = conversation)

- [ ] Shared machinery: per-conversation binding on `ConversationStore`
      (`bind(channel, {agent, directory, project, issue})`), interruption
      policy `block` for `recover` (a worker's effects are real; a chat
      reply's are not) and a `stopped` outcome that releases the lease for
      `stopTurn`/`shutdown`, both behind the `ChannelPlatform` so Discord and
      Slack are unchanged. Tests at the store.
- [ ] Worktree: `git fetch origin`, `git worktree add <project>/worktrees/<agent-session> -B <branchName> origin/<default>`
      at claim (reuse an existing branch); failure → `error` activity and a
      `failed` turn, lock released. `worktrees` pruning by age in `runs.prune`
      or a sibling, never while the turn is pending.
- [ ] `created`: resolve project (`issue.projectId`), lane → app → agent;
      refuse with an `error` activity when the app's webhook does not match
      the lane's app, the project is unknown, or the agent is missing from
      `agent.list` for the worktree; otherwise the acknowledging `thought`,
      then enqueue the first turn with a prompt built from `promptContext`,
      `guidance`, lane and project names and the worktree path.
- [ ] `prompted`: enqueue as a turn (turn id = activity id); with
      `signal: "stop"` → the stop path above instead.
- [ ] Delivery: `send` = `response` (split at Linear's body limit if there is
      one, **verify**); `edit` = ephemeral `thought`/`action` from the progress
      model (throttle as today); `delete` = no-op (the response supersedes);
      failure notices = `error` activities.
- [ ] Turn runner: `external_directory` allows for the home's knowledge and
      memory sources as for channels; permission prompts rejected
      (`elicitation` is later); `metadata.aivi = { origin: "linear", app,
      issue, agentSession }`; session title `<identifier> <title>`.
- [ ] CLI: `linear status`, `linear resolve ID --reason … --confirm-stopped`
      (the unverifiable case only), same shape as Discord/Slack.
- [ ] Module `start`: `ConfigurationError` for missing secrets or a rejected
      token; everything else degraded with retry. `stop`: interrupt running
      workers, one `error` activity each ("aivi is going offline; the
      worktree is at …"), turns end `stopped`, locks released.
- [ ] Dreaming `origins` may include `linear`.

### 5. Locks

- [ ] Project lock and one-worker-per-issue in the claim transaction; a
      queued worker's acknowledging `thought` says it is waiting and for what.
- [ ] Tests: two sessions in one project serialize; a stopped worker
      releases the lock and the next claims; a blocked (unverifiable) worker
      keeps it until `resolve`.

### 6. HITL label and the listener

- [ ] HITL: label by name on `created` (refuse) and on issue `update`
      (`labelIds` gained the label while a worker is pending → stop path).
- [ ] Listener (`linear.listener: true`): issue `update` with `stateId`
      changed → eligibility → `agentSessionCreateOnIssue` + `issueUpdate`
      (delegate); lane left the mapping or the delegate removed while a
      worker is pending → stop path. Repeated deliveries are idempotent
      through the pending-worker check.
- [ ] Tests at the eligibility function (pure) and the store.

### 7. Documentation and live gate

- [ ] `docs/linear.md` (owner: behaviour, setup of an app in Linear with the
      exact webhook categories and scopes, the tunnel note, recovery); rows in
      CONTEXT.md, [roadmap.md](../roadmap.md) milestone 7, `docs/channels.md`
      for the machinery extensions, `docs/projects.md` for verify 3;
      AGENTS.md and [requirements.md](../requirements.md) §4-5 note the
      2026-09-16 decision (stop releases; blocked only when unverifiable;
      graceful cleanup deferred).
- [ ] Live gate: delegate an issue by hand → acknowledging thought → progress
      activities → response; a follow-up prompt; a stop request → error
      activity, `stopped` turn, lock released, worktree present; two issues
      in one project serialize; the listener delegating on a lane change; the
      HITL label refusing; `projects.sync` fast-forwarding `source/` after a
      merge. Record in roadmap.
- [ ] Shrink this file to what is left.

## Later, deliberately

- Graceful agent-first cleanup with deadlines
  ([requirements §4](../requirements.md#changes-while-work-is-active),
  [shutdown-hooks](../backlog/shutdown-hooks.md)) for effects a worktree does
  not contain (a test database migration); needs a way for the agent to
  report "cleanup complete" (a plugin tool) and a per-project definition of
  clean.
- More than one worker per project (the lock becomes a limit; worktrees
  already isolate them).
- Per-project `worktree: { copy: [".env"], setup: ["npm ci"] }` for what a
  fresh worktree cannot regenerate.
- Permission prompts as `elicitation` (with `select`), answered through
  `prompted`.
- Agent plans (`agentSession.plan`) from the progress model's tool list;
  `externalUrls` once there is something to link to.
- Moving the issue to the first `started` state on delegation; moving on
  completion by configuration.
- The project lock shared with jobs and interactive sessions
  ([projects-and-capacity](../backlog/projects-and-capacity.md)).
- Reading Linear's Inbox notification category for unassignment if verify 4
  shows it is the only signal.

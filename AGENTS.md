# Working on aivi

Read `CONTEXT.md` at the start of a session: it says what exists, what was
decided and why, and which document owns which fact. Read the owning doc before
changing runtime behavior.

- Use native OpenCode agents, sessions, permissions, tools, and providers.
- Keep installation state in the host, not in each native plugin instance.
- Add integrations as optional adapters; avoid a general plugin framework.
- Keep source documents authoritative and search indexes rebuildable.
- Preserve project scope; unknown IDs must not broaden a query.
- Do not equate prompt acceptance or session idleness with job completion.
  A failure before the prompt is accepted is `failed`; after it, `blocked`.
- Every state change a person waits on gets a visible signal; never silence.
- Keep credentials in fnox/environment, never configuration examples or logs.
- Agents are ordinary OpenCode agents in `<home>/.opencode/agents/`; their
  file is the whole boundary. aivi adds session rules only for paths it
  knows, never a deny.
- No polling, no periodic timers. React to events: OpenCode's stream, a wake
  from whoever changed state, a promise that resolves. A timer is acceptable
  only to wait for a known instant (a due job, a retry backoff) or to satisfy
  a protocol keep-alive. A "safety net" interval is a poll with a better name.

Rules for the worker/Linear lifecycle (built: `docs/linear.md`; what is left:
`docs/plans/linear.md`):

- Never release a worker's resources merely because its caller disconnected.
- A worker runs in its own git worktree, never in the project's `source/`;
  the one exception is a lane that says `worktree: false` — read-only by its
  agent file's own deny, never by aivi.
- Stop means stop: a stop request, the HITL label or a lane change ends the
  worker and releases the issue; the worktree and the native transcript stay
  for inspection. `blocked` is only for a stop that cannot be verified.
  Graceful agent-first cleanup is a later upgrade, not a precondition.
- Linear lanes select OpenCode agents directly; one app (the primary) does the
  receiving and the assistant (`linear.agent`) answers what no lane claims.

When behavior changes, update the one document that owns that fact (the map is
in `CONTEXT.md`) in the same commit; a change is not done while a document
still describes the old behavior. When a backlog idea is built, shrink its page
to what is left and point at the owners. `docs/review/*.md` are findings, not
specifications; `docs/backlog/*.md` are unscheduled ideas.

Use Node 26 (`engines` in `package.json`), pinned dependencies, and npm
workspaces. There is no build: packages run from `src/*.ts` (type stripping),
so keep to erasable TypeScript syntax and `.ts` import specifiers. Test
lifecycle, persistence, and configuration changes at the actual boundaries they
affect. Live OpenCode, Discord and macOS Chrome verification are
separate gates; mock tests do not establish those.

Commits follow Conventional Commits (`type(scope): subject`; lefthook enforces
it). Run `npm run agentic:verify` before committing; run `npm run schema` after
changing a zod config schema or the check fails.

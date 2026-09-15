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
- Discord uses one librarian agent and does not execute project work.

Design rules for the worker/Linear lifecycle (not built; only config validation
exists):

- Never release a worker's resources merely because its caller disconnected.
- Cleanup is agent-first undo, followed by orchestrator cleanup and verification.
- Failed cleanup stays blocked for human repair. Preserve the native transcript.
- Linear project lanes select apps; each app maps to one unique OpenCode agent.

When behavior changes, update the one document that owns that fact (the map is
in `CONTEXT.md`). `docs/review/*.md` are findings, not specifications;
`docs/backlog/*.md` are unscheduled ideas.

Use Node 26 (`engines` in `package.json`), pinned dependencies, and npm
workspaces. Test lifecycle, persistence, and configuration changes at the actual
boundaries they affect. Live OpenCode, Discord and macOS Chrome verification are
separate gates; mock tests do not establish those.

Commits follow Conventional Commits (`type(scope): subject`; lefthook enforces
it). Run `npm run agentic:verify` before committing; run `npm run schema` after
changing a zod config schema or the check fails.

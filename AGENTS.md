# Working on aivi

Read `README.md` and the relevant architecture/configuration docs before changing
runtime behavior. The product requirements and roadmap are in `docs/`.

- Use native OpenCode agents, sessions, permissions, tools, and providers.
- Keep installation state in the host, not in each native plugin instance.
- Add integrations as optional adapters; avoid a general plugin framework.
- Keep source documents authoritative and search indexes rebuildable.
- Preserve project scope; unknown IDs must not broaden a query.
- Do not equate prompt acceptance or session idleness with job completion.
- Never release a worker's resources merely because its caller disconnected.
- Cleanup is agent-first undo, followed by orchestrator cleanup and verification.
- Failed cleanup stays blocked for human repair. Preserve the native transcript.
- Linear project lanes select apps; each app maps to one unique OpenCode agent.
- Discord uses one librarian agent and does not execute project work.
- Keep credentials in fnox/environment, never configuration examples or logs.

Use Node 26 (`engines` in `package.json`), pinned dependencies, and npm workspaces. `npm run check` builds and
runs focused tests plus the CLI smoke test. Test lifecycle, persistence, and
configuration changes at the actual boundaries they affect. Live OpenCode and
macOS verification are separate gates; mock tests do not establish those.

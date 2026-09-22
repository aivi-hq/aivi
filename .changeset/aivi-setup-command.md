---
'@aivi/cli': minor
---

`aivi setup` is the one entry point for client and server; `server create` folds into it and is no longer a person-facing command. Connecting to a host verifies the url and token with `whoami` before anything is written, then installs both OpenCode plugins (`opencode plugin add @aivi/opencode`, `opencode-attribution`). Creating a server now also seeds the home's OpenCode shape (`opencode.jsonc` plus `aivi.md`, `librarian.md` and `dreamer.md` in `.opencode/agents/` — existing files are never overwritten), offers `aivi service install` on the same-machine path, and prints a verified "Signed in as …" instead of an instruction the CLI cannot keep. The client config's `person` gains a display-only `id`/`name`/`roles` cache, written from `whoami`.

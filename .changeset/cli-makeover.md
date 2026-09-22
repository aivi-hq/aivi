---
'@aivi/cli': minor
'@aivi/app': minor
'@aivi/core': minor
---

The CLI's face: both CLIs (the thin client and the server app) move onto
commander for parsing, routing and help. Help is grouped by kind and themed in
the brand colors, every command answers `aivi <command> --help` for itself,
flags are declared per command (an unknown flag in the wrong place is an
error), and a typo'd command is answered with the nearest real one. The
wordmark banner prints on a terminal; pipes and `NO_COLOR` keep plain text, so
stdout stays a machine contract. Colors come from Node's built-in
`util.styleText` in the same hex palette the logs use; the Node floor moves to
26.1.0 for its hex support. Command bodies are extracted into
`packages/app/src/commands/` grouped by category.

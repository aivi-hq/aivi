---
'@aivi/host': minor
---

The exec door: `/exec` as a websocket upgrade on the host's own listener. The version gate, the bearer and the **operator** role are run by hand (node hands upgrades to the door, not through hono), and every arrival — run or refused — writes one diary line: person, argv, source address, exit code or reason. An operator's `aivi <argv>` runs as a child on a PTY with a closed environment carrying `AIVI_OPERATOR_BEARER` (the bearer this very connection presented, so `whoami` and association name the remote human), or as plain pipes when the client's stdout is not a TTY, where stderr rides base64 and JSON stays untouched. A machine whose node-pty cannot load answers exec attempts with `remote exec unavailable on this host` and never takes the host down; the macOS prebuild's missing execute bit is repaired once per process. New server-side dependencies: `ws`, `node-pty`.

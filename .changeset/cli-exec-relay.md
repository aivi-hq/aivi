---
'@aivi/cli': minor
---

`aivi -r <command>` drives the configured server with the very command you would type there: the relay opens the exec door with this machine's bearer, puts the terminal in raw mode, forwards bytes and window resizes, and restores the terminal on **every** exit path. When stdout is not a TTY (`aivi status | jq` from a laptop) the session asks for plain pipes — stdout untouched, stderr kept apart — and JSON stays JSON. Honest failures only: `no server configured — run aivi configure`, `host unreachable at <url>`, the refusal's own words from the server, or `connection lost`; a remote command never falls back to local execution, and plain commands never touch the network. New dependency: `ws` (the web-standard client swallows refusals; the server's answer is worth one small library).

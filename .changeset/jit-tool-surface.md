---
'@aivi/core': minor
'@aivi/host': minor
'@aivi/opencode': minor
---

The OpenCode plugin JITs its tools: each capability's owner contributes a descriptor, the host serves them at `GET /v1/tools` and dispatches calls at `POST /v1/tools`, and the plugin registers exactly what the host offered at load. The plugin hardcodes no aivi tools; its own `aivi_connection` reports reachability, version and which tools this process loaded.

# @aivi/opencode

The OpenCode plugin. Ordinary OpenCode installs reach the aivi knowledge
server through it, over the authenticated host API. It registers the aivi
tools and never runs host code in-process.

## Tools

`knowledge_search`, `knowledge_projects`, `aivi_sources`, `aivi_status`,
`aivi_context`, `aivi_jobs`, `aivi_browser`.

## Install

`aivi setup` adds it (with the commit-attribution plugin) via
`opencode plugin add`; it is idempotent, so setup may re-run it.

## Loading note

The long-running OpenCode service keeps `@aivi/host/client` in its module
cache. Restart the service after any change to the plugin or the host
client, or a plugin that registers a new tool can still call a client
without that method.

## Dependencies

`@aivi/core` and `@aivi/host`; `@opencode/plugin` as a peer.

## Docs

[opencode](../../docs/opencode.md)

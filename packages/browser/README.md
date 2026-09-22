# @aivi/browser

Chrome DevTools MCP with a persistent profile and session-owned tabs.
Drives one persistent Chrome for unattended sessions and shared logins —
distinct from OpenCode's own `browser.*` tools, which drive the desktop
app's browser.

## Exports

| Path | Contents |
| --- | --- |
| `@aivi/browser` | `createBrowserService` — launches and owns the persistent Chrome, exposes tools over the MCP SDK |

## How it works

Wraps `chrome-devtools-mcp` behind a persistent user profile so logins
survive restarts. The host serves it at `/v1/browser`; the OpenCode plugin
exposes it as `aivi_browser`. Construction is lazy — no Chrome launches
until a tool call.

## Docs

[browser](../../docs/browser.md)

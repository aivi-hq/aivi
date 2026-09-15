# Browser control

`@aivi/browser` uses the official **Chrome DevTools MCP**, pinned to 1.9.0.
There is no aivi Playwright dependency or replacement automation engine. One
stdio MCP child belongs to the host; native OpenCode tools call it through aivi.
Chrome and the MCP child start lazily on the first browser operation.

## Use an existing Chrome profile

For the normal Chrome experience, start your dedicated aivi Chrome profile yourself,
install extensions and sign in normally. In Chrome 144 or later, enable remote
debugging at `chrome://inspect/#remote-debugging`. Chrome asks you to allow the
incoming connection. Configure the **user data directory**, not its inner
`Default` or `Profile 1` directory:

```json
{
  "version": 1,
  "browser": {
    "connection": { "mode": "existing", "userDataDir": "./chrome-aivi" },
    "maxTabsPerSession": 5,
    "maxTabs": 20
  }
}
```

Paths resolve relative to aivi.json. On macOS, for example, start the dedicated
profile with this command (use the same absolute directory as the config):

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --user-data-dir="/absolute/path/chrome-aivi"
```

Run `aivi serve` normally. In native OpenCode with the aivi plugin, ask the agent
to open a website. The native `browser` permission controls `browser_control`.
The tool gets its session ID from OpenCode; the model cannot choose an owner ID.
Use the `focus` action to bring an owned tab forward for manual login.
The existing Discord librarian keeps its default-deny policy; this addition does
not silently give it permission to click, submit forms, or send messages.

## Other connection modes

For aivi to start Chrome with a dedicated persistent profile, use:

```json
{ "browser": { "connection": { "mode": "launch", "userDataDir": "./chrome-aivi" } } }
```

Chrome is visible by default; `headless` is optional. `executablePath` can point
to a non-default Chrome installation. This uses MCP's launcher with extension-
disabling default arguments removed. Manually installed extensions and logins
live in that profile. Close another Chrome using that directory before launch.
The existing-profile mode is preferable when a site rejects automation-launched
login flows. Neither mode guarantees that sites will never challenge automation.

For Chrome already exposing a loopback debugging port:

```json
{ "browser": { "connection": { "mode": "attach", "browserUrl": "http://127.0.0.1:9222" } } }
```

Only loopback attachment URLs are accepted. Attached/existing Chrome remains
running when aivi exits; a Chrome launched by MCP is closed with its MCP process.
MCP telemetry, CrUX requests, and update checks are disabled by the adapter.
The child inherits basic OS environment settings, not aivi/provider tokens.

## Tools and ownership

`browser_control` provides `tabs`, `open`, `navigate`, `snapshot`, `click`, `fill`,
`press`, `dialog`, `focus`, and `close`. Snapshot returns the accessibility tree
with an `id` per node; pass that value as `uid` to click/fill. Read a new snapshot after navigation or significant page changes.
The initial interface does not expose arbitrary JavaScript, network headers,
local file uploads, downloads, or extension installation tools.

Each opened tab gets an opaque aivi ID bound to its native session. Actions route
by explicit MCP page ID, never by a shared selected tab. Page lists are filtered
and raw MCP responses are not forwarded because they can list unrelated tabs.
Existing/manual tabs and popups are not adopted. Automatic popup ownership is a
follow-up; use an explicit open when possible. Browser output is page data, not
trusted instructions.

Tabs share the profile's cookies and account state. Ownership prevents accidental
cross-session tab control; it does not provide separate user identities or a
security sandbox between websites. Input and snapshots enter native transcripts;
use manual login for secrets. A fnox-to-browser secret entry path is not yet built.

Limits default to five owned tabs per session, twenty owned tabs overall, sixteen
pending operations, and a thirty-second MCP call timeout. All operations serialize
through a bounded host queue. Browser actions use no model slot of their own, so
an agent does not deadlock by reacquiring its existing inference lease.

Navigation failure retains the allocated tab. Transport uncertainty or reconnect
blocks browser use until inspection and host restart. No click is automatically
retried. Closing a tab is not rollback of a purchase, message, or other side effect.
Ownership is currently in memory: after restart existing tabs remain unowned and
inspectable. There is no automatic expiry/cleanup of abandoned session tabs yet.

## Verify on your machine

`npm run check` covers ownership, limits, routing, lifecycle, HTTP authentication,
and a real MCP startup/schema handshake without requiring Chrome.

With Chrome installed, run `npm run smoke:browser`. Optionally set
`AIVI_TEST_CHROME` to its executable. This creates a throwaway profile, opens only
a local HTML fixture, checks typing/clicking and cross-session rejection, then
closes it. It does not use your configured browser profile.

`npm run smoke:browser` passed on the target Mac on 2026-09-15 against headless
Chrome: two sessions open tabs, snapshot, fill, click, refuse each other's tabs,
close. Two facts it settled: chrome-devtools-mcp 1.9.0 returns page lists and
snapshots as structured content only with `--experimentalStructuredContent=true`
(aivi passes it), and snapshot nodes carry `id`, which click/fill take as
`uid`. Still open: manual login takeover, extensions, and the recovery paths a
failed first `open` or a human flipping tab selection would exercise.

## Why this backend

OpenClaw has both a managed Playwright-over-CDP path and an existing-session
Chrome DevTools MCP path. We chose MCP to reuse Google's browser tooling and keep
aivi focused on ownership and lifecycle.

- [OpenClaw browser modes](https://docs.openclaw.ai/tools/browser)
- [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp)
- [Profiles and existing-browser connection](https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/main/docs/advanced-usage.md)

The upstream main-branch docs can run ahead of a released package. The adapter
checks the installed tool schemas and requires explicit page-ID routing; it never
falls back to implicit selected-tab control.

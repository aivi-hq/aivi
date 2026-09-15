# Browser control

OpenCode has its own browser tools (`browser.*`), which drive the browser the
**desktop app** attaches to a session. aivi's browser exists for what that
cannot do: unattended sessions (Discord, scheduled jobs, dreaming) on a machine
with no desktop app attached, and one persistent Chrome profile whose logins
and tabs are shared, with each tab owned by one session. A person working in
the desktop app is usually better served by OpenCode's browser; the example
agents deny it so unattended sessions are not offered a browser that cannot
connect, and the rule is one line to remove.

`@aivi/browser` uses the official **Chrome DevTools MCP**, pinned to 1.9.0.
There is no aivi Playwright dependency or replacement automation engine. One
stdio MCP child belongs to the host; native OpenCode tools call it through aivi
as `aivi_browser`. Chrome and the MCP child start lazily on the first browser
operation.

## Which Chrome: three choices

Chrome has two nesting levels and the words get mixed up. A **user data
directory** is a whole Chrome world: its own process, cookies, extensions and
its own list of **profiles** (the people in the profile switcher). One Chrome
process owns one data directory. aivi can work with either level:

| Mode | What aivi drives | When to use it |
| --- | --- | --- |
| `launch` (default) | Its own Chrome in `<home>/state/chrome`, a separate data directory. Never appears in your Chrome's profile switcher. | Servers and unattended work: nothing else needs to be running. Logins made in that window persist there. |
| `existing` | A data directory you started yourself with `--user-data-dir`, extensions installed and signed in. | You want to prepare the aivi browser by hand, still separate from your own. |
| `attach` | Your own running Chrome, over remote debugging. aivi's tabs open in it, in the profile that enabled debugging, with your logins. | You work at that Mac and want aivi's tabs next to yours. Unattended jobs then depend on your Chrome being open. |

### Default: aivi's own Chrome

Nothing to configure. On the first browser call aivi launches Chrome, visible
(not headless), with the data directory `<home>/state/chrome`. Set
`"browser": false` to disable the service; `aivi_browser` then reports that the
browser is not configured.

### Attach to your own Chrome

In Chrome 144 or later enable remote debugging at
`chrome://inspect/#remote-debugging` (Chrome asks you to allow each incoming
connection), or start Chrome with `--remote-debugging-port=9222`. Then:

```json
{ "browser": { "connection": { "mode": "attach", "browserUrl": "http://127.0.0.1:9222" } } }
```

Only loopback URLs are accepted. The agent then acts in your profile with your
logins; restrict what it may do in its agent file accordingly.

### A data directory you manage

```sh
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --user-data-dir="/absolute/path/chrome-aivi"
```

Install extensions and sign in there, enable remote debugging as above, and
point aivi at the **data directory** (not its inner `Default` or `Profile 1`):

```json
{ "browser": { "connection": { "mode": "existing", "userDataDir": "/absolute/path/chrome-aivi" } } }
```

Paths resolve relative to the home. In every mode the tool gets its session ID
from OpenCode (the model cannot choose an owner), and `focus` brings an owned
tab forward for a manual login that then persists.

## Tools and ownership

`aivi_browser` provides `tabs`, `open`, `navigate`, `snapshot`, `click`, `fill`,
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

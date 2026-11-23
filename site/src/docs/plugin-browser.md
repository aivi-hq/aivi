---
title: Browser
description: Give aivi a persistent Chrome profile for unattended work.
order: 11
group: Plugins
---

The browser is opt-in. Without it, no agent sees a browser tool. With it, aivi can open pages, click, fill forms and read snapshots in a Chrome profile that keeps its logins across restarts.

```sh
aivi add browser
```

This installs `@aivi/browser`, writes `plugins.browser`, adds the package to `aivi-plugins`, and ends with "Browser is running." Chrome and the MCP child start on the first browser action, so the module costs nothing until it is used.

## Which Chrome

The default mode is `launch`. aivi starts its own Chrome in `<home>/state/chrome`, with a visible amber window and a profile named "aivi". It never appears in your own profile switcher.

Two other modes are available:

| Mode | What it drives |
| --- | --- |
| `existing` | A Chrome data directory you created and signed into |
| `attach` | Your running Chrome over remote debugging, with your current logins |

```json
{
  "plugins": {
    "browser": {
      "connection": {
        "mode": "attach",
        "browserUrl": "http://127.0.0.1:9222"
      }
    }
  }
}
```

Only loopback debug addresses are accepted.

## Tabs and limits

Each tab belongs to the OpenCode session that opened it. The tool gets the session id from OpenCode, not from the model. A different session cannot act on that tab. Tabs share the profile's cookies and logins, so ownership prevents accidental cross-session control, not separate identities.

The tool offers `tabs`, `open`, `navigate`, `snapshot`, `click`, `fill`, `press`, `dialog`, `focus` and `close`. Snapshots return the accessibility tree, and the `uid` values are what click and fill accept. There is no arbitrary JavaScript, network header or file upload surface in this first interface.

Defaults are five owned tabs per session, twenty overall, sixteen pending operations and a thirty-second call timeout.

Browser output is page data, not instructions. Use a manual login for secrets, because input and snapshots enter the native transcript.

The full page is [Browser](https://github.com/aivi-hq/aivi/blob/main/docs/browser.md).

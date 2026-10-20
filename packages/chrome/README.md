# @aivi/chrome

A puppeteer-shaped driver for the Chrome that is already installed. One
launch, one websocket, a dozen page verbs — and the full DevTools Protocol
still reachable underneath, because a wrapper that hides the protocol is a
leash.

Why not puppeteer: its npm tree is 32 MB (`chromium-bidi`, its own `zod`,
`devtools-protocol`, more) for helpers we can write in a page function. This
package has **no dependencies**: Node 26 ships `fetch`, `WebSocket`, and
`EventTarget` itself.

## Use

```ts
import { Chrome } from '@aivi/chrome'

const chrome = await Chrome.launch({ profileDir: '/tmp/aivi-browser' })
const tab = await chrome.newTab()

// the face trick: install before the page's own scripts run
await tab.send('Page.addScriptToEvaluateOnNewDocument', { source: faceSource })
await tab.goto('https://meet.google.com/abc-defg-hij')

await tab.waitForText('Ask to join')
await tab.fill('input[aria-label="Your name"]', 'aivi')
await tab.click('button[aria-label="Ask to join"]')
await tab.waitForText('Leave call')

await chrome.close() // ends the browser it launched
```

`Chrome.attach({ debugUrl })` takes over a browser somebody else started;
its `close()` disconnects and leaves that browser running.

## The verbs

| | |
| --- | --- |
| `evaluate(expr)` / `call(fn, ...args)` | run code in the page, plain values back |
| `waitFor(fn)` / `waitForSelector` / `waitForText` | poll until truthy, bounded |
| `exists` / `text` / `attr` / `url` | read the DOM |
| `click` / `fill` | act on it (`fill` does the native-setter dance frameworks need) |
| `screenshot` / `goto` / `close` | the rest of the day |
| `send(method, params)` / `on(event)` | the escape hatch: any command, any event, this tab |

Page functions travel as source text: they close over nothing from your
file, take data as arguments, and return plain values.

## Honest edges

- Clicks are synthetic (`element.click()`). Proven on real Meet screens; an
  app that demands trusted input gets `Input.dispatchMouseEvent` through
  `send`.
- Timers are bounded one-shot waits for the two things the protocol has no
  event for — "an element finally exists" and "the booting browser wrote its
  port file". Nothing here repeats on a schedule.
- No silent reconnect: the socket to a browser you launched dies with it, on
  purpose.
- Chrome 136+ ignores the debug port on the default profile, so a launch
  always carries its own `--user-data-dir`.
- macOS and Linux. Windows: not yet, say so if you need it.

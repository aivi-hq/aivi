# @aivi/chrome

## 1.1.0

### Minor Changes

- [#76](https://github.com/aivi-hq/aivi/pull/76) [`5b230e0`](https://github.com/aivi-hq/aivi/commit/5b230e0e59bf8fa8fe27f0a22cfdb9312b69230b) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - Add `killAfterMs` to `Chrome.launch`, and `pollMs` to `Chrome.launch` and `Chrome.attach`. `killAfterMs` is how long a browser gets to end after SIGTERM before it is killed (default 5000, as before). `pollMs` is the pause between two looks while a browser boots, at its port file and at `/json/version` (defaults 50 and 100, as before). They were fixed numbers in the code.

- [#76](https://github.com/aivi-hq/aivi/pull/76) [`04084b5`](https://github.com/aivi-hq/aivi/commit/04084b586a14269ea03712edd72d9b9d8b78e991) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The Node floor moves from 26.1.0 to 26.12.0: `engines.node` is now `>=26.12.0 <27`. `aivi update` reads the target's `engines` and provisions a managed Node when the machine's own is below it.

### Patch Changes

- [#76](https://github.com/aivi-hq/aivi/pull/76) [`5b230e0`](https://github.com/aivi-hq/aivi/commit/5b230e0e59bf8fa8fe27f0a22cfdb9312b69230b) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - Bound each `/json/version` request of `Chrome.launch` and `Chrome.attach` by the time the call was given (`startupTimeoutMs`, `timeoutMs`). A request to an endpoint that took the connection and never answered was not bounded by them, so the call could outlast its timeout.

- [#76](https://github.com/aivi-hq/aivi/pull/76) [`c9f4ef7`](https://github.com/aivi-hq/aivi/commit/c9f4ef7b0b0ba4468f96af1984f1f503c77917f1) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - Stop `tab.goto` leaving its wait for the load behind when the navigation fails. `goto` starts waiting for `Page.loadEventFired` before it sends `Page.navigate`; if the navigation failed (a DNS error, a refused command), or the wait ran out while the command was still unanswered, nothing was listening to that wait. It then rejected on its own at `timeoutMs` as an unhandled rejection, and Node ends a process for one: a failed navigation could end the host 20 to 30 seconds later. The wait is now cancelled when `goto` fails, and a wait that runs out early is reported as the error of `goto`.

- [#76](https://github.com/aivi-hq/aivi/pull/76) [`c9f4ef7`](https://github.com/aivi-hq/aivi/commit/c9f4ef7b0b0ba4468f96af1984f1f503c77917f1) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - Ignore a websocket frame that is valid JSON but not an object. A frame of `null` made the connection's message listener throw, and Node reports an exception thrown in an event listener as an uncaught exception, so one odd frame could end the process. It is ignored now, like a frame that is not JSON.

- [#76](https://github.com/aivi-hq/aivi/pull/76) [`5b230e0`](https://github.com/aivi-hq/aivi/commit/5b230e0e59bf8fa8fe27f0a22cfdb9312b69230b) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - Make `Chrome.launch` reject when the browser binary cannot be started. Node reports a binary that is missing or not executable as an `error` event on the child process, and with no listener on it Node ends the whole process. `launch` now listens, and rejects with that error (for example `spawn /opt/chrome ENOENT`).

- [#76](https://github.com/aivi-hq/aivi/pull/76) [`c9f4ef7`](https://github.com/aivi-hq/aivi/commit/c9f4ef7b0b0ba4468f96af1984f1f503c77917f1) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - Make `tab.off(event, listener)` take the listener off the event it is asked for. Tab listeners were remembered by listener alone, so a listener added to two events could not be taken off the first one (and then could not be taken off the second), and a listener added twice to one event was called twice but could be removed only once. They are remembered by event and listener now, and adding the same listener to the same event twice is one registration, as it is for an `EventTarget`.

## 1.0.0

### Major Changes

- [#67](https://github.com/aivi-hq/aivi/pull/67) [`71b6b4c`](https://github.com/aivi-hq/aivi/commit/71b6b4ce881cd24a2045017c38be496a2d91f9c3) Thanks [@RWOverdijk](https://github.com/RWOverdijk)! - The Chrome driver is public: its API is the product, so a person can drive a
  browser on their own (ruled 2026-10-20). It ships as v1 with the rest of the
  family.

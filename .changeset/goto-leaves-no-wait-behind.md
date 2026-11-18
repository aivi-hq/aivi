---
"@aivi/chrome": patch
---

Stop `tab.goto` leaving its wait for the load behind when the navigation fails. `goto` starts waiting for `Page.loadEventFired` before it sends `Page.navigate`; if the navigation failed (a DNS error, a refused command), or the wait ran out while the command was still unanswered, nothing was listening to that wait. It then rejected on its own at `timeoutMs` as an unhandled rejection, and Node ends a process for one: a failed navigation could end the host 20 to 30 seconds later. The wait is now cancelled when `goto` fails, and a wait that runs out early is reported as the error of `goto`.

---
'@aivi/forge-github': minor
---

**The GitHub client answers rate limits when they arrive; nothing paces
writes any more.** The umbrella `octokit` package bolted its throttling
plugin onto every client, and that plugin's Bottleneck held **every**
write call for a fixed second — against a real GitHub and against a
scripted in-memory one alike: a person's `aivi pr` paid one second per
write, and every test in the package paid seconds for a rate limit
nobody had hit. The client is now assembled from the parts aivi uses:
`@octokit/core`, the REST endpoint methods, and the retry plugin, which
re-sends what actually failed (429 and the server errors, with backoff).
aivi is one installation making a handful of writes per ticket; a 403
secondary-limit is answered by the honest error the person can read,
not a pre-scheduled wait nobody asked for.

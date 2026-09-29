---
'@aivi/plugin': minor
---

**The forge contract.** A new subpath, `@aivi/plugin/forge`, says what a
repository host answers and does. The line between a forge and aivi is
**remote, not git**: any git operation that reaches `origin` authenticates to
it, so it is the forge's — fetch, the sync of a project's clean checkout, and
the push at turn end. What only touches the local store is aivi's own
machinery and never appears here. The forge's API is for what git cannot see:
`repoFor` (which repository this project's remote names, silent when it is
another forge's), `prForBranch`, `reviewFeedback` — **open threads only**, no
`since` cursor — and the one write, `resolveThread`, which posts a worker's
reply saying which worker role it came from, visibly, and resolves the thread.
A forge parses that signature back into the author fact, so a wake can tell
its own past comments from a human's.

Cloning is a forge's operation too but is not on this interface: it happens
once, at project setup, through the plugin's `./setupProject` contributor. By
the time a `Forge` is speaking to aivi the checkout already exists.

A project having no forge is not a failure: a ticket can be "research X, write
it up" and complete without aivi ever asking a repository host anything.

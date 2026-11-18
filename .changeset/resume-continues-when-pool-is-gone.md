---
"@aivi/host": minor
"@aivi/plugin": minor
---

Continue a resumed session in the pool its caller asks for when the pool it was created in is no longer configured. The dispatcher refused such a resume with `pool-gone`, so a conversation or a worker waiting on an answer stayed stuck until the old pool name came back. It now warns `resume.pool-gone`, moves the session to the asked pool and leaves its model as it was. An asked pool that is not configured either is the same error as before. An answer to a worker's question now asks for the pool of the run's lane. The `pool-gone` refusal is removed from `DispatcherGrant` and `Refusal`.

---
'@aivi/forge-github': patch
---

`projects add` accepts the shorthand it promises. The forge's repository
prompt says "owner/repo, or its URL", but the parse behind it read only
full URLs — a bare `owner/repo` has no scheme to parse, so the answer the
prompt asked for was rejected as wrong. A two-segment name now means a
repository on github.com, exactly like the URL form; relative paths and
three-segment answers still name no repository.

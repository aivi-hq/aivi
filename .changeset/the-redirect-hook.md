---
'@aivi/core': minor
'@aivi/plugin': minor
'@aivi/host': minor
'@aivi/opencode': minor
---

**The redirect hook.** aivi's own plugin now denies boundary git — `git
push`, `fetch`, `pull`, `clone`, `ls-remote`, `remote`, behind any flags or
`-c` prefixes — **in aivi's runs only**, and says the way across instead:
"git push is disabled in aivi runs — use aivi_push (and aivi_sync first if
the remote moved)". Scoped by sessionID: the plugin asks the host's new
`GET /run?session=` once per session (answered from the run ledger) and
caches; a person's sessions never see the deny, and a host that cannot
answer fails open — the worktree's no-credential mark is the wall, the
hook is the signpost.

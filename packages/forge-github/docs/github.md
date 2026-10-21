# GitHub forge — the forge's configuration

`plugins.forge-github` is the GitHub forge's whole setup, and it is **empty**
(ruled 2026-10-07): `{ "plugins": { "forge-github": {} } }`. The block stands
as the mark that the forge is configured — core offers the forge role to a
project only when it is written — and holds no facts. The module runs when
`@aivi/forge-github` stands in the `aivi-plugins` list.

The app's identity is a **home** fact, not a block's: `GITHUB_APP_ID` (the
`App ID` number on the app's settings page) and `GITHUB_APP_PRIVATE_KEY` (the
PEM GitHub handed out when the app was created) both live in `<home>/.env`,
because the forge and the tracker are **one app** and a plugin block cannot be
the shared source for two plugins. `aivi add` asks for the id and the .pem
once: it copies the key into `.env`, and remembers no path.
The app must also be **installed** — an installation is the grant from the account
holding the repositories to the app — and aivi speaks through exactly one:
none is an error carrying the install link, several is an error naming the
grants and saying which to revoke.

Nothing in this block names a repository. Which repository a project is comes
from that project's own `origin`, and a checkout whose remote is not a GitHub
repository simply has no forge: no error, and no pull-request facts. Likewise
there is no per-project forge section — a forge is asked about a checkout it
did not create and reads the answer off the checkout. What asks it today is
the `projects-sync` job (a checkout this forge recognises syncs **through**
the forge, authenticated as its own installation; the rest stays plain git)
and the worker's git tools: `aivi_sync` brings the remote's refs in,
`aivi_push` moves commits (as the forge's own app, fast-forwarding, merging,
or forcing only a patch-equivalent rewrite), and `aivi_pr` opens the pull
request when the branch has none; `aivi_review`, `aivi_respond_feedback` and
`aivi_submit_review` carry the review conversation the same way. A project
with no forge gets none of these, and the tools say so plainly when they
are called anyway.

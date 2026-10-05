# GitHub forge — the forge's configuration

`plugins.forge-github` is the GitHub forge's whole setup, and it is one
number: the app's id — the `App ID` on the app's settings page, not its name.
The module runs when `@aivi/forge-github` stands in the `aivi-plugins` list.

```json
{ "plugins": { "forge-github": { "app": 12345 } } }
```

The private key is a secret and so is not here: `GITHUB_APP_PRIVATE_KEY` in
`<home>/.env`, the PEM file GitHub handed out when the app was created.
`aivi add` asks for that file once: it reads the .pem, copies the key into
`.env`, and remembers no path.
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

---
'@aivi/forge-github': minor
'@aivi/plugin': minor
---

**The GitHub forge.** `@aivi/forge-github` answers the `Forge` contract to
GitHub, as its own app: octokit signs the app's JWT, mints an installation
token and renews it, so nothing mints per command and nothing is cached by
hand. The app has to be installed for any of this to work, and aivi speaks
through exactly one installation — none is an error carrying the install link,
several is an error naming the grants and saying which to revoke. One part of
it is usable today: `aivi projects add` asks its `forge`-role contributor which
repository a project is, proves the app can see it through the grant, and
clones it as the app.

A transfer authenticates inside its own command's environment and names the
repository's URL on the command line instead of asking the checkout where its
`origin` is. So no token is left in a file, the person's stored credential is
never offered, and an ssh `origin` is left exactly as its owner left it — an
installation token authenticates HTTPS and nothing else. The tests run the
transfers against a real git remote on disk and read the checkout's
`.git/config` afterwards to show aivi left nothing there.

Two facts the build made say themselves. `push` answers the pull request
standing for the branch afterwards, which is undefined when the branch simply
moved and no pull request was asked for, and it takes the worker role along
with the message so the pull request aivi opens says who opened it. And a
checkout that is already there for the repository the person named counts as
cloned, so a setup never writes its "no source" note into a real repository.

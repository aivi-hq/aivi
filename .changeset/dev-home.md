---
'@aivi/cli': minor
'@aivi/opencode': minor
---

The example home is replaced by `dev/`, a real development home produced by
`npm run aivi:cli setup` against the local build (`file:` specs install
workspace packages; `AIVI_HOME=dev` and the new `AIVI_CONFIG` — which moves
the client config file everywhere it is read, thin CLI, app identity, link,
plugin — keep it separate from any real install). Setup now writes the app
manifest it installs against, so a home inside another package can never
anchor npm at that ancestor. Only the dev README is tracked.

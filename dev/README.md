# The dev home

This directory is a real aivi **home** for development — `config.json`, `.env`,
`app/` (the installed server), `.config/aivi.json` (the client record), `.opencode/`
and `state/` — produced by the real `aivi setup` against your local build. Only
this README is tracked; everything else is generated or yours, and git-ignored.

## Set it up

```sh
npm run aivi:cli -- setup --use this-machine \
  --app-spec "file:../../packages/app" \
  --plugin "file:../../packages/channel-discord" \
  --plugin "file:../../packages/channel-slack" \
  --plugin "file:../../packages/linear"
```

That is the ordinary thin CLI (`packages/cli`), pointed at this directory by
`AIVI_HOME` and at `dev/.config/aivi.json` by `AIVI_CONFIG`, so the dev home
never touches a real `~/.aivi` or `~/.config/aivi.json`. The `file:` specs make
npm install your workspace packages instead of the registry — same code path a
real install runs, local `dist/` on the end. Drop any `--plugin` you do not
want; add plugins later with `npm run aivi:cli -- install discord` — once a
plugin's package is present, `install` runs its own setup wizard (writes
`config.json` and `.env` here). Without the package it installs from npm, so
in this home install the `file:` spec at setup first.

Setup seeds the OpenCode shape (`opencode.jsonc`, `.opencode/agents/`) and pins
`@aivi/opencode` **from npm** in `opencode.jsonc`; to run OpenCode against your
local plugin build instead, replace that spec with `../packages/opencode/dist`.

## Run it

```sh
npm run aivi:cli -- serve        # the server (foreground)
npm run aivi -- status           # the app CLI, same home
npm run aivi -- jobs list
npm run aivi:cli -- link discord # mints a link code (needs the server up)
```

`npm run aivi:cli` builds first and runs the compiled thin CLI, which forwards
into `dev/app`; `npm run aivi` runs the app CLI directly. Both point at this
home. Secrets go in `dev/.env`; the live `config.json` is yours to edit.

## Reset

Delete everything but this README and run setup again.

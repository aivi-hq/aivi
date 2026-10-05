# The dev home

This directory is a real aivi **home** for development — `config.json`, `.env`,
`app/` (the installed server), `.config/aivi.json` (the client record), `.opencode/`
and `state/` — produced by the real `aivi setup` against your local build. Only
this README is tracked; everything else is generated or yours, and git-ignored.

## Set it up

```sh
npm run aivi:cli -- setup --use this-machine --host-package "file:../../packages/host"
```

That is the ordinary thin CLI (`packages/cli`), pointed at this directory by
`AIVI_HOME` and at `dev/.config/aivi.json` by `AIVI_CONFIG`, so the dev home
never touches a real `~/.aivi` or `~/.config/aivi.json`. Setup installs the
server alone; plugins join afterwards with `add`, which runs each plugin's
own setup wizard (writes `config.json` and `.env` here) and only then lists
it. Run the wizard while the server is up — `npm run aivi:cli -- serve` in
another terminal — because a plugin's setup verifies its secrets against the
running server before writing anything:

```sh
npm run aivi:cli -- add "file:../../packages/channel-discord"
npm run aivi:cli -- add "file:../../packages/channel-slack"
npm run aivi:cli -- add "file:../../packages/tracker-linear"
```

The `file:` specs make npm install your workspace packages instead of the
registry — same code path a real install runs, local `dist/` on the end; the
package's own `package.json` says its name. Aliases (`discord`, `slack`,
`browser`, `linear`) install from npm, so in this home use the `file:` specs;
`aivi remove <name>` takes a plugin out again.

Setup seeds the OpenCode shape (`opencode.jsonc`, `.opencode/agents/`) and pins
`@aivi/opencode` **from npm** in `opencode.jsonc`; to run OpenCode against your
local plugin build instead, replace that spec with `../packages/opencode/dist`.

## Run it

```sh
npm run aivi:cli -- serve        # the server (foreground)
npm run aivi -- status           # the host's command surface directly, same home
npm run aivi -- jobs list
npm run aivi:cli -- link discord # mints a link code (needs the server up)
```

`npm run aivi:cli` builds first and runs the compiled thin CLI, which
mounts the server's operator commands in-process from `dev/app`;
`npm run aivi` runs the host's `./cli` directly. Both point at this
home. Secrets go in `dev/.env`; the live `config.json` is yours to edit.

## Reset

Delete everything but this README and run setup again.

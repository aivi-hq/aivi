# Getting started

From a fresh clone to an assistant answering questions, in a development home
you set up yourself.

## Run it

Use Node 26 and npm. From the repository root:

```sh
npm ci
npm run check
npm run aivi:cli -- setup --use this-machine --host-package "file:../../packages/host"
```

Setup installs the server alone; plugins join afterwards, one command each,
run while `npm run aivi:cli -- serve` is up in another terminal (the plugins'
own setup verifies its secrets against the running server before writing):

```sh
npm run aivi:cli -- add "file:../../packages/channel-discord"
npm run aivi:cli -- add "file:../../packages/channel-slack"
npm run aivi:cli -- add "file:../../packages/tracker-linear"
```

Run setup without the flags and it is a conversation: your name, and one
question about reach — only this machine; your network, where aivi listens
on a LAN or tailnet address you pick; or a URL in front of it, which a
tunnel or proxy carries to loopback. The URL answer is stored as
[`host.public`](configuration.md), the address every printed URL is
composed from.

Packages compile to `dist/` with TypeScript 7 (`npm run build`, incremental);
`npm run aivi:cli` builds first and runs the compiled artifacts — the
same files npm publishes, so local and installed behavior are identical.
Everything goes through this one script: `npm run aivi:cli -- serve`
starts the host in the foreground, and every operator command takes its
place the same way. `npm run typecheck` (`tsc --noEmit`) checks the sources against the
built declarations.

Setup is the real CLI pointed at `dev/`: `AIVI_HOME=dev` makes the home,
`AIVI_CONFIG=dev/.config/aivi.json` keeps the client record (where the host
answers, which person signs in) inside the dev home, and the `file:` specs
install your workspace packages instead of the registry — same code path a
real install runs, your local `dist/` on the end. Everything under `dev/` is
generated or yours; git tracks only the README. Setup writes the app manifest
it installs against, seeds the OpenCode shape (`opencode.jsonc`,
`.opencode/agents/`) and pins `@aivi/opencode` from npm; to run OpenCode
against your local plugin build instead, replace that spec with
`../packages/opencode/dist`.

aivi reads one **home** directory: `config.json`, `.env`, `projects/`,
`memory/` and `state/` together. Installed copies use `~/.aivi`; in this repo
`npm run aivi:cli` points `AIVI_HOME` at `dev/`. The live `dev/config.json` is
yours and aivi's to edit, and stays out of version control. Start from `{ version: 1 }`
and add what you need, or configure a channel with
`npm run aivi:cli -- add discord` (or `add slack`) — it also lists the
package in `dev/app/package.json` under `aivi-plugins`, which is what enables
the module.

Start the host. No token is needed: commands are open, and a bearer only
identifies the caller (see [secrets](../packages/host/docs/configuration.md#secrets)):

```sh
npm run aivi:cli -- serve
```

In another terminal:

```sh
npm run aivi:cli -- status
npm run aivi:cli -- jobs list
npm run aivi:cli -- runs list
npm run aivi:cli -- link discord   # mint a link code for your Discord account
```

## The assistant in OpenCode

1. With `opencode.lifecycle: "own"` (the default) `aivi serve` restarts the
   service for you after a plugin change.
   Whatever started the service, restart it after every change to the plugin
   or the host client: the long-running service keeps `@aivi/plugin/api` in
   its module cache, so a plugin that registers a new tool can still call a
   client without that method ("client.jobs is not a function", seen
   2026-09-15).
2. Open `dev/` in OpenCode v2. Its `opencode.jsonc` loads the aivi plugin
   and `.opencode/agents/` carries the agents setup seeded there:
   `assistant`, `dreamer`, and the worker files `product`, `dev`, `review`.
3. Ask it to list the projects and read a configured document.

The home is the OpenCode location, so knowledge, memory and project
directories inside it need no `external_directory` rules. Sources elsewhere
get those rules from aivi per session ([opencode](opencode.md)). With a
running service, `npm run live:opencode -- --plugin "$PWD/dev"` verifies the
real boundary (after the plugin spec points at your local build).

## A project

```sh
npm run aivi:cli -- projects add
```

`projects add` is interactive and **role-driven**: it asks the configured
**forge** to clone a checkout and the configured **tracker** to map tickets,
then writes what each hands back. With no forge configured you get a
**repo-less project** — no checkout, but its own memory and knowledge (the
shape a "research X, write it up" ticket lives in). A forge plugin
(`@aivi/forge-github`) is what brings cloning and pull requests; until it is
installed, `projects add` sets up repo-less projects. Restart `serve` and the
project is searchable with `--project <id>`. What a project is and how it is
described: [projects](projects.md).

## A chat channel

The short way: `npm run aivi:cli -- add discord` (or `add slack`). The
plugin prints how to create the platform app, asks for the tokens, verifies
each, writes `dev/config.json` and `dev/.env` itself, joins the `aivi-plugins`
list, and aivi comes back with
the module running ([operations](operations.md#plugins-aivi-add-and-aivi-remove)).

By hand: put your application and channel IDs in the `plugins.channel-discord` block
of `dev/config.json`, put `DISCORD_BOT_TOKEN` in `dev/.env`, add
`@aivi/channel-discord` to the `aivi-plugins` list in `dev/app/package.json`,
and run `serve`
as above (slash commands are registered at start)
([Discord setup](discord.md#setup)). For Slack, create the app from the
manifest in [Slack setup](slack.md#setup) (`npm run aivi:cli -- slack manifest`),
fill in the `plugins.channel-slack` block, list `@aivi/channel-slack`, and put
`SLACK_BOT_TOKEN` and
`SLACK_APP_TOKEN` in `dev/.env`.

## Then

Running it for real: [operations](operations.md). Every field: [configuration](configuration.md).

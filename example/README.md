# Example home

This directory is a complete aivi **home**: `aivi.json`, `.env`, and `state/`
together, with every feature enabled (knowledge search, dreaming, browser
control, Discord, Slack). `npm run aivi` from the repository root uses it.

## Quickstart

```sh
cp example/.env.example example/.env     # then fill in the tokens
npm run aivi -- config check
npm run aivi -- serve
```

`serve` needs `DISCORD_BOT_TOKEN` and `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN`
because Discord and Slack are enabled here. Either:

- **provide Discord**: put your application and channel IDs in `discord.json`
  and the bot token in `.env`, then register the slash commands once with
  `npm run aivi -- discord register`;
- **provide Slack**: create the app from the manifest in
  [docs/slack.md](../docs/slack.md), put your user and channel IDs in
  `slack.json` and both tokens in `.env`; or
- **disable them**: remove the `modules` block (or one of its keys) from `aivi.json`.

To keep private values out of git, copy `aivi.json` to `aivi.local.json` (and
`discord.json` to `discord.local.json`, pointing `modules.discord.config` at
it). A `*.local.json` in the home is used instead of its public twin and is
git-ignored, as is `.env`.

## What is in here

| Path | Purpose |
| --- | --- |
| `aivi.json` | Installation config: sources, projects, jobs, scheduler pools and retention, browser, Discord, Slack |
| `discord.json` | Discord access policy and IDs (placeholders) |
| `slack.json` | Slack access policy, command prefix and IDs (placeholders) |
| `.env.example` | The secrets `serve` reads from `.env` |
| `.opencode/agents/` | The `librarian` and `dreamer` agents; the home is the OpenCode location |
| `opencode.jsonc` | Loads the aivi plugin and selects `librarian` when you open this directory in OpenCode |
| `knowledge/` | Company-wide documents (`doc`) |
| `memory/` | Org memory: dreaming's `facts.md` and proposals; `memory/demo/` is the project's ([projects](../docs/projects.md)) |
| `projects/demo/` | The registered project `demo`: a plain checkout whose `docs/adr` is indexed as `decision` by convention |
| `tasks/` | Task files for `aivi jobs add` |
| `state/` | Created on first run: SQLite, search index, dreaming transcripts, Chrome profile |

Use the tools from OpenCode by opening this directory in OpenCode v2 while
`serve` runs; see [docs/opencode.md](../docs/opencode.md). This home sets
`opencode.lifecycle` to `discover` because the tests and the smoke check load
it: a checked-in example must never restart the developer's own OpenCode. The
default for a real installation is `own`; put that in your `aivi.local.json`.

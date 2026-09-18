# Example home

This directory is a complete aivi **home**: `aivi.json`, `.env`, and `state/`
together, with every feature enabled (knowledge search, dreaming, browser
control, Discord, Slack). `npm run aivi` from the repository root uses it.

## Quickstart

```sh
cp example/aivi.example.json example/aivi.json   # your live config, git-ignored
cp example/.env.example example/.env             # then fill in the tokens
npm run aivi -- config check
npm run aivi -- serve
```

`aivi.json` is the config you and aivi edit, so it is git-ignored on purpose;
`aivi.example.json` is the tracked template with placeholder ids, and the
checks read that. A fresh clone has no `aivi.json` until you copy the
template.

`serve` needs `DISCORD_BOT_TOKEN` and `SLACK_BOT_TOKEN`/`SLACK_APP_TOKEN`
because Discord and Slack are enabled in the template. Either:

- **provide Discord**: put your application and channel IDs in the
  `modules.discord` block and the bot token in `.env` (slash commands are
  registered when `serve` starts);
- **provide Slack**: create the app from the manifest in
  [docs/slack.md](../docs/slack.md), put your user and channel IDs in the
  `modules.slack` block and both tokens in `.env`; or
- **disable them**: set `modules.discord` or `modules.slack` to `false`, or
  delete the block. Presence of a block is what enables its module.

## What is in here

| Path | Purpose |
| --- | --- |
| `aivi.example.json` | The tracked template: sources, projects, jobs, scheduler pools and retention, browser, Discord, Slack — all with placeholder ids |
| `aivi.json` | Your live config (git-ignored): copy the template and put your real ids in it |
| `.env.example` | The secrets `serve` reads from `.env` |
| (no `linear` block) | Add `linear.apps` and a project's `linear.teams` to try the Linear module ([linear](../docs/linear.md)); it needs the `LINEAR_*` secrets and a public URL |
| `.opencode/agents/` | The `librarian` and `dreamer` agents; the home is the OpenCode location |
| `opencode.jsonc` | Loads the aivi plugin and selects `librarian` when you open this directory in OpenCode |
| `knowledge/` | Company-wide documents (`doc`) |
| `memory/` | Org memory: dreaming's `facts.md` and proposals; `projects/demo/memory/` is the project's ([projects](../docs/projects.md)) |
| `projects/demo/` | The project `demo`, discovered from this directory: `source/` is the checkout (its `docs/adr` is indexed as `decision` by convention), `memory/` its memory |
| `tasks/` | Task files for `aivi jobs add` |
| `state/` | Created on first run: SQLite, search index, dreaming transcripts, Chrome profile |

Use the tools from OpenCode by opening this directory in OpenCode v2 while
`serve` runs; see [docs/opencode.md](../docs/opencode.md). The template sets
`opencode.lifecycle` to `discover` because the tests and the smoke check load
it: a shipped example must never restart the developer's own OpenCode. The
default for a real installation is `own`; change that in your own `aivi.json`.

---
title: Chat and knowledge
description: Connect Discord or Slack, learn the chat commands, and shape the index aivi answers from.
order: 4
group: Use aivi
---

The chat channels and the knowledge index are the two parts most people meet first. A channel gives people a way in. The index gives aivi something useful to say.

## Connect a chat channel

Discord and Slack are modules. `aivi add` installs the package, runs its setup, verifies the platform credentials and writes the config. It ends only after the module reports itself running.

```sh
aivi add discord
```

`discord` and `slack` are short names for `@aivi/channel-discord` and `@aivi/channel-slack`. The full package names work too. The config blocks are keyed `plugins.channel-discord` and `plugins.channel-slack`.

For Slack:

```sh
aivi add slack
```

The Slack setup prints a manifest. Create the app from that manifest, then let the CLI ask for the bot token and the app token. The manifest is also available later:

```sh
aivi slack manifest
```

The dedicated pages are [Discord](plugin-discord.html) and [Slack](plugin-slack.html).

Both modules support DMs and threads. A thread keeps its own conversation and its own OpenCode session. A direct message does the same. Two threads do not share a transcript, which keeps unrelated questions from bleeding into each other.

### Linking people

A channel account must be linked to a person before aivi listens to it. Mint a code from the machine that hosts aivi:

```sh
aivi link discord
```

The command prints where to send the code. On Discord, DM the bot:

```text
/link 12345
```

The code is valid for 15 minutes and works once. Linking is also admission. An unlinked account is ignored, except when it is redeeming a code.

## Chat commands

The command set comes from the host, and each platform translates the names it exposes. This is the shared set:

| Command | What it does |
| --- | --- |
| `/new` | Starts a fresh session for the conversation. The old session stays searchable, and memory persists. |
| `/status` | Shows the server and module status. |
| `/context` | Describes the current conversation and its binding. |
| `/search QUERY [project]` | Searches the knowledge index without starting a model turn. |
| `/model [model]` | Shows or pins the model for this conversation. `default` unpins it. |
| `/stop` | Stops the running turn. Queued messages stay queued. |
| `/queue TEXT` | Puts a message behind the running turn instead of interjecting. |
| `/jobs` | Lists the next job occurrences and the last few runs. |
| `/link CODE` | Redeems a link code for the account that sent it. |
| `/help` | Lists the command names and a short description for each. |

A message that arrives while a turn is running interjects by default. The agent sees it as part of the current turn. Use `/queue` when the message should wait.

## Knowledge sources

aivi indexes what you point it at. The index is a derived store under `~/.aivi/state/`. The documents stay where they are.

Core sources cover the organization:

```json
{
  "knowledge": [
    { "id": "handbook", "path": "docs/handbook" },
    { "id": "decisions", "path": "docs/adr", "kind": "decision" },
    { "id": "notes", "path": "notes" }
  ]
}
```

Paths resolve against the aivi home, so `docs/handbook` means `~/.aivi/docs/handbook` unless you give an absolute path. The memory directory is registered automatically as the core `memory` source.

Projects add their own sources. By default, a project's `docs/` is indexed as `doc` and `docs/adr/` as `decision`. A project that needs a different convention can replace `projectDefaults.knowledge` or set its own `knowledge` list.

| Kind | What it holds |
| --- | --- |
| `doc` | Reference material: handbooks, guides and research notes. |
| `decision` | Recorded decisions. This kind is authoritative on why something changed. |
| `memory` | Facts and proposals distilled by dreaming. Dated and softer than a decision. |
| `conversation` | Indexed transcripts. Useful for detail, not authoritative. The kind is reserved for now. |
| `manual` | Documentation shipped with an installed package, indexed in place. |
| `archive` | How things used to be. Kept as history, never authoritative for the present. |

A file belongs to the most specific source that contains it. If `docs/` is a `doc` source and `docs/adr/` is a `decision` source, each ADR is indexed once as a decision. Missing directories are skipped with a warning, not treated as a failure.

## Keyword first, then semantic

Keyword search works on the first boot. It uses BM25 over the indexed text and needs no model downloads.

Semantic search adds query expansion, vector retrieval and reranking. It starts to serve after the local models are on disk:

```sh
aivi knowledge warm
```

The command fetches and loads the models, embeds the corpus, and warms the expansion and rerank paths. It is a one-time setup step per machine, and it needs to run again if you change the embedding model.

Searches do not wait on a download. While a model is missing, keyword answers alone. If a semantic step fails, the search returns keyword hits and says so once in the log.

## Refresh the index

The default is to refresh on startup. Edits and deletions appear after the next refresh, so a long-running server may need a nudge:

```sh
aivi knowledge index
```

You can also schedule it. A knowledge refresh is an operation, so it can be the task of a job. The repository's [knowledge guide](https://github.com/aivi-hq/aivi/blob/main/docs/knowledge.md) covers the full configuration and the scheduling example.

## Scope, not security

Search scope selects sources; it is not a multi-tenant boundary. A conversation with access to the project can search that project, and core sources are included unless the caller turns them off. If different teams need hard separation, run different aivi homes.

## What to read next

- [Jobs and memory](jobs-memory.html) for the nightly pass that writes and tidies memory.
- [Projects and tickets](projects.html) for the project sources and the lane config.
- [Discord](https://github.com/aivi-hq/aivi/blob/main/docs/discord.md) and [Slack](https://github.com/aivi-hq/aivi/blob/main/docs/slack.md) for platform setup and access rules.

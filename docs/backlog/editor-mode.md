# Operator tools from a conversation (editor mode)

Status: seed of an idea (owner, 2026-09-14); reshaped 2026-09-19 after the
single-app rework: the owner wants **operator tools available to the existing
agents on demand** — CLI-grade operations (adding a project, jobs, indexing)
as plugin tools, toggled per agent through its own file's permissions. The
dedicated `editor` agent is the later, stricter shell around the same tools;
the tools themselves are the first build.

## Idea

From any channel — the Linear assistant, the Discord/Slack librarian — an
operator can ask aivi to do installation work it can already do from the CLI:

- add a project (clone, register, map Linear teams and lanes, index)
- change an agent's soul, model or file; install or update a skill
- walk through dreaming's proposals and accept/reject them
- trigger indexing, cleanup; inspect status, schedules, recent outcomes
- resolve a blocked run after inspecting it

Server maintenance becomes a chat instead of SSH. The owner's phrase for the
gate: *permissions I can toggle* — the tool exists, the agent file decides.

## Why now

The rework changed the ground this page stood on:

- The **assistant** (`linear.agent`) and channel agents are the natural
  holders: they already run on the channel machinery with per-agent files, and
  the soul exists as a file an agent could maintain.
- **The CLI's operations are already library code** (`packages/core/src/projects.ts`:
  `addProject`, `writeProjectLinear`, `removeProject`, `purgeProject`), and the
  plugin already reaches the host API (`aivi_jobs` can create, run, pause,
  remove). An operator tool is mostly a thin wrapper over an existing path.
- **Linear onboarding proved the pattern live** (2026-09-19 dogfood): the
  librarian created the `needs-human` label through the Linear MCP from a
  conversation. What is missing is the aivi side (config, projects) — the
  Linear side of onboarding already works by conversation.
- The `config.json` rule has moved: "aivi and the operator edit the live
  `config.json` itself" (CONTEXT.md) — so *an agent* editing config is no longer
  conceptually forbidden; the question is which agent, with what guardrails.

## The v0 proposal: operator tools, gated by agent files

One plugin tool group (say `aivi_ops`), each action mapping 1:1 to an existing
CLI code path — no new host API, no new authority model:

| Action | Wraps | Notes |
| --- | --- | --- |
| `projects.add` | `addProject` + `writeProjectLinear` | the full `projects add` path, Linear mapping included; needs team resolution, which lives in `@aivi/linear` |
| `projects.remove` / `purge` | same-named CLI functions | `purge` keeps its `confirm` semantics: the agent must relay what goes and get an explicit yes in chat |
| `jobs.*` | exists today (`aivi_jobs`) | no new work |
| `knowledge.index` | the host operation | via the jobs path or a direct POST, as `aivi jobs run` does |
| `status` | exists today (`aivi_status`) | |

The toggle is exactly the house rule — *the agent file is the boundary*: the
shipped `librarian.md` / `aivi.md` deny the new tool id; an operator who wants
a given agent to maintain the installation removes the deny (or adds an
`allow`). No `access.editors` list, no mode switching, no new auth surface:
whoever may already talk to that agent, may now ask it for this. The deny
lives in the agent file next to every other boundary, and flipping it is one
line the operator already owns.

Guardrails that stay regardless of toggle:

- **Never silent about a restart**: config and agent-file edits still need
  `aivi serve` to restart; the agent must say so.
- **Secrets**: deny `read` on `*.env*` stays in every shipped file; the tools
  never return config values that are secrets (redact like `/status` does).
- **Purge/delete**: only with a human "yes" quoted in the conversation, and
  the tool takes a `confirm` flag the agent fills from it — same discipline as
  `aivi purge --confirm`.
- **One write per turn shown**: the reply names what changed (the transcript
  is the audit), as editor-mode already proposed for souls and skills.

## The later shell: a dedicated editor agent

What the original idea adds on top, kept here for when the simple tools prove
themselves insufficient: a separate `editor` agent (host-pinned policy like
dreaming's, DM-only entry via `/editor`, one exception to "no agent
switching"), for the cases that need more than a tool toggle — editing any
`*.json` under the config directory, shell, `aivi update`, restart. Its v1
operations table and write boundary below remain the reference for that shape.

| Operation | How | v1 |
| --- | --- | --- |
| status: schedules, recent outcomes, blocked turns, index freshness | `aivi_jobs` (list) + `aivi_status` | yes |
| trigger index / dreaming / system check | `aivi_jobs` enqueue, limited to configured kinds | yes |
| review dreaming proposals | agent edits `<memory>/rules.md` and `<memory>/proposals/*` | yes |
| edit a soul or its model | agent edits `<dir>/.opencode/agents/*.md`, never `editor.md` itself; the soul is `<home>/soul.md` since 2026-09-19, injected and hot-reloaded — an editor may edit it as a file | yes |
| install / update a skill | agent writes `<dir>/.opencode/skills/**` from pasted text | yes |
| add project | `aivi_ops.projects.add` (the tool above) | yes |
| clone repository, `aivi update`, cleanup, restart | none | defer |

Entering: `access.editors: [userId]` on the shared access policy; absent means
off. `/editor [text]` accepted only in a DM from an editor; behaves like
`/new` with a different fixed agent; one-shot with text. No channel or thread
ever enters editor mode.

## Questions

- **Toggle vs mode — the central open question.** Two shapes for giving an
  agent operator powers: (a) *tool toggle*: the tool always exists in the
  plugin; a shipped agent file denies it, the operator flips one line to
  grant it — granted ahead of time, not mid-conversation; (b) *a mode*: a
  dedicated `editor` agent entered on demand (`/editor`), which is the only
  way to get tools a session did not start with — OpenCode fixes a session's
  tools at its agent, so "inject tools on demand" would need an agent switch
  (a fresh session), which is work the channel machinery already knows how to
  do (`/new` with a different fixed agent) but adds an entry/exit concept.
  Owner's instinct: a mode is fine too, but suspects OpenCode does not
  support true mid-session tool injection and does not want to build agent
  switching just for this. Settle here first: if toggling pre-granted tools
  in agent files is enough (and "the deny lives in the file I already own" is
  the UX), (a) wins on simplicity; if asking *inside* a conversation ("may I
  add a project?" → granted for this exchange) is wanted, that is (b) plus a
  `permission.ask` route to the chat, which is a bigger build.

- Does `aivi_ops` belong in the plugin (tool surface) or as host API only,
  called through Code Mode? Plugin: it inherits session identity and the
  permission gate for free.
- Should `projects.add` resolve Linear teams itself (import from
  `@aivi/linear`'s client) or ask the operator for raw team ids?
- Does the assistant ever get `edit` on `config.json` directly (the
  "config is yours and aivi's" decision), or only through narrow tools?
  The editor-mode answer was "never from a chat"; the newer CONTEXT decision
  softens that. Settle before shipping any config-write surface.
- Does a Linear agent session need `permission.ask` routing (currently
  auto-rejected for workers) before any destructive action is allowed?
- If a mode is chosen: is `/editor` DM-only as researched, or may the Linear
  assistant carry it too (a delegation the operator confirms in chat)?
- Relation to [dashboard](dashboard.md) (read-only viewing of the same data).

## Research

Done 2026-09-14.

**OpenClaw** (https://docs.openclaw.ai/tools/slash-commands) exposes
self-maintenance from chat as owner-only commands that are *off by default*:
`/config show|get|set|unset` writes `openclaw.json` after schema validation,
`/plugins install|enable|disable`, `/mcp`, `/update` and `/restart`, `/learn`
(drafts a reviewable skill from the conversation), `/dreaming on|off`, and a
natural-language `/openclaw <request>` "setup and repair helper" that only
runs from an owner DM. Authorization is a dedicated `commands.ownerAllowFrom`
list, separate from channel allow-lists; authorized non-owners get a refusal
that names the exact config line to add. Lessons: a separate owner list,
deterministic commands for the dangerous writes plus an agent for the rest,
validation before every write, DM-only, and disabled until configured.

**OpenCode v2.** Agents are Markdown files with frontmatter `permissions`
(ordered rules, last match wins; `edit` matches the target path, `shell`
matches best-effort command text, `external_directory` gates paths outside the
Location; `ask` is decided by the client; `steps` caps a turn; `hidden` is not
security) at https://opencode.ai/v2/docs/agents and
https://opencode.ai/v2/docs/permissions. Skills are `.opencode/skills/<id>/
SKILL.md`, loaded through the `skill` tool and gated per ID by the `skill`
action; extra directories or HTTP catalogs come from a `skills` array
(https://opencode.ai/v2/docs/skills). aivi already pins a per-session policy
from the host: `dreaming.ts` denies everything, allows the read tools, grants
`external_directory` for the memory directory and allows `edit` only on
`facts.md` and `proposals/*`. Both unattended paths auto-reject `ask` because
nobody is at the server — which is why the operator tools above are
allow/deny in agent files, and `ask`-in-chat stays a deferred upgrade.

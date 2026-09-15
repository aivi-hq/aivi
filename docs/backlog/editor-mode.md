# Editor mode: maintaining aivi from a conversation

Status: seed of an idea (owner, 2026-09-14). Research and shape before building.

## Idea

From any communication channel (not email), a user with the right access can
switch a conversation into *editor mode*: a fresh session with a different
agent whose skills and tools maintain the installation itself. Examples of what
it should be able to do:

- add a project (clone into the projects directory, register, index)
- change an agent's soul or model, install or update a skill
- walk through the skill-workshop proposals from dreaming and accept/reject them
- trigger indexing, cleanup, or `aivi update`
- show status, schedules, recent outcomes

Could be one-shot ("add project X") or a session. It would make server
maintenance a chat instead of SSH.

## Why it fits the thin core

Everything above is an OpenCode agent with tools: the host only has to expose
the operations (host API endpoints or plugin tools) and the access rule. No new
UI, no new runtime.

## Questions

- Who may enter editor mode (a role in the access policy)?
- Which operations are safe unattended, which need confirmation in chat?
- Does the editor agent run in a dedicated OpenCode location (`~/.aivi/`) with
  edit rights only there and in the projects directory?
- How does it relate to `/new` and to the one-librarian-per-bot rule?

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
that names the exact config line to add. Config written from a group is routed
privately to the owner. Lessons: a separate owner list, deterministic commands
for the dangerous writes plus an agent for the rest, validation before every
write, DM-only, and disabled until configured.

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
`facts.md` and `proposals/*`. The librarian session in `discord/native.ts`
is the read-only counterpart. Both auto-reject `ask` because nobody is at the
server; the "fixed agent and directory" check per conversation means editor
mode is necessarily a separate native session.

## Recommendation

**Scope (v1).** One agent, `editor`, defined next to `librarian` and `dreamer`
in the adapter's OpenCode directory, running in that same Location. Operations:

| Operation | How | v1 |
| --- | --- | --- |
| status: schedules, recent outcomes, blocked turns, index freshness | new plugin tool `aivi_jobs` (list) + existing `aivi_status` | yes |
| trigger index / dreaming / system check | `aivi_jobs` enqueue, limited to task kinds already configured | yes |
| review dreaming proposals | agent edits `<memory>/rules.md` and `<memory>/proposals/*` | yes |
| edit a soul or its model | agent edits `<dir>/.opencode/agents/*.md`, never `editor.md` itself | yes |
| install / update a skill | agent writes `<dir>/.opencode/skills/**` from text the user pastes; URLs only after the user has seen the fetched content | yes |
| add project | new plugin tool `aivi_projects_add {id, directory}`: host validates the directory, appends to `projects[]`, writes `aivi.project.json`, indexes | register-only |
| clone repository, `aivi update`, cleanup, restart | none | defer |

**Entering and leaving.** `access.editors: [userId]` is added to the shared
`accessPolicySchema`; absent means the feature is off. `/editor [text]` is
accepted only in a DM from an editor. It behaves like `/new` with a different
fixed agent: the store records `mode: "editor"` for that DM, the next messages
run against a fresh native session (`metadata.aivi.origin: "editor"`, excluded
from dreaming's default `origins`), and `/editor off` or `/new` returns to the
librarian. With text it is one-shot: one turn, then back. No channel or thread
ever enters editor mode, so a group never sees configuration. This is the one
exception to "no `/agent` switching": a maintenance mode, not a personality.

**Write boundary (host-pinned per session, as in `dreaming.ts`).** Deny all;
allow `read`, `glob`, `grep`, `execute`, `skill`, `webfetch`, `websearch`,
`knowledge_search`, `aivi_sources`, `aivi_status`, `aivi_jobs`,
`aivi_projects_add`; deny `read` on `*.env*`; `external_directory` for the
config directory (`dirname(loaded.path)`), the memory directory and the
projects directory; `edit` allowed only on `<dir>/.opencode/agents/*.md`,
`<dir>/.opencode/skills/**`, `<memory>/rules.md`, `<memory>/proposals/*`, then
`edit` denied again on `<dir>/.opencode/agents/editor.md`. `shell` and
`subagent` stay denied. `aivi.json` and adapter configs are never editable by
the model: the only config write is the typed `aivi_projects_add` operation,
validated by the host with the same zod schema. `steps` is capped in the
agent file. After each turn the host snapshots the writable trees (reuse
dreaming's `snapshot`) and appends the changed-file list to the reply, so the
transcript is the audit.

**Confirmation.** `ask` cannot be honoured today, so v1 splits by risk rather
than prompting: low-risk writes (souls, skills, proposals → rules, enqueue,
register project) are `allow`, with a soul rule to show the change before
writing; everything else is `deny`, which needs no confirmation because it is
impossible. Things that must require an explicit yes before they are ever
allowed: changing access policies or any `*.json` under the config directory,
any `shell`, deleting or renaming files, installing a skill from a URL the
user did not paste, changing the editor's own file, `aivi update`/restart.

**Defer.** Routing `ask` to the chat as a yes/no (unlocks config edits and
shell allow-lists), `git clone` for add-project, hot reload of `aivi.json`
(today a restart is required and the editor must say so), `/restart` and
`aivi update` (belong to `docs/backlog/installation.md`), per-editor audit
beyond session metadata, and any editor access from channels or email.

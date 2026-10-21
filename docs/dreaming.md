# Dreaming

Dreaming is aivi's memory consolidation: a scheduled agent turn that reads the
conversations people had with aivi since the last run and distils what should be
remembered into plain markdown files. Those files sit in `<home>/memory` (the
org) and `<home>/projects/<id>/memory` (one per project), which are always `memory`
knowledge sources, so they are indexed and searchable like any other document,
and the assistant retrieves them through `knowledge_search` when relevant.
Memory never goes into a system prompt, so prompt caches stay warm and the
assistant's soul stays stable.

## How a run works

1. The job fires (or `aivi jobs add` with a `dreaming` task).
2. The host reads the cursor for the memory directory: the newest session
   update it has already reviewed.
3. It lists OpenCode sessions newer than that whose `metadata.aivi.origin` is
   in `origins` — an empty `origins` (the default) is **every channel module
   registered when the run starts, plus every platform a voice room has
   opened under** (`meet`, Discord voice: rooms are doors people speak
   through, so their conversations are reviewed like any channel's). A
   `dreaming` origin can never be configured: dreaming reviews conversations,
   never its own runs. It takes the oldest `maxSessions` and pulls their
   new messages (user text and the agent's answers; no tool output or
   reasoning).
4. It runs **one dreamer turn per session, oldest first**, through the session
   driver. Each turn gets its own transcript file under
   `<stateDirectory>/dreaming/` (named `<run>-<session>.md`). The agent file is
   the boundary (the seeded dreamer denies edit, shell and subagents); the job
   adds only `external_directory` allows for the transcript and every memory
   home, and `edit` allows for `facts.md`, `archive.md` and `proposals/*` in
   each of them, which win over the agent's `edit: deny` because session
   rules come last. The transcript is the dreamer's convenience input: each
   turn's transcript is deleted when its turn succeeds (the OpenCode sessions
   are the record); a failed turn keeps its own for the post-mortem. The prompt
   names the org memory and
   each project's; the dreamer decides
   where a fact belongs. Permission
   prompts are rejected. Paths are canonical (`realpath`), as OpenCode matches
   them. The job row carries the native session id before the first request, so
   `aivi runs show` points at the session to inspect if the run blocks.
5. It records which memory files changed across the run's turns
   (`facts.md`, `demo/facts.md`, …),
   advances the cursor after **each** turn to that session's update, refreshes
   the search index, and reports the turns' summaries to the configured
   destination.

Nothing new since the cursor means no model call. A failed or timed-out turn
blocks the job; the cursor stands at the last session that finished, so the
next run resumes with the failed one, not the whole backlog. There is never a
duplicate write from a retry because the agent reconciles against the current
file before writing.

## Memory contract

The dreamer's soul (`packages/cli/templates/agents/dreamer.md`, seeded into
every home's `.opencode/agents/`) carries
the judgement: what to keep, how to write it, what to leave out. The host only
enforces the boundary. Files:

| File | Written by | Purpose |
| --- | --- | --- |
| `facts.md` | dreaming | Current truth only: dated, attributed bullets grouped by topic. Superseded wording moves to `archive.md` — no struck-through text, no "used to be". The org's in `memory/`, each project's in `projects/<id>/memory/` |
| `archive.md` | dreaming | How things used to be: retired facts appended with their dates and what replaced them. Indexed as the `archive` kind: searchable history, never authoritative for the present. Per memory home |
| `proposals/rules.md` | dreaming | Red lines and conventions people stated, quoted with date and speaker. Not in force until a human moves them. Per memory home, like `facts.md` |
| `proposals/skills.md` | dreaming | Repeatable tasks worth turning into skills. |
| `rules.md`, agent files, skills | humans | The soul. Dreaming cannot write here. |

Reviewing proposals is a human conversation: "let's go through what you think
should be rules" is the intended workflow.

## Configuration

```json
{
  "id": "dreaming",
  "cron": "0 3 * * *",
  "timezone": "Europe/Amsterdam",
  "pool": "default",
  "task": {
    "kind": "invocation",
    "name": "dreaming",
    "args": {
      "origins": ["discord"],
      "maxSessions": 50
    }
  },
  "report": { "to": "channel", "module": "discord", "channel": "<channel id>", "on": "always" }
}
```

`origins` is omitted in the common case: empty means every channel module
registered when the run starts plus every platform a voice room has opened
under, so this same job reviews Slack in a Slack-only home and Meet once a
meeting has run. `dreaming` may never be named: a dreamer reading its own
dreams would invent memory.

`memoryDirectory` defaults to `<home>/memory`, the org memory, which is always
a core `memory` source ([projects](projects.md)); another directory must be
inside a core knowledge source (the run fails with that reason otherwise; the
args are the dreaming operation's own, opaque to the config). `agent` names an agent in the home's `.opencode/agents/` (set
`directory` for an agent defined elsewhere). The dreamer picks its model in
its own frontmatter; replace the file to change how memory is kept.

The dreamer is meant to run through this job: the job appends the session rules
that allow its two write targets. Opened interactively, the seeded dreamer can
read but not write (`packages/cli/templates/agents/dreamer.md`); a home's copy
is the owner's to edit, and `aivi setup` never overwrites one that exists.

## Later

Per-person memory once identities are linked, memory decay, and a queue-aware
schedule that waits for quiet hours instead of a fixed cron
([projects-and-capacity](backlog/projects-and-capacity.md)).

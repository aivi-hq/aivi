# Dreaming

Dreaming is aivi's memory consolidation: a scheduled agent turn that reads the
conversations people had with aivi since the last run and distils what should be
remembered into plain markdown files. Those files sit inside a core knowledge
source, so they are indexed and searchable like any other document, and the
librarian retrieves them through `knowledge_search` when relevant. Memory never
goes into a system prompt, so prompt caches stay warm and the librarian's soul
stays stable.

## How a run works

1. The schedule fires (or `aivi jobs enqueue` with a `dreaming` task).
2. The host reads the cursor for the memory directory: the newest session
   update it has already reviewed.
3. It lists OpenCode sessions newer than that whose `metadata.aivi.origin` is
   in `origins` (Discord conversations by default; worker jobs are noise), takes
   the oldest `maxSessions`, and pulls their new messages (user text and the
   agent's answers; no tool output or reasoning).
4. It writes one transcript file under `<stateDirectory>/dreaming/` and runs
   the dreamer agent through the session driver. The agent file is the
   boundary (the example dreamer denies edit, shell and subagents); the job
   adds only `external_directory` allows for the memory and transcript
   directories and `edit` allows for `facts.md` and `proposals/*`, which win
   over the agent's `edit: deny` because session rules come last. Permission
   prompts are rejected. Paths are canonical (`realpath`), as OpenCode matches
   them. The job row carries the native session id before the first request, so
   `aivi jobs show` points at the session to inspect if the run blocks.
5. It records which memory files changed, advances the cursor to the newest
   reviewed session, refreshes the search index, and reports the agent's
   summary to the configured destination.

Nothing new since the cursor means no model call. A failed or timed-out turn
blocks the job without advancing the cursor, so the next run reviews the same
conversations again; there is never a duplicate write from a retry because the
agent reconciles against the current file before writing.

## Memory contract

The dreamer's soul (`example/.opencode/agents/dreamer.md`) carries
the judgement: what to keep, how to write it, what to leave out. The host only
enforces the boundary. Files:

| File | Written by | Purpose |
| --- | --- | --- |
| `facts.md` | dreaming | Dated, attributed bullets grouped by topic. Superseded facts are struck through, never deleted. |
| `proposals/rules.md` | dreaming | Red lines and conventions people stated, quoted with date and speaker. Not in force until a human moves them. |
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
  "resource": "local-model",
  "task": {
    "kind": "dreaming",
    "memoryDirectory": "knowledge/memory",
    "origins": ["discord"],
    "maxSessions": 50
  },
  "report": { "to": "discord", "channel": "<channel id>", "on": "always" }
}
```

`memoryDirectory` must be inside a core knowledge source (configuration fails
otherwise). `agent` names an agent in the home's `.opencode/agents/` (set
`directory` for an agent defined elsewhere). The dreamer picks its model in
its own frontmatter; replace the file to change how memory is kept.

The dreamer is meant to run through this job: the job appends the session rules
that allow its two write targets. Opened interactively, the example agent can
read but not write (`example/.opencode/agents/dreamer.md`). The
example home schedules it next to Discord, which is where its default
`origins` come from.

## Later

Project-scoped memory (facts that belong to one project's repository;
[project-memory](backlog/project-memory.md)), per-person
memory once identities are linked, memory decay, and a queue-aware schedule that
waits for quiet hours instead of a fixed cron
([projects-and-capacity](backlog/projects-and-capacity.md)).

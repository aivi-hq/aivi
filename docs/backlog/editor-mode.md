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

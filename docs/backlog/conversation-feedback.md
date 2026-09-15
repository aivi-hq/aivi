# Conversation feedback: nobody waits in silence

Status: principle agreed (2026-09-15); the minimum is built, the rest is wanted.

## Principle

Every state change a person is waiting on gets a visible signal. Silence is
never the answer, whether the cause is a queue, a failure, a restart, or a
shutdown.

## Built

- Typing indicator while the agent works (Discord).
- A turn that never reached the agent: "please send that again" and capacity
  released.
- A turn that could not be finished: "an operator has been notified"; the
  conversation waits until the turn is resolved.
- A message with attachments or no text: "text only" reply.
- Queued behind other work: a ⏳ reaction (a one-line reply where the bot may
  not react), removed when the turn starts.
- Restart during a turn: the turn is discarded, capacity released, and the
  conversation told once (resend, or "my last answer may be incomplete").

## Wanted

- **Progress while the agent works** (owner, 2026-09-15): the typing
  indicator says "alive", not "what". Show the turn's tool calls in the thread
  as they happen ("searching knowledge…", "reading handbook.md", "running
  script"), configurable per channel (off / tool names / tool names with
  arguments), and periodic "still working on X" updates for long turns.
  OpenCode's event stream (`client.event.subscribe()`) carries tool state
  changes live; a placeholder message edited in place (below) is the natural
  surface, so both land together.
- A placeholder message that is edited as the turn progresses or is retried,
  instead of a new message per state.
- Shutdown and restart notices to every conversation with active or queued
  work ([shutdown-hooks](shutdown-hooks.md)), and "a turn was interrupted"
  after restart recovery.
- The same signals for job reports: a blocked job's report should say what
  the operator has to do.

- Queued behind *blocked* work: ⏳ promises movement that will not come
  without an operator; say so instead ("waiting on an operator").

## Decided against

- Queuing a message while OpenCode is down. Considered 2026-09-15; the owner
  prefers the current "please send that again in a moment": simpler, honest,
  no retry policy to explain.

## Constraints

- Proactive posts respect each destination's policy: only where aivi already
  takes part in the conversation, or `reportChannels`.
- Notices are best effort; a failed notice is logged, never blocks a turn, and
  never changes a turn's state.
- Wording stays plain and short; no stack traces or provider error bodies.

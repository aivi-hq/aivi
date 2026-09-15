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

## Wanted

- OpenCode unreachable: today the message is discarded with "please send that
  again". People expect it to be queued (observed 2026-09-15). Better: keep it
  queued, say "my agent runtime is unreachable; I will answer when it is
  back", and let the next tick retry. Per-turn discovery makes the retry
  free; the open question is only how long to wait before giving up.
- Queued behind other work: a short acknowledgement or reaction so a wait is
  distinguishable from silence (needs the Add Reactions permission; see
  [chat-commands](chat-commands.md)).
- A placeholder message that is edited as the turn progresses or is retried,
  instead of a new message per state.
- Shutdown and restart notices to every conversation with active or queued
  work ([shutdown-hooks](shutdown-hooks.md)), and "a turn was interrupted"
  after restart recovery.
- The same signals for job reports: a blocked job's report should say what
  the operator has to do.

## Constraints

- Proactive posts respect each destination's policy: only where aivi already
  takes part in the conversation, or `reportChannels`.
- Notices are best effort; a failed notice is logged, never blocks a turn, and
  never changes a turn's state.
- Wording stays plain and short; no stack traces or provider error bodies.

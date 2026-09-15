# Conversation feedback: nobody waits in silence

Status: principle agreed (2026-09-15); the minimum and progress are built, the
rest is wanted.

## Principle

Every state change a person is waiting on gets a visible signal. Silence is
never the answer, whether the cause is a queue, a failure, a restart, or a
shutdown.

## Built

Everything a person waits on has a signal today; the list is owned by
[channels.md](../channels.md#feedback-and-recovery-shared) (queue, working,
progress placeholder, failure, restart notices).

## Wanted

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

# Rate-limiting the front door

Status: idea, unscheduled, no owner.

## The idea

The request diary (see [operations.md](../operations.md)) makes floods
visible after the fact; nothing stops them while they happen. An unbounded
stream of arrivals — a platform retry storm, a curious scanner, a client in
a loop — costs the host a row, a body read and its attention every time.
Put a bound at the door: refuse over-limit requests with a 429 and an honest
`Retry-After`, per client and maybe per path, with `/health` and `/version`
never limited because supervisors and negotiation must answer whatever else
is wrong.

## What is not settled

Whether the limiter sits before or after the diary: before, and the flood
costs nothing but stays invisible; after, and the diary keeps its evidence
at the cost of a row per refusal. The decision belongs to whoever builds it.
What is settled: no limit is derived from configuration that is not there;
whatever bound exists is a stated knob with a stated default.

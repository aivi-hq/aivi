/**
 * The orchestrator's own vocabulary: what a **run** is, in platform-neutral
 * words. A run is one attempt at one ticket — not the ticket (which outlives
 * it) and not any tracker's session. The stages a tracker answers for live
 * to lives in `@aivi/plugin` (run-events); this file holds the shapes the
 * orchestrator itself records and hands out.
 *
 * Core words are `tracker` and `forge`, never a platform's name: Linear, Jira
 * and GitHub Issues all spell these differently on their own side, and nothing
 * here notices which one is speaking. The orchestrator knows tickets, lanes
 * and OpenCode — a conversation string is no orchestrator fact, and delivery
 * of anything to a platform is the follower's own business.
 */

/**
 * A run's life, as the orchestrator holds it. There is **no capacity gate in
 * this version**: admission and a lease arrive with the dispatcher, so
 * `preparing` is entered the moment work is requested and only ever means
 * "the work environment and session are being made".
 *
 * - `preparing` — requested; the work environment and the session are being made.
 * - `working` — a turn is running or queued.
 * - `awaiting_input` — parked on an open elicitation: the OpenCode form is
 *   the durable record of the wait; the keep-alive says how long the slot
 *   is held for it, and after that the ticket waits without one. The run
 *   keeps its session and its claim either way.
 * - `completed` / `failed` / `cancelled` — terminal; only a completion tool
 *   call, a failure, or a stop puts a run here. Never a text, never idleness.
 */
export type RunState = 'preparing' | 'working' | 'awaiting_input' | 'completed' | 'failed' | 'cancelled';

/** Terminal means nothing more can happen to this run. */
export function isTerminal(state: RunState): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}

/** One question's options, in neutral words; a follower renders them its way
 *  (Linear shows its `select` signal, GitHub a numbered comment). */
export interface RunOption {
  label: string;
  value: string;
}

/**
 * A question the worker asked. `formId` is the OpenCode session form that
 * holds the durable copy: the worker created it through `ask`, it reads
 * `pending` until a human answers it, and it is the *discriminator* between
 * an answer and an interjection. The form is the record; this is the
 * rendering a follower shows.
 */
export interface RunQuestion {
  question: string;
  options?: RunOption[];
  formId?: string;
}

/**
 * What the completion tool says the worker did, and the reason a run ends.
 * This is an application protocol, not an OpenCode type: the worker authored
 * it, the orchestrator parsed and validated it, and a follower decides how —
 * and whether — to show it. `success` and `failure` are the worker's
 * knowledge; which lane each lands the ticket in is the orchestrator's lane
 * config, never the worker's report.
 */
export type RunOutcome = { kind: 'success'; summary: string } | { kind: 'failure'; reason: string; code?: FailureCode };

/** Why aivi — not the worker — ended a run, in machine-readable words: a
 *  tracker renders help for its platform from the code, never by reading
 *  English. `kill-unconfirmed`: the dispatcher struck the session the
 *  configured number of times and it would not die; the person watching
 *  the ticket should know a worker may still be loose. */
export type FailureCode = 'kill-unconfirmed';

/**
 * A run as anyone outside the orchestrator may read it: enough to speak
 * about one, never enough to drive it. It names the ticket, not a tracker's
 * session — the follower holds that pair in its own store.
 */
export interface RunView {
  readonly id: string;
  readonly projectId: string;
  readonly trackerId: string;
  readonly ticketId: string;
  readonly lane: string;
  readonly agent: string;
  readonly state: RunState;
  readonly sessionId?: string;
  /** The directory the worker works in: the checkout, or a worktree later. */
  readonly worktree?: string;
  readonly outcome?: RunOutcome;
  /** The lane the lane order chose for a finished run's ticket: the
   *  orchestrator's decision; performing the move is the follower's. Absent:
   *  the ticket stays — a stop moves nothing, an unmapped lane goes silent. */
  readonly targetLane?: string;
  /** When the run last changed: a follower's rendering watermark reads
   *  endings through it, so nothing that arrived while aivi slept is
   *  missed and nothing already rendered is said twice. */
  readonly updatedAt: number;
}

/**
 * The worker's plan: a session-level checklist it keeps current while it
 * works, in neutral words. `content` is the step; `status` where it stands.
 * The whole array arrives at every update — replacing the plan wholesale is
 * the shape the platforms that render one (Linear's agent plan) accept, and
 * it keeps the worker's tool honest: no diffing, no partial truths.
 */
export interface RunPlanStep {
  content: string;
  status: 'pending' | 'inProgress' | 'completed' | 'canceled';
}
export interface RunPlan {
  steps: RunPlanStep[];
}

/**
 * The run's lifecycle belongs to the **tracker stages**, declared where a
 * tracker author imports them: `@aivi/plugin` (work). The orchestrator
 * calls them in order and awaits only the lifecycle ones; there is no
 * event bus to subscribe to — a tracker that answers for a stage hears
 * it, one that does not loses nothing the orchestrator cares about.
 */

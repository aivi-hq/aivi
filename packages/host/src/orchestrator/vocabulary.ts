/**
 * The orchestrator's own vocabulary: what a **run** is, in platform-neutral
 * words. A run is one attempt at one ticket — not the ticket (which outlives
 * it) and not any tracker's session. The shared event a follower subscribes
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
 * - `working` — a turn is running, queued, or parked on an open question: the
 *   OpenCode form is the whole truth of waiting, read from OpenCode, never
 *   mirrored here. (An `awaiting_input` state returns with the later refactor
 *   that puts a keep-alive timeout on an open elicitation.)
 * - `completed` / `failed` / `cancelled` — terminal; only a completion tool
 *   call, a failure, or a stop puts a run here. Never a text, never idleness.
 */
export type RunState = 'preparing' | 'working' | 'completed' | 'failed' | 'cancelled';

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
export type RunOutcome = { kind: 'success'; summary: string } | { kind: 'failure'; reason: string };

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
 * What a subscriber to the orchestrator's runs receives — typed once here and
 * re-exported by `@aivi/plugin` (run-events) so a tracker subscribes without
 * knowing the host's internals. The orchestrator orchestrates: it never calls
 * a tracker and never learns which platform is listening. It emits these
 * facts as its runs change, and a tracker that wants to follow renders them
 * in its own platform, in its own time, retrying its own failures. A tracker
 * that listens to nothing loses nothing the orchestrator cares about.
 */
export type RunEvent =
  /** The worker session exists: the follower records the pair
   *  (ticket ↔ its platform's session ↔ the OpenCode session) here. */
  | { type: 'started'; run: RunView }
  /** The `ask` tool created the durable OpenCode form. Question support is
   *  required of every tracker; the shape (elicitation, label, comment) is
   *  the tracker's own. */
  | { type: 'question'; run: RunView; question: RunQuestion }
  /** The `plan` tool posted the checklist as it now stands: a forwarding,
   *  never owed. A tracker without a plan surface drops it. */
  | { type: 'plan'; run: RunView; plan: RunPlan }
  /** The run ended — completion tool, failure, or stop. `targetLane` is
   *  where the lane order says the ticket goes (absent: nowhere — a stop
   *  moves nothing, and an unmapped lane goes silent). Catching the
   *  platform up is the follower's ceremony, in the follower's order. */
  | { type: 'ended'; run: RunView; outcome: RunOutcome; targetLane?: string };

export type RunEventListener = (event: RunEvent) => void | Promise<void>;

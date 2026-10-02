/**
 * The work a tracker answers for: the **stages** the orchestrator walks a
 * run through, and the board it walks for work. Division of labour, said
 * as an interface: the orchestrator orchestrates and never learns what a
 * ticket platform is; the tracker tracks and answers for its platform
 * alone. A tracker module registers ONE of these at start; the
 * orchestrator calls the stages in the documented order and awaits only
 * the lifecycle ones (`initWork`, `endWork`): their failure is the run's
 * failure, said visibly. The renders (`ready`, `startWork`, `question`,
 * `plan`) are fire-and-forget — a platform that cannot show a thing loses
 * nothing the orchestrator cares about, and a tracker retries its own
 * renders in its own time.
 *
 * `initWork` is where a tracker does whatever its platform needs to open
 * a ticket to work — Linear delegates the issue to its own app and
 * Linear's answer carries the new agent session — and it hands back the
 * ticket's **summary**: the words the worker is started with, composed
 * around the directory and the lane by the orchestrator, which never
 * reads a ticket itself. A tracker that needs nothing answers with the
 * ticket's text alone.
 *
 * The run's shapes are the orchestrator's (it owns the run); this file
 * names only what its stages carry, type-only: the kit never depends on
 * the host at runtime.
 */
import type { RunPlan, RunQuestion, RunView } from './vocabulary.ts';

export interface Tracker {
  /** The module id this tracker speaks for (`tracker-linear`): the key
   *  the orchestrator records claims and queue places under. */
  readonly id: string;

  /** The projects this tracker speaks for, by core id: what a walk
   *  visits. */
  projects(): string[];
  /** Tickets sitting in a lane, in the board's own top-to-bottom order.
   *  `blocked` says a person's move is awaited, whatever the platform
   *  calls it; blocked tickets wait and are never claimed. */
  tickets(projectId: string, lane: string): Promise<{ id: string; blocked: boolean }[]>;
  /** Move a ticket into a lane: the queue pickup says it before the
   *  worker starts, an ending moves the ticket where the lane order put
   *  it. The orchestrator's decision; the tracker performs it. */
  moveTo(projectId: string, ticketId: string, lane: string): Promise<void>;

  /** The dispatcher's slot is in hand and the run is claimed: open the
   *  ticket to work on the platform and return its summary. Linear's
   *  delegate mutation creates the agent session and its answer serves
   *  as the summary; the tracker stores the pair and may already post a
   *  first word ("preparing the workspace"). Failure fails the run —
   *  visibly, and the slot goes back. AWAITED. */
  initWork(run: RunView): Promise<string>;
  /** The worker's session exists and its work environment is ready:
   *  where a tracker attaches the run to the pair it opened at
   *  `initWork`. A render. */
  ready(run: RunView): void | Promise<void>;
  /** The task went into the session and work is turning. Optional: a
   *  platform whose session already shows life (Linear watches its own
   *  agent sessions) says nothing here. */
  startWork?(run: RunView): void | Promise<void>;
  /** The worker asked a person a question and parked. **Required of
   *  every tracker**: the OpenCode form is the durable record of the
   *  wait, but only the tracker knows what a question looks like on its
   *  platform. A render. */
  question(run: RunView, question: RunQuestion): void | Promise<void>;
  /** The worker's working plan, whole as it stands. Optional: a platform
   *  without a plan surface drops it. A render. */
  plan?(run: RunView, plan: RunPlan): void | Promise<void>;
  /** The run ended: say so where people read — the closing words in the
   *  shape the platform gives endings (Linear responds its agent
   *  session, which ends it). The move to the next lane is the
   *  orchestrator's and happens after this returns; the lease returns
   *  last. A permanent failure here does not hold the ticket: the
   *  ending failed is said and the person is asked for help (a tracker
   *  marks its ticket for a human, in its platform's words), while the
   *  closing stays owed to the tracker's own retries. AWAITED. */
  endWork(run: RunView): Promise<void>;
}

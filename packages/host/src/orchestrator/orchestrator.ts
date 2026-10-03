import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import type { GitIdentity, Logger, ProjectLane, PromptName, ToolDescriptor } from '@aivi/core';
import { errorMessage, fillPrompt, promptDefaults } from '@aivi/core';
import type { ForgeOwner, Forges, PrFacts, ReviewFacts } from '@aivi/plugin/forge';
import type { OpenCodeClient, Orchestrator as OrchestratorApi, SessionEvents, ToolHandler } from '@aivi/plugin/module';
import type {
  FailureCode,
  RunOutcome,
  RunPlan,
  RunPlanStep,
  RunQuestion,
  RunView,
  WorkRequest,
} from '@aivi/plugin/run';
import { isTerminal } from '@aivi/plugin/run';
import type { Tracker, WorkEntry } from '@aivi/plugin/tracker';
import type { Dispatcher, DispatcherLease } from '../dispatcher/dispatcher.ts';
import { ToolError } from '../tools.ts';
import type { Run, RunLedger } from './ledger.ts';
import { view } from './ledger.ts';
import { ensureWorktree, removeWorktree, worktreePathFor } from './worktree.ts';

/**
 * The orchestrator: the one authority that turns a ticket into a **run**. It
 * owns the run's state machine and nothing else — no platform vocabulary, no
 * webhooks, no rendering, no delivery. It knows tickets, lanes, OpenCode and
 * leases. A tracker module registers **stages** (`@aivi/plugin`, work): the
 * orchestrator walks every run through them — `initWork` to open the ticket
 * on the platform, `ready` and `startWork` as the worker comes to life,
 * `question` when a person is asked, `endWork` when the run ends — and never
 * learns what a ticket platform is. The lifecycle stages are awaited (their
 * failure is the run's failure); the renders are not (a tracker retries its
 * own, in its own time).
 *
 * **No capacity gate in this version** (ruled 2026-09-30): every requested
 * run is prepared and started at once; admission arrives with the dispatcher
 * as a lease column here, changing nothing about a run's identity.
 *
 * The whole design turns on one rule: **only a tool call ends a run.** A
 * turn ending, a message, and runtime idleness are never completion. The
 * tools arrive with a trusted `sessionId`, which is how a call finds its
 * run — never the model's word. A waiting run is not a state to maintain:
 * the OpenCode form is the record of a question, read from OpenCode when a
 * turn ends, never mirrored in the ledger.
 */

/** What a lease request waiting in a dispatcher queue is for. A walk
 *  request re-reads its first message when the lease lands (the ticket may
 *  have moved lanes while it waited); a delegation carries the words the
 *  person's delegate mutation earned, because no one else composed them. */
interface WaitingWork {
  kind: 'walk' | 'delegation' | 'answer';
  trackerId: string;
  projectId: string;
  ticketId: string;
  /** The worker lane the claim is for: what the ticket enters at the start. */
  lane: string;
  /** Was the ticket sitting in the queue lane when its request asked? Then
   *  it enters the worker lane before the worker does. */
  fromQueue: boolean;
  /** A delegation's platform-side entry is the caller's, already done: its
   *  summary and directory ride along, and `initWork` is not asked twice. */
  summary?: string;
  directory?: string;
  branch?: string;
  /** An answer waiting for capacity to resume its run: the run to wake,
   *  the person's words, and the form that recorded the question. */
  runId?: string;
  answer?: string;
  formId?: string;
}

export interface OrchestratorDeps {
  ledger: RunLedger;
  opencode: () => Promise<OpenCodeClient>;
  events: SessionEvents;
  log: Logger;
  /** The host's signal: client calls are bound to the host's life. */
  signal: AbortSignal;
  /** A project's lanes in order, straight from core config: the orchestrator
   *  decides moves from this order and never asks a tracker where to go. */
  lanes: (projectId: string) => ProjectLane[];
  /** Where a project's workers work: the checkout. A `worktree: true` lane
   *  gets its own git worktree on the ticket's branch, made from this. */
  directory: (projectId: string) => string;
  /** The identity a worktree's commits carry: core's resolution order —
   *  `identity.github`, the machine's git config, the aivi app. */
  identity: () => Promise<GitIdentity>;
  /** The dispatcher is the only part that knows how much capacity is left:
   *  the orchestrator asks it for every slot and never counts one itself. */
  dispatcher: Dispatcher;
  /** Who owns a project's remote: `aivi_pr` asks before it pushes, and an
   *  unowned remote means the tool says so plainly. */
  forges: Forges;
  /** How long an open elicitation holds its slot. The orchestrator's own
   *  dial (docs/orchestrator.md, "When a worker needs human input"). */
  keepAliveMs: number;
  /** Premature turn-ends tolerated before the run fails visibly. A safety net, not a poller. */
  nudgeBudget?: number;
  /** The editable prompt texts (core's `prompts/` set), read at use: an
   *  edit to `<home>/prompts/<name>.md` lands on the next run, a delete is
   *  instant restoration. Absent dep: the built-in defaults, which is what
   *  a host with no home on disk (a test, a CLI boot) speaks anyway. */
  prompt?: (name: PromptName) => Promise<string>;
}

/** Refused completions before the person is asked, in their words: "a max
 *  of 3 tries or something until HITL" (ruled 2026-10-02). */
const MAX_FEEDBACK_TRIES = 3;

/** One line of a prompt or a tool answer: whatever the platform said, told
 *  in the space aivi has for it. */
const clip = (text: string, max = 500): string => {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
};

const exec = promisify(execFile);

/** Local git reads for the push tool: trimmed stdout, `''` when git has no
 *  answer. Nothing here reaches a remote — crossing the boundary is the
 *  forge's, and `aivi_pr` hands the transfer over below. */
const localGit = async (cwd: string, ...args: string[]): Promise<string> =>
  (await exec('git', ['-C', cwd, ...args], { maxBuffer: 1024 * 1024 }).catch(() => null))?.stdout.trim() ?? '';

/** A read whose failure must not look like an empty answer: `null` says
 *  git refused, and the caller says so instead of deciding on a silence. */
const gitRead = async (cwd: string, ...args: string[]): Promise<string | null> => {
  const done = await exec('git', ['-C', cwd, ...args], { maxBuffer: 1024 * 1024 }).catch(() => null);
  return done === null ? null : done.stdout.trim();
};

/** The rules of the game, sent with the ticket at the start of every run.
 *  The tools are the host's, so their explanation lives here and no tracker
 *  repeats or rewords it; the nudge above is the same contract restated
 *  when a turn ends without either tool. */
export class Orchestrator implements OrchestratorApi {
  private readonly deps: OrchestratorDeps;
  private readonly budget: number;
  /** The editable prompt texts, read at use; the built-in defaults when the
   *  host wires no home (core's `prompts/` set, docs/plans/git-workflow.md). */
  private readonly prompt: (name: PromptName) => Promise<string>;
  private readonly trackers = new Map<string, Tracker>();
  private readonly passings = new Map<string, Promise<void>>();
  /** Work whose lease request waits in a dispatcher queue: the dispatcher's
   *  request id, then what the lease is for. Deliberately in memory — the
   *  dispatcher's queue is ephemeral and a restart lets the walk simply ask
   *  again for work that is still on the board. */
  private readonly requested = new Map<string, WaitingWork>();
  /** One clock per open elicitation: the known instant its keep-alive
   *  expires. Re-armed by the question and the answer, cleared by every
   *  ending — never an interval. */
  private readonly elicitations = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
    this.budget = deps.nudgeBudget ?? 2;
    this.prompt = deps.prompt ?? (async name => promptDefaults[name]);
    // The dispatcher's callback namespace: when a waiting request of ours
    // becomes a lease, this hears it with the request id and the lease —
    // and the callback is also the wake to look for more work.
    deps.dispatcher.registerCallback('orchestrator', (requestId, lease) => {
      void this.#fulfill(requestId, lease).catch(error => {
        this.deps.log.warn('fulfill.failed', { request: requestId, error });
        try {
          this.deps.dispatcher.release(lease.id);
        } catch {
          // 'already gone': fulfill released it before failing elsewhere.
        }
      });
    });
  }

  /**
   * Register a tracker: the board the walk reads and the stages every run
   * of this tracker's walks through (docs/orchestrator.md, "How work gets
   * picked"). The lifecycle stages — `initWork` and `endWork` — are awaited:
   * their failure is the run's failure, said visibly. The renders —
   * `ready`, `startWork`, `question`, `plan` — are fire-and-forget: a
   * platform that cannot show a thing loses nothing, and the tracker
   * retries its own renders in its own time.
   */
  addTracker(tracker: Tracker): void {
    this.trackers.set(tracker.id, tracker);
  }

  /** Call a render stage: fire-and-forget, said in the log, never carried
   *  into the run. A tracker without the stage loses nothing. */
  #render(run: Run, what: (tracker: Tracker) => void | Promise<void>, stage: string): void {
    const tracker = this.trackers.get(run.trackerId);
    if (!tracker) return void this.deps.log.warn('stage.no-tracker', { run: run.id, tracker: run.trackerId });
    void Promise.resolve(what(tracker)).catch(error =>
      this.deps.log.warn('stage.failed', { run: run.id, stage, error }),
    );
  }

  /** The run a worker session belongs to, whatever its state: the follower's
   *  lookup when its platform's session names an OpenCode session. */
  runBySession(sessionId: string): RunView | undefined {
    const run = this.deps.ledger.bySession(sessionId);
    return run && view(run);
  }

  /** The run still live on a ticket, if any: what a tracker checks before
   *  deciding a fresh delegation is new work, and what an issue-change event
   *  checks before deciding a move orphans a worker. */
  activeRun(trackerId: string, ticketId: string): RunView | undefined {
    const run = this.deps.ledger.activeByTicket(trackerId, ticketId);
    return run && view(run);
  }

  /**
   * A tracker says work is ready. The ledger's guard: a run still **active**
   * on this ticket is found and nothing starts — one ticket never gets two
   * workers at a time. Whether a re-delegation after a finished run is new
   * work is the tracker's decision, not this method's. A fresh run is
   * prepared in the background — the caller (a webhook handler) must return
   * promptly.
   *
   * A full pool **queues** the delegation: `queued` with the id the person's
   * next move can cancel, no run yet; when the slot opens, the run starts
   * and the follower's pair picks it up. `refused` is the plain answer —
   * the pool heard this service's one request already, or worse.
   */
  async requestWork(
    request: WorkRequest,
  ): Promise<{ runId: string; created: boolean; refused?: string; queued?: string }> {
    const live = this.deps.ledger.activeByTicket(request.trackerId, request.ticketId);
    if (live) return { runId: live.id, created: false };
    // Work cannot start without a lease — not even a delegation, which is
    // why the slot is taken (or its queue place) before the row exists.
    // `queued` waits for the slot; `refused` says so to the caller, never
    // silence: the ticket stays in the board's hands.
    const lane = this.deps.lanes(request.projectId).find(l => l.name === request.lane);
    const grant = this.deps.dispatcher.request({
      service: 'orchestrator',
      ...(lane?.pool ? { pool: lane.pool } : {}),
    });
    if ('refused' in grant) return { runId: '', created: false, refused: grant.refused };
    if ('queued' in grant) {
      this.requested.set(grant.queued, {
        kind: 'delegation',
        trackerId: request.trackerId,
        projectId: request.projectId,
        ticketId: request.ticketId,
        lane: request.lane,
        fromQueue: false,
        summary: request.summary,
        directory: request.directory,
        ...(request.branch ? { branch: request.branch } : {}),
      });
      return { runId: '', created: false, queued: grant.queued };
    }
    const { run, created } = this.deps.ledger.request({
      projectId: request.projectId,
      trackerId: request.trackerId,
      ticketId: request.ticketId,
      lane: request.lane,
      agent: request.agent,
    });
    if (!created) {
      this.deps.dispatcher.release(grant.lease.id);
      return { runId: run.id, created: false };
    }
    this.deps.ledger.setLease(run.id, grant.lease.id);
    // The push-shaped entry did its platform side already: the summary and
    // directory ride, initWork is not asked twice, and no move is owed.
    void this.#startRun(run, grant.lease.id, false, request.summary, request.directory);
    return { runId: run.id, created: true };
  }

  /**
   * Look for work. Tracker events, completed work and dispatcher callbacks
   * all wake; a walk already running for a project chains the next one
   * behind it, so wakes never interleave two passes over one board.
   */
  async wake(projectId?: string): Promise<void> {
    const pairs: [string, string][] = [...this.trackers.entries()].flatMap(([trackerId, tracker]) =>
      tracker
        .projects()
        .filter(p => projectId === undefined || p === projectId)
        .map(p => [trackerId, p]),
    );
    await Promise.all(pairs.map(([trackerId, project]) => this.#serialized(trackerId, project)));
  }

  #serialized(trackerId: string, projectId: string): Promise<void> {
    const key = `${trackerId}/${projectId}`;
    const previous = this.passings.get(key) ?? Promise.resolve();
    const next = previous
      .then(() => this.#pass(trackerId, projectId))
      .catch(error => this.deps.log.warn('walk.failed', { project: projectId, error }));
    this.passings.set(key, next);
    void next.finally(() => {
      if (this.passings.get(key) === next) this.passings.delete(key);
    });
    return next;
  }

  /**
   * One eligibility walk over one project. Lanes right to left — the lanes
   * closest to done are picked from first, so work finishes before work
   * starts — and within a lane, top to bottom. A queue lane is not walked as
   * a lane of its own: it is the **bottom** of the worker lane it feeds, so
   * tickets already working come before tickets waiting to start.
   *
   * A refusal stops the pass for that pool — the pool is depleted, and
   * asking again this pass is noise — while lanes drawing from other pools
   * walk on. A ticket that stops being eligible is skipped, not blocked:
   * the board keeps its own order.
   */
  async #pass(trackerId: string, projectId: string): Promise<void> {
    const tracker = this.trackers.get(trackerId);
    if (!tracker) return;
    const lanes = this.deps.lanes(projectId);
    const queueAt = lanes.findIndex(l => l.queue);
    const spent = new Set<string>();
    for (let at = lanes.length - 1; at >= 0; at--) {
      const lane = lanes[at]!;
      if (!lane.agent || lane.queue) continue; // humans work there; a queue is read as the bottom of its worker
      const asked = lane.pool ?? 'default';
      const fresh =
        queueAt >= 0 && this.#feedsQueue(lanes, queueAt, lane.name)
          ? await tracker.tickets(projectId, lanes[queueAt]!.name)
          : [];
      const list = [
        ...(await tracker.tickets(projectId, lane.name)).map(t => ({ ...t, fromQueue: false })),
        ...fresh.map(t => ({ ...t, fromQueue: true })),
      ];
      for (const ticket of list) {
        if (ticket.blocked) continue; // a person's move is awaited, not capacity
        if (this.deps.ledger.activeByTicket(trackerId, ticket.id)) continue; // claimed already — one worker per ticket
        if (spent.has(asked)) continue; // this pass stopped asking that pool
        const grant = this.deps.dispatcher.request({
          service: 'orchestrator',
          ...(lane.pool ? { pool: lane.pool } : {}),
        });
        if ('refused' in grant) {
          spent.add(grant.pool);
          continue;
        }
        if ('queued' in grant) {
          // The pool is full and this ticket holds its one queue place —
          // the next ticket's `waiting` refusal will stop this pool for the
          // pass. When a slot opens, #fulfill takes the key for this one.
          this.requested.set(grant.queued, {
            kind: 'walk',
            trackerId,
            projectId,
            ticketId: ticket.id,
            lane: lane.name,
            fromQueue: ticket.fromQueue,
          });
          continue;
        }
        // Still eligible after the awaits — the ledger's guard is the claim:
        // a ticket that took a run while this pass was reading never takes
        // a second worker.
        await this.#claimAndStart(trackerId, projectId, ticket.id, lane, ticket.fromQueue, grant.lease.id);
      }
    }
  }

  /**
   * Claim, mirror the lease, and hand the run to its start: the shared
   * tail of a direct grant and a queue fulfilment alike. The ledger's
   * guard is the claim — a ticket that took a run while this pass was
   * reading gives its lease back unheard.
   */
  async #claimAndStart(
    trackerId: string,
    projectId: string,
    ticketId: string,
    lane: ProjectLane,
    fromQueue: boolean,
    leaseId: string,
  ): Promise<void> {
    const { run, created } = this.deps.ledger.request({
      projectId,
      trackerId,
      ticketId,
      lane: lane.name,
      agent: lane.agent!,
    });
    if (!created) {
      this.deps.dispatcher.release(leaseId);
      return;
    }
    this.deps.ledger.setLease(run.id, leaseId);
    await this.#startRun(run, leaseId, fromQueue);
  }

  /**
   * The shared start of every run, walk or push. In order, the operator's
   * flow said plainly: **a queue pickup enters the worker lane first**
   * (the webhook its move sends is a wake and nothing more); the tracker's
   * **`initWork`** opens the ticket on the platform — Linear delegates to
   * its own app and the answer carries the agent session — and returns the
   * ticket's **summary**, the words the worker is started with; and the
   * orchestrator composes them with its own contract around the summary
   * and turns the key. A lifecycle failure — the lane that would not take
   * the ticket, the platform that would not open it — fails the run
   * visibly and gives the slot back: never silence, never a half-run.
   */
  async #startRun(
    run: Run,
    leaseId: string,
    fromQueue: boolean,
    summary?: string,
    directory?: string,
    branch?: string,
  ): Promise<void> {
    const tracker = this.trackers.get(run.trackerId);
    if (!tracker) {
      this.deps.dispatcher.release(leaseId);
      await this.#fail(run.id, 'No tracker is registered for this work.');
      return;
    }
    const dir = directory ?? this.deps.directory(run.projectId);
    if (fromQueue) {
      try {
        await tracker.moveTo(run.projectId, run.ticketId, run.lane);
      } catch (error) {
        this.deps.dispatcher.release(leaseId);
        await this.#fail(run.id, `Could not enter the worker lane: ${errorMessage(error)}`);
        return;
      }
    }
    let task = summary;
    if (task === undefined) {
      let entry: WorkEntry;
      try {
        entry = await tracker.initWork(view(run));
      } catch (error) {
        this.deps.dispatcher.release(leaseId);
        await this.#fail(run.id, `Could not open the ticket on its platform: ${errorMessage(error)}`);
        return;
      }
      task = entry.summary;
      branch = entry.branch;
    }
    void this.#prepare(run.id, task, dir, leaseId, branch);
  }

  /**
   * A waiting request became a lease: re-check eligibility **before
   * starting** — moved, blocked, or claimed in the meantime, and the lease
   * is released, the ticket left for the board to offer again. A walk
   * request starts wherever the ticket sits now (the person may have moved
   * it between lanes while it waited); a delegation starts only for the
   * lane it was delegated in — a moved ticket is the person's next act,
   * and the walk will read it fresh. Either way the callback ends as the
   * wake it is documented to be: look for more work.
   */
  async #fulfill(requestId: string, lease: DispatcherLease): Promise<void> {
    const work = this.requested.get(requestId);
    if (work?.kind === 'answer') {
      // An answer waiting for its slot: the run is the eligibility —
      // stopped or answered in the meantime, and the lease goes back.
      this.requested.delete(requestId); // the wait is over either way
      const run = work.runId ? this.deps.ledger.get(work.runId) : undefined;
      if (!run || run.state !== 'awaiting_input' || !work.answer) {
        this.deps.dispatcher.release(lease.id);
        return;
      }
      this.deps.ledger.setLease(run.id, lease.id);
      await this.#deliverAnswer(run, work.answer, work.formId);
      void this.wake(work.projectId);
      return;
    }
    if (!work) {
      // Nobody remembers asking. The lease has no work: give the slot back.
      this.deps.dispatcher.release(lease.id);
      return;
    }
    // No eligibility re-check: a ticket that moved, became blocked or was
    // claimed in the meantime **cancelled its own queue place** when the
    // person moved it — the wait is the plan, not a question. What slips
    // through a race ends in the claim's guard: a ticket that took a run
    // gives the lease back unheard, never a second worker.
    this.requested.delete(requestId);
    const lane = this.deps.lanes(work.projectId).find(l => l.name === work.lane);
    if (!lane) {
      // The config changed under the wait: the lane is gone, the work has
      // nowhere to enter. Said loudly; the board offers the ticket again.
      this.deps.dispatcher.release(lease.id);
      this.deps.log.warn('fulfill.lane-gone', { request: requestId, ticket: work.ticketId, lane: work.lane });
      return;
    }
    if (work.kind === 'delegation') {
      // The push entry's platform side was its caller's, already done.
      const { run, created } = this.deps.ledger.request({
        projectId: work.projectId,
        trackerId: work.trackerId,
        ticketId: work.ticketId,
        lane: lane.name,
        agent: lane.agent!,
      });
      if (!created) {
        this.deps.dispatcher.release(lease.id);
        return;
      }
      this.deps.ledger.setLease(run.id, lease.id);
      void this.#startRun(run, lease.id, false, work.summary, work.directory, work.branch);
      void this.wake(work.projectId);
      return;
    }
    await this.#claimAndStart(work.trackerId, work.projectId, work.ticketId, lane, work.fromQueue, lease.id);
    void this.wake(work.projectId);
  }

  /**
   * A person's move on a ticket gives up any queue place its waiting
   * request held: cancellation loses the position and nothing more — the
   * next wake asks fresh for whatever the ticket is now.
   */
  cancelWaiting(trackerId: string, ticketId: string): void {
    for (const [requestId, work] of this.requested) {
      if (work.trackerId !== trackerId || work.ticketId !== ticketId) continue;
      this.requested.delete(requestId);
      this.deps.dispatcher.cancel(requestId);
    }
  }

  /** Does this queue lane feed the lane being walked — by `next` override
   *  or by plain order? The config load proved the target is a worker lane. */
  #feedsQueue(lanes: ProjectLane[], queueAt: number, laneName: string): boolean {
    const queue = lanes[queueAt]!;
    return (queue.next ?? lanes[queueAt + 1]?.name) === laneName;
  }

  /**
   * The dispatcher ended a lease itself — idle silence, a revoked prepare,
   * a boot reconcile that found the session gone. The claim that mirrored
   * it is cleared, and said: the ticket's people hear that the worker died
   * (the run fails with the dispatcher's reason), never silence. A lease
   * with no live claim needed no clearing: the run ended first and had
   * already released it.
   */
  async leaseEnded(lease: DispatcherLease, reason: string, code?: FailureCode): Promise<void> {
    const run = this.deps.ledger.byLease(lease.id);
    if (!run) return;
    await this.#fail(run.id, `The dispatcher ended the lease: ${reason}`, false, code);
  }

  /** A run of this project just ended: work may be claimable now. */
  #wakeAfter(run: Run): void {
    void this.#serialized(run.trackerId, run.projectId).catch(error =>
      this.deps.log.warn('walk.after-end.failed', { project: run.projectId, error }),
    );
  }

  /** Give back the slot a terminal run's claim held, if it still stands. */
  /** Aim the one clock of an open elicitation at its known instant. */
  #armElicitation(runId: string): void {
    this.#clearElicitation(runId);
    const handle = setTimeout(() => {
      this.elicitations.delete(runId);
      void this.#keepAliveExpired(runId).catch(error => this.deps.log.warn('keep-alive.failed', { run: runId, error }));
    }, this.deps.keepAliveMs);
    this.elicitations.set(runId, handle);
  }

  #clearElicitation(runId: string): void {
    const previous = this.elicitations.get(runId);
    if (previous) clearTimeout(previous);
    this.elicitations.delete(runId);
  }

  /**
   * The keep-alive rang and the slot goes: **released, not expired** —
   * nobody is killed, the session keeps its form and waits for the answer,
   * and the claim stands so no other worker takes the ticket. The freed
   * capacity goes to the queue and the walk, which is the point of letting
   * a silent wait cost nothing.
   */
  async #keepAliveExpired(runId: string): Promise<void> {
    const run = this.deps.ledger.get(runId);
    if (!run || run.state !== 'awaiting_input') return; // answered, stopped or failed in the window
    if (run.leaseId && this.deps.dispatcher.leases.get(run.leaseId)) {
      this.deps.dispatcher.release(run.leaseId);
      this.deps.ledger.clearLease(runId);
      this.deps.log.info('elicitation.waiting', { run: runId, ticket: run.ticketId });
      void this.wake(run.projectId);
    }
  }

  /**
   * A person answered an elicitation. With the slot still behind the run
   * (the keep-alive has not rung) the answer lands at once; without one,
   * the answer **reacquires capacity and resumes the same session** — the
   * dispatcher's rules do the rest: the session's own pool only, the
   * fallback never, and a full pool queues the reacquisition. The answer's
   * words wait with the request; a refusal is said, never swallowed.
   */
  async answer(
    sessionId: string,
    text: string,
    formId?: string,
  ): Promise<{ resumed: true } | { resumed: false; queued?: string; refused?: string }> {
    const run = this.deps.ledger.bySession(sessionId);
    if (!run) throw new ToolError(404, 'This session is not an aivi run.');
    this.#clearElicitation(run.id);
    if (run.leaseId && this.deps.dispatcher.leases.get(run.leaseId)) {
      await this.#deliverAnswer(run, text, formId);
      return { resumed: true };
    }
    const grant = this.deps.dispatcher.request({ service: 'orchestrator', resume: sessionId });
    if ('refused' in grant) return { resumed: false, refused: grant.refused };
    if ('queued' in grant) {
      this.requested.set(grant.queued, {
        kind: 'answer',
        trackerId: run.trackerId,
        projectId: run.projectId,
        ticketId: run.ticketId,
        lane: run.lane,
        fromQueue: false,
        runId: run.id,
        answer: text,
        ...(formId ? { formId } : {}),
      });
      return { resumed: false, queued: grant.queued };
    }
    this.deps.ledger.setLease(run.id, grant.lease.id);
    await this.#deliverAnswer(run, text, formId);
    return { resumed: true };
  }

  /** The answer's delivery, immediate or after a queue wait: the run is
   *  working again **before** the words go in (the idle clock restarts with
   *  the answer), the worker gets the text first, and the form closes as
   *  the record — a form that refuses the reply is a stale record, not a
   *  lost answer. */
  async #deliverAnswer(run: Run, text: string, formId?: string): Promise<void> {
    const resumed = this.deps.ledger.resumed(run.id);
    if (resumed.leaseId) this.deps.dispatcher.activity(resumed.leaseId);
    // The person answered **the escalation form**: the strikes reset. Their
    // words were "try again with these instructions", not "fail after three
    // more" (ruled in the walkthrough); the escalated flag stays, the form
    // was made once.
    if (formId && resumed.feedback?.escalated && formId === resumed.feedback.formId) {
      this.deps.ledger.resetFeedback(resumed.id);
      this.deps.log.info('run.feedback.reset', { run: resumed.id, form: formId });
    }
    const client = await this.deps.opencode();
    await client.session.prompt({
      sessionID: run.sessionId!,
      id: `msg_${randomBytes(6).toString('hex')}`,
      text: `The person answered your question: ${text}`,
      delivery: 'queue',
    });
    if (formId) {
      try {
        await client.session.form.reply({ sessionID: run.sessionId!, formID: formId, answer: { answer: text } });
      } catch (error) {
        this.deps.log.warn('run.form.reply.failed', { run: run.id, form: formId, error });
      }
    }
    this.deps.log.info('run.answered', { run: run.id, ...(formId ? { form: formId } : {}) });
  }

  #releaseLease(run: Run): void {
    this.#clearElicitation(run.id); // a terminal run holds no clocks
    this.cancelWaiting(run.trackerId, run.ticketId); // nor queue places — a waiting answer reacquisition included
    if (!run.leaseId) return;
    if (!this.deps.dispatcher.leases.get(run.leaseId)) return; // the dispatcher already ended it
    this.deps.dispatcher.release(run.leaseId);
  }

  /** The one event rule, used at start and at boot: every event says the
   *  session lives — the dispatcher's silence clock restarts here — and a
   *  turn's end sends the run through the policy. */
  #watch(sessionId: string, leaseId?: string): void {
    this.deps.events.watch(sessionId, event => {
      if (leaseId) this.deps.dispatcher.activity(leaseId);
      if (event.type === 'session.idle') void this.#turnEnded(sessionId);
    });
  }

  /**
   * The shared ending tail, in the operator's order: the tracker says the
   * **closing words** on its platform (`endWork`, awaited — a permanent
   * failure there is said by the tracker itself: its platform's help mark,
   * because the person must know), the orchestrator moves the ticket to the
   * lane its order chose, and **lastly** the lease returns to the
   * dispatcher. A move that misses retries at known instants and from the
   * next boot — the debt lives in the run's row until it lands — because
   * the tracker's move is idempotent. Then the walk is woken.
   */
  async #finishRun(ended: Run): Promise<void> {
    const tracker = this.trackers.get(ended.trackerId);
    if (tracker) {
      try {
        await tracker.endWork(view(ended));
      } catch (error) {
        // The closing failed; the ticket still moves and the slot still
        // returns — the tracker has said the failure where people read.
        this.deps.log.error('endwork.failed', { run: ended.id, ticket: ended.ticketId, error });
      }
    } else this.deps.log.warn('endwork.no-tracker', { run: ended.id, tracker: ended.trackerId });
    // A stop cleans up after itself (ruled 2026-10-03): the worktree goes —
    // uncommitted work and local commits alike — so a stopped attempt leaves
    // nothing half-finished for the next worker to trip over. Pushed work
    // stays pushed; the native session stays for inspection. A *failed* run
    // keeps its worktree: a person may still want to look. The `worktree`
    // column names where the worker worked — the checkout itself for a
    // checkout lane, which no stop may touch; the same test as the worker's
    // first prompt draws the line.
    if (ended.state === 'cancelled' && ended.worktree && ended.worktree !== this.deps.directory(ended.projectId))
      await this.#cleanWorktree(ended, ended.worktree);
    if (ended.targetLane) await this.#move(ended);
    this.#releaseLease(ended);
    // A run that lived wakes the walk: its slot is free and its ticket may
    // have moved. An early failure — no worker ever came up — does **not**:
    // the pass that claimed it is still walking and asks the rest itself,
    // and a failure that woke itself would spin (claim → fail → wake →
    // claim). The next human event wakes the retry, the same way a person
    // retrying a job does.
    if (ended.sessionId) this.#wakeAfter(ended);
  }

  /** The stop's teardown of one worktree: directory, then local branch. The
   *  failure is named by path, the surviving branch by name — never silence,
   *  and never a retry clock: the next boot's `ensureWorktree` finds whatever
   *  stands and reuses or replaces it as it always has. */
  async #cleanWorktree(run: Run, worktree: string): Promise<void> {
    try {
      const left = await removeWorktree(this.deps.directory(run.projectId), worktree, this.deps.signal);
      if (left) this.deps.log.warn('worktree.branch.left', { run: run.id, branch: left, path: worktree });
      else this.deps.log.info('worktree.cleaned', { run: run.id, path: worktree });
    } catch (error) {
      this.deps.log.error('worktree.cleanup.failed', { run: run.id, path: worktree, error });
    }
  }

  /** Perform the ending move, retrying at known instants — a self-rearming
   *  timeout, re-armed only after the previous attempt finished, never a
   *  poll. Three strikes and the log says it plainly; the debt stays in
   *  the run's row, so the next wake and the next boot drive it again. */
  async #move(run: Run): Promise<void> {
    await this.#moveAttempt(run.trackerId, run.projectId, run.ticketId, run.lane, run.targetLane!, run.id, 1);
  }

  async #moveAttempt(
    trackerId: string,
    projectId: string,
    ticketId: string,
    from: string,
    target: string,
    runId: string,
    attempt: number,
  ): Promise<void> {
    const tracker = this.trackers.get(trackerId);
    if (!tracker) return void this.deps.log.warn('move.no-tracker', { run: runId, tracker: trackerId });
    try {
      // Validity before the move (ruled 2026-10-02): the webhook is what
      // normally ends a run whose ticket a person moves out from under it,
      // and a missed delivery must not end as the orchestrator dragging
      // their ticket back. If it sits somewhere else now, the move is
      // theirs; the debt is spent, never undone. Gone from the board —
      // deleted — is the same answer in other words.
      const current = await tracker.ticketLane(projectId, ticketId);
      if (current === undefined || (current !== from && current !== target)) {
        this.deps.ledger.moveLanded(runId);
        return void this.deps.log.info('move.canceled', {
          run: runId,
          ticket: ticketId,
          to: target,
          where: current ?? 'gone from the board',
        });
      }
      await tracker.moveTo(projectId, ticketId, target);
      this.deps.ledger.moveLanded(runId);
    } catch (error) {
      if (attempt >= 3)
        return void this.deps.log.error('move.failed', { run: runId, ticket: ticketId, to: target, error });
      this.deps.log.warn('move.retrying', { run: runId, ticket: ticketId, to: target, attempt, error });
      await new Promise(resolve => setTimeout(resolve, 5_000 * attempt));
      await this.#moveAttempt(trackerId, projectId, ticketId, from, target, runId, attempt + 1);
    }
  }

  /** Provide the lease with its session and send the task. A `worktree: true`
   *  lane works in its **own git worktree**, made here on the ticket's branch
   *  (the tracker names it, the orchestrator never invents one): the crossing
   *  to `origin` is the forge's, so its `fetchBranch` goes in **injected**
   *  when a forge owns the remote, and with none the worktree starts from the
   *  refs the clone already holds. The dispatcher creates the session and
   *  decides its model (the pool's, or the agent file's where no pool names
   *  one); the orchestrator only ever says agent and directory. Any failure
   *  fails the run visibly, never silently, and gives the slot back. */
  async #prepare(runId: string, summary: string, directory: string, leaseId: string, branch?: string): Promise<void> {
    const log = this.deps.log.with({ run: runId });
    try {
      const run = this.deps.ledger.get(runId);
      if (!run) return;
      let dir = directory;
      const lane = this.deps.lanes(run.projectId).find(l => l.name === run.lane);
      const owned = await this.deps.forges.owner({ id: run.projectId, directory });
      if (lane?.worktree) {
        if (!branch)
          throw new Error('this lane works in its own worktree, and the tracker named no branch for the ticket');
        const source = directory;
        const made = await ensureWorktree({
          source,
          path: worktreePathFor(source, runId),
          branch,
          identity: await this.deps.identity(),
          ...(owned ? { fetchBranch: (b: string) => owned.forge.fetchBranch(owned.repo, source, b) } : {}),
          signal: this.deps.signal,
        });
        dir = made.path;
        log.info('worktree.ready', { branch, base: made.base, ...(owned ? { forge: owned.repo.id } : {}) });
      }
      // The feedback gather at start; see #gatherFeedback. Warned, never
      // fatal: unreadable at start means started-clean.
      let feedback = '';
      if (owned && branch)
        try {
          feedback = await this.#gatherFeedback(runId, owned, branch);
        } catch (error) {
          log.warn('run.feedback.unreadable', { branch, error });
        }
      // The writing-style guidance slots (core's `review-posture` and
      // `pr-body` prompts): posture words for the tools every worker may
      // use, editable live, and the gate stays posture-blind — nothing in
      // the state machine reads these.
      const style = [await this.prompt('review-posture'), await this.prompt('pr-body')].filter(Boolean).join('\n');
      const lease = await this.deps.dispatcher.provide(leaseId, { agent: run.agent, directory: dir });
      const sessionId = lease.sessionId!;
      // Watch before prompting: a live-only stream must not miss the first turn's end.
      this.#watch(sessionId, leaseId);
      const client = await this.deps.opencode();
      const request = { signal: this.deps.signal };
      const working = this.deps.ledger.attachSession(runId, sessionId, dir);
      // The tracker attaches the run to the pair it opened at initWork —
      // before the first prompt, so nothing it must render arrives unpaired.
      this.#render(working, t => t.ready(view(working)), 'ready');
      await client.session.prompt(
        {
          sessionID: sessionId,
          id: `msg_${randomBytes(6).toString('hex')}`,
          // The task as the orchestrator composes it: where this run is and
          // where the work happens are core's words, the ticket's summary is
          // the tracker's, the tools' rules are the contract below. No
          // tracker writes the worker's first message (ruled 2026-10-02).
          text: [
            `[aivi started this run for you (project ${working.projectId}, lane "${working.lane}"). You work in ${
              dir === directory
                ? `the project's checkout ${dir}`
                : `a git worktree of the project at ${dir}, on branch ${branch}`
            }; the agent file says what you may change.]`,
            summary,
            ...(feedback ? [feedback] : []),
            ...(style ? [style] : []),
            fillPrompt(await this.prompt('worker-contract'), { directory: dir }),
          ].join('\n\n'),
          delivery: 'queue',
        },
        request,
      );
      // A platform whose session shows its own life skips startWork; one
      // that must say "working" says it here.
      this.#render(working, t => t.startWork?.(view(working)), 'startWork');
      log.info('run.started', { session: sessionId, directory: dir });
    } catch (error) {
      log.error('run.prepare.failed', { error });
      await this.#fail(runId, `Could not start the worker: ${errorMessage(error)}`);
    }
  }

  /**
   * A turn ended. The ledger state plus one read of OpenCode are the whole
   * discriminator — no guessing from text:
   * - terminal → say nothing; the run is over.
   * - a form still `pending` → the worker asked and the person has not
   *   answered: wait, silently. The form is OpenCode's record and the
   *   follower has rendered it; the answer resumes the session on its own.
   * - nothing pending (neither tool fired this turn) → a bounded, visible
   *   nudge; once the budget is spent, the run fails visibly. Never silence.
   */
  async #turnEnded(sessionId: string): Promise<void> {
    const run = this.deps.ledger.bySession(sessionId);
    if (!run || run.state !== 'working') return;
    try {
      const forms = (await this.deps.opencode()).session.form.list({ sessionID: sessionId });
      if ((await forms).length) {
        this.deps.log.debug('run.waiting', { run: run.id });
        return;
      }
    } catch (error) {
      // OpenCode unreadable: nudging into an outage helps nobody. The next
      // turn end asks again; a run never dies on a failed read.
      this.deps.log.warn('run.form.list.failed', { run: run.id, error });
      return;
    }
    if (run.nudges >= this.budget) {
      await this.#fail(run.id, 'The worker ended its turn without reporting done or asking a question.', true);
      return;
    }
    const nudged = this.deps.ledger.bumpNudge(run.id);
    this.deps.log.info('run.nudge', { run: run.id, nudge: nudged });
    try {
      const client = await this.deps.opencode();
      await client.session.prompt({
        sessionID: sessionId,
        id: `msg_${randomBytes(6).toString('hex')}`,
        text: await this.prompt('nudge'),
        delivery: 'queue',
      });
    } catch (error) {
      this.deps.log.warn('run.nudge.failed', { run: run.id, error });
    }
  }

  /** A stop: interrupt the worker and end the run as cancelled. A stopped
   *  ticket stays where it is — the person who stopped it left it where they
   *  wanted it. An interrupt that OpenCode would not answer ends the run
   *  carrying `stop-unconfirmed` (AGENTS.md: the blocked words are for stops
   *  that cannot be verified, and no closing may then claim "stopped at your
   *  request"); the run still ends, because its lease, its clocks and its
   *  worktree are ours to take back whatever OpenCode says. */
  async stop(runId: string, reason: string): Promise<void> {
    const run = this.deps.ledger.get(runId);
    if (!run || (run.state !== 'working' && run.state !== 'awaiting_input')) return;
    let unconfirmed = false;
    try {
      if (run.sessionId) {
        const client = await this.deps.opencode();
        await client.session.interrupt({ sessionID: run.sessionId });
      }
    } catch (error) {
      this.deps.log.warn('run.interrupt.failed', { run: runId, error });
      unconfirmed = true;
    }
    const ended = this.deps.ledger.cancel(runId, reason, unconfirmed ? 'stop-unconfirmed' : undefined);
    await this.#finishRun(ended);
  }

  async #fail(runId: string, reason: string, workerEnded = false, code?: FailureCode): Promise<void> {
    const run = this.deps.ledger.get(runId);
    if (!run || run.state === 'completed' || run.state === 'cancelled') return;
    // A failure the worker's own turn produced (nudge budget spent) moves the
    // ticket like any failure; aivi's own failures (a session that never came
    // up) leave it exactly where the person can see it.
    const ended = this.deps.ledger.finish(
      runId,
      { kind: 'failure', reason, ...(code ? { code } : {}) },
      workerEnded ? this.#moveTarget(run, false) : undefined,
    );
    await this.#finishRun(ended);
  }

  /**
   * Where an ended run's ticket moves, from the project's lane order — a
   * core decision that the orchestrator makes and no tracker is asked about:
   * success goes to the lane's `next` or the neighbouring lane below it;
   * failure to its `previous` or the one above. A stop never calls this
   * (cancel carries no
   * lane: a stopped ticket stays where the person left it), and a run whose
   * lane is no longer configured goes nowhere — unconfigured is silent.
   */
  #moveTarget(run: Run, success: boolean): string | undefined {
    const lanes = this.deps.lanes(run.projectId);
    const at = lanes.findIndex(l => l.name === run.lane);
    if (at < 0) return undefined;
    const lane = lanes[at]!;
    return success ? (lane.next ?? lanes[at + 1]?.name) : (lane.previous ?? lanes[at - 1]?.name);
  }

  /**
   * The feedback-loop guidance the first prompt carries when the run started
   * with an open pull request: the operator-editable opening (core's
   * `feedback-loop` prompt) and the facts it applies to. Empty when there is
   * nothing to say: a clean start carries no paragraph. The facts stay code —
   * composition fills guidance slots, it does not template ticket data.
   */
  async #feedbackGuidance(pr: PrFacts, facts: ReviewFacts): Promise<string> {
    const parts: string[] = [];
    if (facts.threads.length)
      parts.push(
        fillPrompt(await this.prompt('feedback-loop'), { pull: pr.url }),
        ...facts.threads.map(t => `- [${t.id}] ${t.path ? `${t.path}: ` : ''}${clip(t.question)}`),
      );
    if (facts.comments.length)
      parts.push(
        'Plain comments on the pull request (answer them in the conversation too; aivi_review has the full text):',
        ...facts.comments.slice(-10).map(c => `- ${c.author.login}: ${clip(c.body)}`),
        ...(facts.comments.length > 10 ? [`(${facts.comments.length - 10} older comments: aivi_review)`] : []),
      );
    if (facts.pr.mergeable === 'dirty')
      parts.push(
        'The pull request does not merge cleanly into its base right now: integrate before you finish — aivi_sync, then merge or rebase with your git.',
      );
    return parts.join('\n');
  }

  /**
   * The gathering at start (docs/plans/git-workflow.md): the open review
   * threads of **this moment** are the only ones the completion gate can
   * ever owe, and the guidance rides the first prompt. A forge that cannot
   * be read here is warned, not fatal: the run starts without a snapshot —
   * started-clean, so the gate will owe nothing — and the log says why.
   * Whether the agent is reviewing or answering a review is the agent
   * file's word, never this code's.
   */
  async #gatherFeedback(runId: string, owned: ForgeOwner, branch: string): Promise<string> {
    const pr = await owned.forge.prForBranch(owned.repo, branch);
    if (pr?.state !== 'open') return '';
    const facts = await owned.forge.reviewFeedback(owned.repo, pr);
    if (facts.threads.length)
      this.deps.ledger.snapshotFeedback(
        runId,
        facts.threads.map(t => t.id),
      );
    return this.#feedbackGuidance(pr, facts);
  }

  /** The worker says it is done. A tool call, so it is a fact: end the run,
   *  record where the lane order sends the ticket, and emit the ending for
   *  whoever follows. Telling the platform is nobody here's business. A
   *  **success** passes the feedback gate first; a failure is exempt — a
   *  worker giving up doesn't have to answer reviewers to hand the ticket
   *  back. */
  readonly completeTool: ToolHandler = async call => {
    const run = this.deps.ledger.bySession(call.sessionId);
    if (!run) throw new ToolError(404, 'This session is not an aivi run; aivi_work_complete is not available here.');
    if (isTerminal(run.state)) throw new ToolError(409, `This run already ended (${run.state}).`);
    const outcome = parseOutcome(call.input);
    if (outcome.kind === 'success') await this.#feedbackGate(run);
    const ended = this.deps.ledger.finish(run.id, outcome, this.#moveTarget(run, outcome.kind === 'success'));
    await this.#finishRun(ended);
    return { recorded: true, outcome: outcome.kind };
  };

  /**
   * The feedback gate (ruled 2026-10-02): *"if there is open feedback, we
   * keep nudging until there is none"* with *"a max of 3 tries or something
   * until HITL"*. Owed = the threads open **when the run started** that are
   * **still open** — a run that started clean owes nothing (a reviewing
   * agent posts its findings and finishes freely), plain comments are
   * context only, and a human resolving a thread is authoritative. Each
   * refusal counts; at the third the person is asked through the same
   * durable form `aivi_ask` makes, and the escalation is never doubled.
   * There is no bypass hatch: past the gate only threads actually resolved.
   */
  async #feedbackGate(run: Run): Promise<void> {
    const feedback = run.feedback;
    if (!feedback || !feedback.openThreadIds.length) return; // started clean: nothing is ever owed
    const directory = run.worktree ?? this.deps.directory(run.projectId);
    const owned = await this.deps.forges.owner({ id: run.projectId, directory });
    const branch = await localGit(directory, 'symbolic-ref', '--quiet', '--short', 'HEAD');
    if (!owned || !branch)
      throw new ToolError(
        502,
        'The feedback gate cannot read the pull request right now (this run has no forge or no branch to ask by); call aivi_work_complete again.',
      );
    const pr = await owned.forge.prForBranch(owned.repo, branch);
    if (!pr || pr.state !== 'open') return; // the pull request closed: its threads died with it, nothing owed
    let facts: ReviewFacts;
    try {
      facts = await owned.forge.reviewFeedback(owned.repo, pr);
    } catch (error) {
      throw new ToolError(
        502,
        `The feedback gate could not read ${pr.url} this time: ${errorMessage(error)}. Call aivi_work_complete again.`,
      );
    }
    const owed = facts.threads.filter(t => feedback.openThreadIds.includes(t.id));
    if (!owed.length) return; // every owed thread resolved — by the worker or by a person, both authoritative
    const counted = this.deps.ledger.countFeedback(run.id);
    const strikes = counted.feedback?.attempts ?? 0;
    const list = owed.map(t => `- ${t.path ? `${t.path}: ` : ''}${clip(t.question)} (id ${t.id})`).join('\n');
    if (strikes >= MAX_FEEDBACK_TRIES && !counted.feedback?.escalated) {
      const question = fillPrompt(await this.prompt('escalation'), { pull: pr.url, list });
      try {
        const client = await this.deps.opencode();
        const form = await client.session.form.create({
          sessionID: run.sessionId!,
          title: question,
          fields: [{ key: 'answer', type: 'string', title: question, required: true, custom: true }],
        });
        const parked = this.deps.ledger.awaiting(run.id);
        this.deps.ledger.markEscalated(run.id, form.id);
        this.deps.log.info('run.feedback.escalated', { run: run.id, pull: pr.id, owed: owed.length });
        this.#render(parked, t => t.question(view(parked), { question, formId: form.id }), 'question');
        this.#armElicitation(run.id);
      } catch (error) {
        // The person could not be reached: the strike stands and the next
        // refusal tries the form again. A silent skip is the one thing
        // worse than a loud failure here.
        this.deps.log.warn('run.feedback.form.failed', { run: run.id, error });
      }
      throw new ToolError(
        409,
        `The person has been asked about the unresolved feedback above. End your turn; their answer reaches you as a follow-up.`,
      );
    }
    if (counted.feedback?.escalated)
      throw new ToolError(409, `Still owed — the person was asked once and the threads stand:\n${list}`);
    throw new ToolError(
      409,
      `Not done: the pull request still has unresolved review threads you owe answers on:\n${list}\n` +
        'Answer each with aivi_respond_feedback — agree (do the work, aivi_push) or disagree (a grounded comment); both resolve the thread. ' +
        `This refusal is ${strikes} of ${MAX_FEEDBACK_TRIES}; at the third, a person is asked.`,
    );
  }

  /**
   * The worker asks a human a question. Creates the durable OpenCode session
   * form — the record of the wait, outliving the turn and any restart — and
   * emits the question for the follower to render its way. The run's state
   * does not change: the form is the truth of the wait, read back from
   * OpenCode when the turn ends. Does **not** block for the answer; the
   * answer resumes the session through OpenCode itself.
   */
  readonly askTool: ToolHandler = async call => {
    const run = this.deps.ledger.bySession(call.sessionId);
    if (!run) throw new ToolError(404, 'This session is not an aivi run; aivi_ask is not available here.');
    if (run.state !== 'working') throw new ToolError(409, `Cannot ask while the run is ${run.state}.`);
    const question = parseQuestion(call.input);
    const client = await this.deps.opencode();
    const form = await client.session.form.create({
      sessionID: run.sessionId!,
      title: question.question,
      fields: [
        question.options?.length
          ? {
              key: 'answer',
              type: 'string',
              title: question.question,
              required: true,
              options: question.options.map(o => ({ value: o.value, label: o.label })),
              // The options are suggestions, not a cage (live, 2026-10-02:
              // a person *typed* "IMAGINATION" where the worker listed
              // map/globe/painting, and the form refused the reply and stood
              // unsettled). Free text is a valid human answer; the form
              // closes with the person's own words as the record.
              custom: true,
            }
          : { key: 'answer', type: 'string', title: question.question, required: true },
      ],
    });
    const withForm: RunQuestion = { ...question, formId: form.id };
    // The run parks on the person: the slot is held for the keep-alive and
    // the OpenCode form is the durable record of the wait.
    const parked = this.deps.ledger.awaiting(run.id);
    this.deps.log.info('run.question', { run: run.id, form: form.id });
    this.#render(parked, t => t.question(view(parked), withForm), 'question');
    this.#armElicitation(run.id);
    return { delivered: true, endYourTurn: true };
  };

  /**
   * The worker's plan, emitted as it stands. A **forwarding**, not a
   * ceremony: nothing is owed if a follower misses it (the next update
   * carries the whole plan anyway), no state of the run turns on it, and a
   * follower without a plan surface drops it. The plan is what people watch
   * while a long run works; it never ends anything.
   */
  readonly planTool: ToolHandler = async call => {
    const run = this.deps.ledger.bySession(call.sessionId);
    if (!run) throw new ToolError(404, 'This session is not an aivi run; aivi_plan is not available here.');
    if (isTerminal(run.state)) throw new ToolError(409, `This run already ended (${run.state}).`);
    const plan = parsePlan(call.input);
    const runRow = this.deps.ledger.get(run.id)!;
    this.#render(runRow, t => t.plan?.(view(runRow), plan), 'plan');
    return { recorded: true, steps: plan.steps.length };
  };

  /**
   * The shared opening of the three git tools: a live run, the directory it
   * works in, and **who owns this project's remote**. Every refusal is
   * plain and true — a research ticket with no forge gets its plain
   * answer, and the tools are served always because per-session injection
   * is not possible (ruled 2026-10-02).
   */
  async #forgeRun(
    call: { sessionId: string; input: Record<string, unknown> },
    tool: string,
  ): Promise<{ run: Run; directory: string; owned: ForgeOwner }> {
    const run = this.deps.ledger.bySession(call.sessionId);
    if (!run) throw new ToolError(404, `This session is not an aivi run; ${tool} is not available here.`);
    if (isTerminal(run.state)) throw new ToolError(409, `This run already ended (${run.state}).`);
    const directory = run.worktree ?? this.deps.directory(run.projectId);
    const owned = await this.deps.forges.owner({ id: run.projectId, directory });
    if (!owned)
      throw new ToolError(409, `Project ${run.projectId} has no forge for its remote: aivi is the only way across.`);
    return { run, directory, owned };
  }

  /** The branch HEAD sits on, refused when it is not a branch a pull
   *  request could stand for. */
  async #workerBranch(directory: string): Promise<string> {
    const branch = await localGit(directory, 'symbolic-ref', '--quiet', '--short', 'HEAD');
    if (!branch) throw new ToolError(409, 'This run sits on a detached HEAD; there is no branch to move.');
    // `--short` says a remote ref as `origin/main`; the guard wants the name.
    const defaultBranch = (
      await localGit(directory, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD')
    ).replace(/^origin\//, '');
    if (defaultBranch && branch === defaultBranch)
      throw new ToolError(409, `${branch} is the project's default branch: this work needs a branch of its own.`);
    return branch;
  }

  /**
   * The smart push, in the operator's words (ruled 2026-10-02): *"If we can
   * fast forward: fine. If we can safely merge it in: fine. If conflict:
   * well, resolve it. These are worker agents."* One fetch through the
   * forge for the fresh view, then: fast-forward → push; nothing ahead →
   * say so; diverged only by the worker's own rewrite — every remote commit
   * patch-equivalent per `git cherry`, nothing content-wise would be lost
   * → the force goes through, leased on the sha just fetched so a person's
   * newer commit is never overwritten; diverged by real remote work →
   * merge it in — clean pushes, a conflict **leaves the merge in progress**
   * and names the files, because resolving them is git the worker already
   * knows. The lease is never said out loud; it is plumbing.
   */
  async #pushBranch(owned: ForgeOwner, directory: string, branch: string): Promise<'pushed' | 'already'> {
    await owned.forge.fetchBranch(owned.repo, directory, branch);
    const remoteRef = `refs/remotes/origin/${branch}`;
    const remoteSha = await localGit(directory, 'rev-parse', '--verify', '--quiet', remoteRef);
    if (!remoteSha) {
      await owned.forge.push(owned.repo, directory, branch);
      return 'pushed';
    }
    const ahead = await gitRead(directory, 'rev-list', '--count', `${remoteRef}..HEAD`);
    const behind = await gitRead(directory, 'rev-list', '--count', `HEAD..${remoteRef}`);
    if (ahead === null || behind === null)
      throw new ToolError(500, `This directory does not read as a git checkout: ${directory}`);
    if (ahead === '0') return 'already';
    if (behind === '0') {
      await owned.forge.push(owned.repo, directory, branch);
      return 'pushed';
    }
    // Diverged. Whose commits are they? `git cherry HEAD <remote>` marks a
    // remote commit `-` when HEAD carries its patch-equivalent: all `-` is
    // a rebase, any `+` is a person's work.
    const cherry = await gitRead(directory, 'cherry', 'HEAD', remoteRef);
    if (cherry === null || cherry.split('\n').some(line => line.startsWith('+'))) {
      const merged = await exec('git', ['-C', directory, 'merge', '--no-edit', '--quiet', remoteRef], {
        maxBuffer: 1024 * 1024,
      }).then(
        () => null,
        (error: unknown) => errorMessage(error),
      );
      if (merged !== null) {
        const files = (await localGit(directory, 'diff', '--name-only', '--diff-filter=U')).split('\n').filter(Boolean);
        throw new ToolError(
          409,
          files.length
            ? `Merging origin/${branch} conflicts in ${files.join(', ')} — resolve them (git status shows the marks), commit, and call aivi_push again.`
            : `Could not merge origin/${branch}: ${merged}`,
        );
      }
      await owned.forge.push(owned.repo, directory, branch);
      return 'pushed';
    }
    try {
      await owned.forge.push(owned.repo, directory, branch, { lease: remoteSha });
    } catch (error) {
      throw new ToolError(
        409,
        `The remote moved while you worked: ${errorMessage(error)}. Call aivi_sync, integrate, and push again.`,
      );
    }
    return 'pushed';
  }

  /**
   * `aivi_push` — move this branch's commits to the remote as aivi's own
   * app, unstucking with as little chatter as possible: the smart push
   * above decides how, and the only refusal left is "your work is already
   * there".
   */
  readonly pushTool: ToolHandler = async call => {
    const { run, directory, owned } = await this.#forgeRun(call, 'aivi_push');
    const branch = await this.#workerBranch(directory);
    const moved = await this.#pushBranch(owned, directory, branch);
    if (moved === 'already') {
      const behind = await localGit(directory, 'rev-list', '--count', `HEAD..refs/remotes/origin/${branch}`);
      throw new ToolError(
        409,
        `Nothing to push: origin/${branch} already has every commit here${
          behind && behind !== '0' ? `, and you are behind by ${behind} — aivi_sync brings their work in` : ''
        }.`,
      );
    }
    this.deps.log.info('run.pushed', { run: run.id, branch, repo: owned.repo.id });
    return { pushed: true, branch };
  };

  /**
   * `aivi_sync` — the remote's latest refs in through the forge (all
   * branches, pruned, nothing checked out), with the honest numbers: behind
   * and ahead. The worker looks, then rebases or merges with its own git;
   * the push's fresh view keeps whatever it decides safe to force.
   */
  readonly syncTool: ToolHandler = async call => {
    const { run, directory, owned } = await this.#forgeRun(call, 'aivi_sync');
    await owned.forge.fetchRefs(owned.repo, directory);
    const branch = await localGit(directory, 'symbolic-ref', '--quiet', '--short', 'HEAD');
    if (!branch) return { synced: true, note: 'detached HEAD: refs are fresh, no branch to count against' };
    const remoteRef = `refs/remotes/origin/${branch}`;
    const known = await localGit(directory, 'rev-parse', '--verify', '--quiet', remoteRef);
    // "main moved" is worth knowing before a rebase is even considered.
    const defaultBranch = (
      await localGit(directory, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD')
    ).replace(/^origin\//, '');
    const defaultBehind =
      defaultBranch && defaultBranch !== branch
        ? await localGit(directory, 'rev-list', '--count', `HEAD..refs/remotes/origin/${defaultBranch}`)
        : '0';
    this.deps.log.info('run.synced', { run: run.id, branch, repo: owned.repo.id });
    return {
      synced: true,
      branch,
      ...(known
        ? {
            behind: await localGit(directory, 'rev-list', '--count', `HEAD..${remoteRef}`),
            ahead: await localGit(directory, 'rev-list', '--count', `${remoteRef}..HEAD`),
          }
        : { remoteBranch: 'absent' }),
      ...(defaultBehind && defaultBehind !== '0' ? { defaultBranch, defaultBehind } : {}),
    };
  };

  /**
   * `aivi_pr` — the pull request over this branch: aivi pushes first if
   * anything is unpushed (the smart push, its refusal said in its own
   * words), an open pull request is answered with, not doubled, and a
   * branch whose pull request **merged** with new commits since gets a
   * fresh one (ruled 2026-10-02). The title is what a pull request always
   * asks for; a checkpoint push asks for nothing — that is `aivi_push`.
   */
  readonly prTool: ToolHandler = async call => {
    const { run, directory, owned } = await this.#forgeRun(call, 'aivi_pr');
    const { title, body } = parsePr(call.input);
    const branch = await this.#workerBranch(directory);
    const existing = await owned.forge.prForBranch(owned.repo, branch);
    const moved = await this.#pushBranch(owned, directory, branch);
    if (existing && existing.state === 'open')
      return { pull: existing.url, state: 'open', ...(moved === 'pushed' ? { commitsPushed: true } : {}) };
    if (moved === 'already')
      throw new ToolError(
        409,
        existing
          ? `Nothing to push: the branch's pull request is ${existing.state} and ${branch} holds no new commits for a fresh one.`
          : `Nothing to push: origin/${branch} already has every commit here, and no pull request stands for the branch.`,
      );
    const opened = await owned.forge.openPr(owned.repo, branch, { author: run.agent, title, body });
    this.deps.log.info('run.pull.opened', { run: run.id, branch, repo: owned.repo.id, pull: opened.id });
    return { pushed: true, pull: opened.url, state: opened.state };
  };

  /** The branch's **open** pull request, said plainly when there is none:
   *  the reading and answering tools all start from this fact. */
  async #openPull(owned: ForgeOwner, directory: string): Promise<{ branch: string; pr: PrFacts }> {
    const branch = await localGit(directory, 'symbolic-ref', '--quiet', '--short', 'HEAD');
    if (!branch) throw new ToolError(409, 'This run sits on a detached HEAD; no branch, no pull request to read.');
    const pr = await owned.forge.prForBranch(owned.repo, branch);
    if (!pr || pr.state !== 'open')
      throw new ToolError(
        409,
        `No open pull request stands for ${branch}${pr ? ` (the last one is ${pr.state})` : ''}: aivi_pr opens one when the work is ready.`,
      );
    return { branch, pr };
  }

  /**
   * `aivi_review` — a fresh read of the pull request over this branch: open
   * threads with their replies, the plain conversation comments, the
   * approval states, and whether the base would take the merge. What the
   * completion gate checks, the worker can see for itself.
   */
  readonly reviewTool: ToolHandler = async call => {
    const { directory, owned } = await this.#forgeRun(call, 'aivi_review');
    const { pr } = await this.#openPull(owned, directory);
    const facts = await owned.forge.reviewFeedback(owned.repo, pr);
    return {
      pull: facts.pr.url,
      state: facts.pr.state,
      mergeable: facts.pr.mergeable,
      threads: facts.threads.map(t => ({
        id: t.id,
        ...(t.path ? { path: t.path } : {}),
        state: t.state,
        question: clip(t.question, 4000),
        replies: t.replies.map(r => ({
          author: r.author.login,
          ...(r.author.worker ? { worker: r.author.worker } : {}),
          body: clip(r.body, 4000),
        })),
      })),
      comments: facts.comments.map(c => ({
        author: c.author.login,
        ...(c.author.worker ? { worker: c.author.worker } : {}),
        body: clip(c.body, 4000),
        createdAt: c.createdAt,
      })),
      reviews: facts.reviews.map(r => ({ author: r.author.login, state: r.state })),
    };
  };

  /**
   * `aivi_respond_feedback` — the worker's answer to feedback, the one
   * channel the gate counts. With a `threadId`: reply to that open review
   * thread, signed, and resolve it — agreeing (the work was done) or
   * disagreeing (a grounded comment) both end resolved. Without one: a
   * plain PR comment, which is context, never a gate item. A thread a
   * person already resolved is not owed and not answerable here: they are
   * authoritative.
   */
  readonly respondTool: ToolHandler = async call => {
    const { run, directory, owned } = await this.#forgeRun(call, 'aivi_respond_feedback');
    const { threadId, body } = parseRespond(call.input);
    const { pr } = await this.#openPull(owned, directory);
    if (threadId) {
      const facts = await owned.forge.reviewFeedback(owned.repo, pr);
      if (!facts.threads.some(t => t.id === threadId))
        throw new ToolError(
          409,
          `Thread ${threadId} is not open on ${pr.url} — resolved (perhaps by a person, who is authoritative) or never there. aivi_review lists what is open.`,
        );
      await owned.forge.resolveThread(owned.repo, pr, threadId, { author: run.agent, text: body });
      this.deps.log.info('run.feedback.answered', { run: run.id, pull: pr.id, thread: threadId });
      return { answered: threadId, resolved: true };
    }
    await owned.forge.commentPr(owned.repo, pr, { author: run.agent, text: body });
    return { commented: true, pull: pr.url };
  };

  /**
   * `aivi_submit_review` — the review agent's voice on the pull request:
   * findings on the lines themselves, as a review the platform shows as
   * review threads — which is what makes agent feedback gate-owed on the
   * next round. APPROVE is not offered: the app authored the pull request
   * and GitHub refuses an author's own approval, so the approve button
   * stays human, forever.
   */
  readonly submitReviewTool: ToolHandler = async call => {
    const { run, directory, owned } = await this.#forgeRun(call, 'aivi_submit_review');
    const review = parseReview(call.input);
    const { pr } = await this.#openPull(owned, directory);
    await owned.forge.submitReview(owned.repo, pr, { author: run.agent, ...review });
    this.deps.log.info('run.review.submitted', { run: run.id, pull: pr.id, state: review.state });
    return { reviewed: true, state: review.state, findings: review.comments?.length ?? 0 };
  };

  /** The worker tools to claim on the host's tool door; the plugin registers them as `aivi_*`. */
  tools(): { descriptor: ToolDescriptor; handler: ToolHandler }[] {
    return [
      {
        descriptor: {
          namespace: 'aivi',
          name: 'work_complete',
          description:
            'Report that you have finished this ticket. Call this — do not just say you are done in text. ' +
            'Use outcome "success" when the ticket is genuinely resolved and "failure" when you could not ' +
            'finish it. End your turn right after calling it.',
          input: {
            type: 'object',
            properties: {
              outcome: { type: 'string', enum: ['success', 'failure'] },
              summary: { type: 'string', description: 'One line on what you did, or why you could not finish.' },
            },
            required: ['outcome', 'summary'],
            additionalProperties: false,
          },
        },
        handler: this.completeTool,
      },
      {
        descriptor: {
          namespace: 'aivi',
          name: 'ask',
          description:
            'Ask a human a question when you are blocked or need a decision. This reaches the person on the ' +
            'ticket and pauses the run until they answer. Give options when there are clear choices. End your ' +
            'turn right after calling it.',
          input: {
            type: 'object',
            properties: {
              question: { type: 'string' },
              options: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { label: { type: 'string' }, value: { type: 'string' } },
                  required: ['label', 'value'],
                  additionalProperties: false,
                },
              },
            },
            required: ['question'],
            additionalProperties: false,
          },
        },
        handler: this.askTool,
      },
      {
        descriptor: {
          namespace: 'aivi',
          name: 'plan',
          description:
            'Post or update your working plan for this ticket: the whole checklist at once, every step with ' +
            'a status of pending, inProgress, completed or canceled. People watch this while you work \u2014 send ' +
            'it before you start, and send the full list again whenever a step changes.',
          input: {
            type: 'object',
            properties: {
              steps: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    content: { type: 'string' },
                    status: { type: 'string', enum: ['pending', 'inProgress', 'completed', 'canceled'] },
                  },
                  required: ['content', 'status'],
                  additionalProperties: false,
                },
              },
            },
            required: ['steps'],
            additionalProperties: false,
          },
        },
        handler: this.planTool,
      },
      {
        descriptor: {
          namespace: 'aivi',
          name: 'push',
          description:
            'Move this branch’s commits to the remote as aivi’s own app — you never run git push, fetch or ' +
            'pull yourself. aivi fast-forwards, merges in the remote’s work, or (after your rebase) ' +
            'replaces the remote branch. A merge conflict comes back naming the files: resolve them with ' +
            'git, commit, and call this again.',
          input: { type: 'object', properties: {}, additionalProperties: false },
        },
        handler: this.pushTool,
      },
      {
        descriptor: {
          namespace: 'aivi',
          name: 'sync',
          description:
            'Bring the remote’s latest refs in through aivi (instead of git fetch or pull): answers how far ' +
            'this branch is behind and ahead. Look before you rebase or merge with your own git.',
          input: { type: 'object', properties: {}, additionalProperties: false },
        },
        handler: this.syncTool,
      },
      {
        descriptor: {
          namespace: 'aivi',
          name: 'pr',
          description:
            'Put a pull request over this branch: aivi pushes first if anything is unpushed — you never run ' +
            'git push yourself — and opens the pull request under this title and description. When the ' +
            'branch already has an open pull request, this answers with it and brings it the new commits.',
          input: {
            type: 'object',
            properties: {
              title: { type: 'string', description: 'The pull request title.' },
              body: { type: 'string', description: 'What this pull request does, for a human reviewer.' },
            },
            required: ['title'],
            additionalProperties: false,
          },
        },
        handler: this.prTool,
      },
      {
        descriptor: {
          namespace: 'aivi',
          name: 'review',
          description:
            'Read the pull request over your branch fresh: open review threads with their replies, plain ' +
            'conversation comments, the approval states, and whether the base would take the merge. What ' +
            'the completion gate checks, you can see.',
          input: { type: 'object', properties: {}, additionalProperties: false },
        },
        handler: this.reviewTool,
      },
      {
        descriptor: {
          namespace: 'aivi',
          name: 'respond_feedback',
          description:
            'Answer feedback as aivi. With a threadId: reply to that open review thread and resolve it — ' +
            'agreeing (do the work, aivi_push) or disagreeing (a grounded comment), both end resolved. ' +
            'Without one: a plain comment on the pull request, for anything the reviewers should know.',
          input: {
            type: 'object',
            properties: {
              threadId: { type: 'string', description: 'The open review thread this answers (from aivi_review).' },
              body: { type: 'string', description: 'Your answer, grounded in the work.' },
            },
            required: ['body'],
            additionalProperties: false,
          },
        },
        handler: this.respondTool,
      },
      {
        descriptor: {
          namespace: 'aivi',
          name: 'submit_review',
          description:
            'Say on the pull request what your review found, as a review with inline findings (they become ' +
            'review threads the next worker owes answers on). state: COMMENT for notes, REQUEST_CHANGES for ' +
            'problems. Approval is not offered — that button stays human.',
          input: {
            type: 'object',
            properties: {
              body: { type: 'string', description: 'The review, in words a human reads.' },
              state: { type: 'string', enum: ['COMMENT', 'REQUEST_CHANGES'], description: 'The verdict.' },
              findings: {
                type: 'array',
                description: 'What you found, on which file and line.',
                items: {
                  type: 'object',
                  properties: {
                    path: { type: 'string', description: 'The file the finding speaks to.' },
                    line: { type: 'number', description: 'The line, when you can name one.' },
                    body: { type: 'string', description: 'The finding itself.' },
                  },
                  required: ['path', 'body'],
                  additionalProperties: false,
                },
              },
            },
            required: ['body', 'state'],
            additionalProperties: false,
          },
        },
        handler: this.submitReviewTool,
      },
    ];
  }

  /**
   * Boot recovery. OpenCode resumes live turns across restarts on its own (the
   * operator has seen it every time), so this pass only re-attaches the watch —
   * it never restarts a turn. A run that was still `preparing` when aivi died
   * has no session to resume and fails visibly. Nothing is re-driven at
   * trackers: a follower reconciles its own platform from its own store and
   * these run records at its own boot.
   */
  async recover(): Promise<void> {
    for (const run of this.deps.ledger.active()) {
      if (!run.sessionId) {
        await this.#fail(run.id, 'The run was preparing when aivi stopped and could not be resumed.');
        continue;
      }
      this.#watch(run.sessionId, run.leaseId);
      // A wait that survived the restart keeps waiting: the keep-alive
      // re-arms from now — the silence during the outage cost nobody a
      // slot, so it owes nobody an earlier release.
      if (run.state === 'awaiting_input') this.#armElicitation(run.id);
    }
    // Moves that were owed when aivi died are owed still: the tracker's
    // move is idempotent, so re-driving a landed one lands as nothing.
    for (const trackerId of this.trackers.keys())
      for (const run of this.deps.ledger.moveOwed(trackerId)) void this.#move(run);
  }
}

function parseOutcome(input: Record<string, unknown>): RunOutcome {
  const summary = typeof input.summary === 'string' ? input.summary : '';
  if (input.outcome === 'success') return { kind: 'success', summary: summary || 'Completed.' };
  if (input.outcome === 'failure') return { kind: 'failure', reason: summary || 'The worker reported failure.' };
  throw new ToolError(400, 'outcome must be "success" or "failure".');
}

function parseQuestion(input: Record<string, unknown>): RunQuestion {
  const question = typeof input.question === 'string' ? input.question.trim() : '';
  if (!question) throw new ToolError(400, 'question is required.');
  const raw = Array.isArray(input.options) ? input.options : [];
  const options = raw
    .filter(
      o =>
        o &&
        typeof (o as { label?: unknown }).label === 'string' &&
        typeof (o as { value?: unknown }).value === 'string',
    )
    .map(o => ({ label: (o as { label: string }).label, value: (o as { value: string }).value }));
  return options.length ? { question, options } : { question };
}

function parsePlan(input: Record<string, unknown>): RunPlan {
  const raw = Array.isArray(input.steps) ? input.steps : [];
  const statuses = new Set(['pending', 'inProgress', 'completed', 'canceled']);
  const steps: RunPlanStep[] = [];
  for (const step of raw) {
    const content =
      step && typeof (step as { content?: unknown }).content === 'string'
        ? (step as { content: string }).content.trim()
        : '';
    const status = (step as { status?: unknown })?.status;
    if (!content || typeof status !== 'string' || !statuses.has(status))
      throw new ToolError(400, 'every step needs content and a status of pending, inProgress, completed or canceled.');
    steps.push({ content, status: status as RunPlanStep['status'] });
  }
  if (!steps.length) throw new ToolError(400, 'steps must hold at least one step.');
  return { steps };
}

function parsePr(input: Record<string, unknown>): { title: string; body: string } {
  const title = typeof input.title === 'string' ? input.title.trim() : '';
  if (!title) throw new ToolError(400, 'title is required.');
  const body = typeof input.body === 'string' ? input.body : '';
  return { title, body };
}

/** `aivi_respond_feedback`: an answer, optionally to a named thread. */
function parseRespond(input: Record<string, unknown>): { threadId?: string; body: string } {
  const body = typeof input.body === 'string' ? input.body.trim() : '';
  if (!body) throw new ToolError(400, 'body is required: what you say to the feedback, grounded in the work.');
  const threadId = typeof input.threadId === 'string' && input.threadId ? input.threadId : undefined;
  return { ...(threadId ? { threadId } : {}), body };
}

/** `aivi_submit_review`: a review verdict and inline findings. APPROVE is
 *  not in the state list and no string will ever talk this code into it. */
function parseReview(input: Record<string, unknown>): {
  body: string;
  state: 'COMMENT' | 'REQUEST_CHANGES';
  comments?: { path: string; line?: number; body: string }[];
} {
  const body = typeof input.body === 'string' ? input.body.trim() : '';
  if (!body) throw new ToolError(400, 'body is required: the review, in words a human reads.');
  if (input.state !== 'COMMENT' && input.state !== 'REQUEST_CHANGES')
    throw new ToolError(400, 'state is required: COMMENT or REQUEST_CHANGES. Approval stays a human button.');
  const findings: { path: string; line?: number; body: string }[] = [];
  const raw = Array.isArray(input.findings) ? input.findings : [];
  for (const finding of raw) {
    const f = finding as Record<string, unknown>;
    const path = typeof f.path === 'string' ? f.path : '';
    const text = typeof f.body === 'string' ? f.body.trim() : '';
    if (!path || !text)
      throw new ToolError(400, 'each finding needs a path and a body: what you found, on which file.');
    findings.push({ path, ...(typeof f.line === 'number' ? { line: f.line } : {}), body: text });
  }
  return { body, state: input.state, ...(findings.length ? { comments: findings } : {}) };
}

import { randomBytes } from 'node:crypto';
import type { Logger, ProjectLane, ToolDescriptor } from '@aivi/core';
import { errorMessage } from '@aivi/core';
import type { Dispatcher, DispatcherLease } from '../dispatcher/dispatcher.ts';
import type { SessionEvents } from '../events.ts';
import type { OpenCodeClient } from '../opencode.ts';
import type { ToolHandler } from '../tools.ts';
import { ToolError } from '../tools.ts';
import type { Run, RunLedger } from './ledger.ts';
import { view } from './ledger.ts';
import type {
  RunEvent,
  RunEventListener,
  RunOutcome,
  RunPlan,
  RunPlanStep,
  RunQuestion,
  RunView,
} from './vocabulary.ts';
import { isTerminal } from './vocabulary.ts';

/**
 * The orchestrator: the one authority that turns a ticket into a **run**. It
 * owns the run's state machine and nothing else — no platform vocabulary, no
 * webhooks, no rendering, no delivery. It knows tickets, lanes, OpenCode
 * (and, once the dispatcher lands, leases). A tracker module that wants to
 * follow **subscribes** to its typed events and renders them in its own
 * platform, in its own time, retrying its own failures: the orchestrator
 * never calls a tracker and never learns who listens.
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

/** Everything needed to start a run; the tracker builds `firstMessage` from
 *  the ticket, the worker contract below is the orchestrator's own words —
 *  the tools are the host's, so their explanation is core's, not any
 *  tracker's. The double-work guard is the ledger's: one active run per
 *  ticket, holding until the completion tool ends it. */
export interface WorkRequest {
  projectId: string;
  trackerId: string;
  ticketId: string;
  lane: string;
  agent: string;
  /** Where the worker works: the checkout this version; a worktree when a forge lands. */
  directory: string;
  firstMessage: string;
}

/**
 * A tracker's board, read pull-shaped: what the eligibility walk looks at
 * when it wants work, in neutral words. The `Tracker` seam is conversation-
 * keyed because a webhook arrives through an agent session; the walk has no
 * session — the feed is the module's own reading of its platform with its
 * own credentials, answering the orchestrator's pull-shaped questions.
 *
 * What it returns **is** eligible work: a feed leaves out archived tickets
 * and tickets a person marked for human hands, because those are the
 * platform's own words for "not for you", and the orchestrator never
 * learns the words.
 */
export interface TicketFeed {
  /** The projects this tracker speaks for, by core id. */
  projects(): string[];
  /** Tickets sitting in this state, in the board's own top-to-bottom order.
   *  `blocked` says a person's move is awaited, whatever the platform calls
   *  it; blocked tickets wait and are never claimed. */
  tickets(projectId: string, state: string): Promise<{ id: string; blocked: boolean }[]>;
  /** Move a ticket into the state: the queue pickup says it before starting,
   *  so the board shows the work as entered. */
  moveTo(projectId: string, ticketId: string, state: string): Promise<void>;
  /** The worker's first words for this ticket, or undefined when the ticket
   *  is gone — a deleted issue is not work, and the walk walks on. */
  firstMessage(projectId: string, ticketId: string, lane: ProjectLane): Promise<string | undefined>;
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
  /** Where a project's workers work: the checkout this version; a worktree
   *  lane gets one once a forge gives them. */
  directory: (projectId: string) => string;
  /** The dispatcher is the only part that knows how much capacity is left:
   *  the orchestrator asks it for every slot and never counts one itself. */
  dispatcher: Dispatcher;
  /** Premature turn-ends tolerated before the run fails visibly. A safety net, not a poller. */
  nudgeBudget?: number;
}

const NUDGE =
  'Your turn ended without reporting. If you are finished, call the aivi_work_complete tool ' +
  '(outcome "success" or "failure") with a one-line summary. If you are blocked or need a ' +
  'decision from a person, call the aivi_ask tool with your question. Do not just reply in text.';

/** The rules of the game, sent with the ticket at the start of every run.
 *  The tools are the host's, so their explanation lives here and no tracker
 *  repeats or rewords it; the nudge above is the same contract restated
 *  when a turn ends without either tool. */
const workerContract = (directory: string) =>
  `You are an aivi worker for one ticket, working in ${directory}. ` +
  'The ticket ends only through a tool call: when it is genuinely resolved, call aivi_work_complete with outcome ' +
  '"success" and a one-line summary; when you could not finish it, call the same tool with outcome "failure". ' +
  'When a person must decide something, give information, or grant permission, call aivi_ask with your question ' +
  'and options when there are clear choices; they answer on the ticket and the answer reaches you as a follow-up. ' +
  'Before you start, post your plan with aivi_plan \u2014 the whole checklist of steps, each with a status \u2014 and ' +
  'send the full list again whenever a step changes; people watch it while you work. ' +
  'End your turn right after calling one of the two tools. A turn that ends without either is treated as a failure. ' +
  'Never declare completion in plain text.';

export class Orchestrator {
  private readonly deps: OrchestratorDeps;
  private readonly budget: number;
  private readonly listeners = new Set<RunEventListener>();
  private readonly feeds = new Map<string, TicketFeed>();
  private readonly passings = new Map<string, Promise<void>>();

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
    this.budget = deps.nudgeBudget ?? 2;
  }

  /**
   * Follow the orchestrator's runs. A tracker module subscribes at start and
   * receives every run event — started, question, plan, ended — with the
   * fresh view of the run. Listening is optional; delivery is the
   * subscriber's problem: a listener that throws or fails loses nothing the
   * orchestrator cares about, and catches up from the run records it reads.
   * The returned function unsubscribes.
   */
  subscribe(listener: RunEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Emit one fact to every listener. A listener's failure is its own: said
   *  in the log, never carried back into the run. */
  #emit(event: RunEvent): void {
    for (const listener of this.listeners)
      void Promise.resolve(listener(event)).catch(error =>
        this.deps.log.warn('run.event.failed', { run: event.run.id, event: event.type, error }),
      );
  }

  /** The ending event for a terminal run row: its outcome, and the target
   *  lane when the lane order owed the ticket a move. */
  #endedEvent(run: Run): RunEvent {
    return {
      type: 'ended',
      run: view(run),
      outcome: run.outcome!,
      ...(run.targetLane ? { targetLane: run.targetLane } : {}),
    };
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
   */
  async requestWork(request: WorkRequest): Promise<{ runId: string; created: boolean; refused?: string }> {
    const live = this.deps.ledger.activeByTicket(request.trackerId, request.ticketId);
    if (live) return { runId: live.id, created: false };
    // Work cannot start without a lease — not even a delegation, which is
    // why the slot is taken before the row exists. A full pool creates no
    // run: the ticket stays in the board's hands, and the walk picks it up
    // when a slot frees. `refused` says so to the caller, never silence.
    const lane = this.deps.lanes(request.projectId).find(l => l.name === request.lane);
    const grant = this.deps.dispatcher.request({
      service: 'orchestrator',
      ...(lane?.pool ? { pool: lane.pool } : {}),
    });
    if ('refused' in grant) return { runId: '', created: false, refused: grant.refused };
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
    if (created) void this.#prepare(run.id, request.firstMessage, request.directory, grant.lease.id);
    return { runId: run.id, created: true };
  }

  /** Runs of this tracker that ended after the instant, oldest first: a
   *  follower's boot pass renders what it missed — including the endings
   *  of picked-up work, which have no delegation pair to be found in. */
  endedSince(trackerId: string, since: number): RunView[] {
    return this.deps.ledger.terminalSince(trackerId, since).map(view);
  }

  /**
   * Register a tracker's board for the walk (docs/orchestrator.md, "How work
   * gets picked"). A tracker module registers its feed at start; from then
   * on the orchestrator may ask it for work without any webhook pushing.
   */
  addFeed(trackerId: string, feed: TicketFeed): void {
    this.feeds.set(trackerId, feed);
  }

  /**
   * Look for work. Tracker events, completed work and dispatcher callbacks
   * all wake; a walk already running for a project chains the next one
   * behind it, so wakes never interleave two passes over one board.
   */
  async wake(projectId?: string): Promise<void> {
    const pairs: [string, string][] = [...this.feeds.entries()].flatMap(([trackerId, feed]) =>
      feed
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
    const feed = this.feeds.get(trackerId);
    if (!feed) return;
    const lanes = this.deps.lanes(projectId);
    const queueAt = lanes.findIndex(l => l.queue);
    const spent = new Set<string>();
    for (let at = lanes.length - 1; at >= 0; at--) {
      const lane = lanes[at]!;
      if (!lane.agent || lane.queue) continue; // humans work there; a queue is read as the bottom of its worker
      const asked = lane.pool ?? 'default';
      const fresh =
        queueAt >= 0 && this.#feedsQueue(lanes, queueAt, lane.name)
          ? await feed.tickets(projectId, lanes[queueAt]!.name)
          : [];
      const list = [
        ...(await feed.tickets(projectId, lane.name)).map(t => ({ ...t, fromQueue: false })),
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
        // Still eligible after the awaits — the ledger's guard is the claim:
        // a ticket that took a run while this pass was reading never takes
        // a second worker.
        const first = await feed.firstMessage(projectId, ticket.id, lane);
        if (first === undefined) {
          this.deps.dispatcher.release(grant.lease.id);
          continue;
        }
        const { run, created } = this.deps.ledger.request({
          projectId,
          trackerId,
          ticketId: ticket.id,
          lane: lane.name,
          agent: lane.agent,
        });
        if (!created) {
          this.deps.dispatcher.release(grant.lease.id);
          continue;
        }
        this.deps.ledger.setLease(run.id, grant.lease.id);
        if (ticket.fromQueue) {
          // Move-then-start: the ticket enters the worker lane before the
          // worker does, and the webhook this move sends finds a claim for
          // that very lane waiting — the follower's own redelivery guard
          // folds it into the claim instead of delegating twice.
          await feed.moveTo(projectId, ticket.id, lane.name);
        }
        void this.#prepare(run.id, first, this.deps.directory(projectId), grant.lease.id);
      }
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
  async leaseEnded(lease: DispatcherLease, reason: string): Promise<void> {
    const run = this.deps.ledger.byLease(lease.id);
    if (!run) return;
    await this.#fail(run.id, `The dispatcher ended the lease: ${reason}`, false);
  }

  /** A run of this project just ended: work may be claimable now. */
  #wakeAfter(run: Run): void {
    void this.#serialized(run.trackerId, run.projectId).catch(error =>
      this.deps.log.warn('walk.after-end.failed', { project: run.projectId, error }),
    );
  }

  /** Give back the slot a terminal run's claim held, if it still stands. */
  #releaseLease(run: Run): void {
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

  /** Provide the lease with its session and send the task. The dispatcher
   *  creates the session and decides its model (the pool's, or the agent
   *  file's where no pool names one); the orchestrator only ever says agent
   *  and directory. Any failure fails the run visibly, never silently, and
   *  gives the slot back. */
  async #prepare(runId: string, firstMessage: string, directory: string, leaseId: string): Promise<void> {
    const log = this.deps.log.with({ run: runId });
    try {
      const run = this.deps.ledger.get(runId);
      if (!run) return;
      const lease = await this.deps.dispatcher.provide(leaseId, { agent: run.agent, directory });
      const sessionId = lease.sessionId!;
      // Watch before prompting: a live-only stream must not miss the first turn's end.
      this.#watch(sessionId, leaseId);
      const client = await this.deps.opencode();
      const request = { signal: this.deps.signal };
      const working = this.deps.ledger.attachSession(runId, sessionId, directory);
      // The follower learns the pair (ticket, its own session, this OpenCode
      // session) here — before the first prompt, so nothing it must render
      // arrives unpaired.
      this.#emit({ type: 'started', run: view(working) });
      await client.session.prompt(
        {
          sessionID: sessionId,
          id: `msg_${randomBytes(6).toString('hex')}`,
          text: `${firstMessage}\n\n${workerContract(directory)}`,
          delivery: 'queue',
        },
        request,
      );
      log.info('run.started', { session: sessionId, directory });
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
        text: NUDGE,
        delivery: 'queue',
      });
    } catch (error) {
      this.deps.log.warn('run.nudge.failed', { run: run.id, error });
    }
  }

  /** A stop: interrupt the worker and end the run as cancelled. A stopped
   *  ticket stays where it is — the person who stopped it left it where they
   *  wanted it. */
  async stop(runId: string, reason: string): Promise<void> {
    const run = this.deps.ledger.get(runId);
    if (!run || run.state !== 'working') return;
    try {
      if (run.sessionId) {
        const client = await this.deps.opencode();
        await client.session.interrupt({ sessionID: run.sessionId });
      }
    } catch (error) {
      this.deps.log.warn('run.interrupt.failed', { run: runId, error });
    }
    const ended = this.deps.ledger.cancel(runId, reason);
    this.#releaseLease(ended);
    this.#emit(this.#endedEvent(ended));
    this.#wakeAfter(ended);
  }

  async #fail(runId: string, reason: string, workerEnded = false): Promise<void> {
    const run = this.deps.ledger.get(runId);
    if (!run || run.state === 'completed' || run.state === 'cancelled') return;
    // A failure the worker's own turn produced (nudge budget spent) moves the
    // ticket like any failure; aivi's own failures (a session that never came
    // up) leave it exactly where the person can see it.
    const ended = this.deps.ledger.finish(
      runId,
      { kind: 'failure', reason },
      workerEnded ? this.#moveTarget(run, false) : undefined,
    );
    this.#releaseLease(ended);
    this.#emit(this.#endedEvent(ended));
    this.#wakeAfter(ended);
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

  /** The worker says it is done. A tool call, so it is a fact: end the run,
   *  record where the lane order sends the ticket, and emit the ending for
   *  whoever follows. Telling the platform is nobody here's business. */
  readonly completeTool: ToolHandler = async call => {
    const run = this.deps.ledger.bySession(call.sessionId);
    if (!run) throw new ToolError(404, 'This session is not an aivi run; aivi_work_complete is not available here.');
    if (isTerminal(run.state)) throw new ToolError(409, `This run already ended (${run.state}).`);
    const outcome = parseOutcome(call.input);
    const ended = this.deps.ledger.finish(run.id, outcome, this.#moveTarget(run, outcome.kind === 'success'));
    this.#releaseLease(ended);
    this.#emit(this.#endedEvent(ended));
    this.#wakeAfter(ended);
    return { recorded: true, outcome: outcome.kind };
  };

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
            }
          : { key: 'answer', type: 'string', title: question.question, required: true },
      ],
    });
    const withForm: RunQuestion = { ...question, formId: form.id };
    this.deps.log.info('run.question', { run: run.id, form: form.id });
    this.#emit({ type: 'question', run: view(this.deps.ledger.get(run.id)!), question: withForm });
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
    this.#emit({ type: 'plan', run: view(this.deps.ledger.get(run.id)!), plan });
    return { recorded: true, steps: plan.steps.length };
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
    }
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

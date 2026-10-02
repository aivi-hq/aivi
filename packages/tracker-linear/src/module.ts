/**
 * The Linear module: the platform's listener, adapter and **follower**.
 * Everything Linear-shaped — webhooks, GraphQL, activity types, the apps and
 * their credentials — lives behind `./tracker.ts`. The host's **orchestrator**
 * owns a run: its durable record, its OpenCode session, the worker tools and
 * the rule that only a tool call ends it — and it never calls us. We
 * **subscribe** to its typed events and catch Linear up: the pair (agent
 * session ↔ OpenCode session ↔ ticket) lives in our own store; a run's ending
 * is rendered in our order — the result first, because Linear's response is
 * what stops the "working" state, then the lane move the orchestrator's lane
 * order chose, then taking the delegate back. Our failures stay ours: they
 * retry on the next wake and at boot, decided against Linear's real state,
 * never a flag in somebody else's database. A person's message into a worker's
 * session never passes through the orchestrator either: we post it straight
 * into the OpenCode session — an answer when a form is open, a steer
 * otherwise. What stays ours besides all that is the assistant — the
 * conversation a person brings us directly, which still rides the channel
 * machinery until the channels reform.
 */
import { errorMessage, laneOf, type Project, type ProjectLane } from '@aivi/core';
import type { TicketFeed } from '@aivi/host';
import {
  ChannelEngine,
  ConfigurationError,
  ConversationStore,
  createTurnRunner,
  isTerminal,
  stopTurn as stopRunningTurn,
} from '@aivi/host';
import type { AiviModule, AiviServices, RunEvent, Store } from '@aivi/plugin';
import type { ChannelDelivery, ChannelPlatform, Turn } from '@aivi/plugin/channel';
import type { Tracker, TrackerChange, TrackerCommentKind, TrackerEvent, TrackerIssue } from '@aivi/plugin/tracker';
import type { LinearClient } from './client.ts';
import type { LinearConfig } from './config.ts';
import { assistantAgent, MODULE_ID, primaryLinearApp } from './config.ts';
import { issueDossier, linearFeed } from './feed.ts';
import { type RunLink, RunLinks } from './links.ts';
import type { LinearMcp } from './mcp.ts';
import { linearTeamCollisions, projectForIssue } from './projects.ts';
import { StoppedTickets } from './stopped.ts';
import { clientFor, createLinearTracker, LinearTracker } from './tracker.ts';
import { WalkWatermark } from './watermark.ts';

/**
 * The platform: an agent session is a conversation. Its id is `<app>:<agent session id>`
 * so a turn always knows which app's token speaks for it, restarts included. Assistant
 * turns have effects beyond their reply, so a restart mid-turn blocks instead of discarding.
 */
export const LINEAR: ChannelPlatform = {
  // The **platform** id, and so the table prefix, the lease owner, the session
  // and message id prefixes and the session origin. It says who a conversation
  // is on, which is Linear, not which package happens to speak for it: renaming
  // it would leave every bound conversation in an existing database pointing at
  // a table nobody opens. The module's own id — `plugins.tracker-linear`, the
  // log category — is `MODULE_ID`, and the two are deliberately different.
  id: 'linear',
  label: 'Linear',
  replyLimit: 60_000,
  effects: 'work',
  describeSpeaker: turn => `[Linear follow-up from ${turn.name}]`,
  notices: {
    failed: 'This worker hit an error',
    stopped: 'Stopped at your request. The OpenCode session is left as it is for inspection.',
    notStarted: 'I could not reach my agent runtime, so nothing was started. Send another message to try again.',
    offline: 'aivi is going offline (a restart or shutdown). This assistant turn was stopped.',
    offlineMidReply: 'aivi is going offline while posting my answer; it may be incomplete.',
    offlineQueued:
      'aivi is going offline (a restart or shutdown). This request stays queued and starts when it is back.',
    blocked:
      'I could not finish this and cannot tell whether the agent stopped. An operator has been notified; the issue waits until they resolve it.',
  },
};

export function openLinearStore(store: Store): ConversationStore {
  // Every conversation is bound individually; the module binding never changes.
  return new ConversationStore(store, LINEAR, 'linear');
}

/** The `<issue>` block that accompanies every start when the event brought
 *  no context of its own. */
// Which aivi project an issue belongs to lives in `./projects.ts` with the
// project's `linear` section: core hands the section through unread and the
// plugin merges it here.

/** Where the module's tracker comes from: Linear's adapter by default, a
 *  fake tracker in a test of the decisions below. */
type MakeTracker = (services: AiviServices) => Promise<Tracker>;

/**
 * The module, built on a tracker. What lives here is routing and Linear's
 * voice — the `Tracker` contract decides what a question and an outcome look
 * like on Linear; the run itself — its record, session, tools and exits — is
 * the host orchestrator's, and Linear is one follower among any number it
 * will never know about.
 */
/** The board, pull-shaped, for the orchestrator's walk; a test hands its own
 *  lanes the way it hands its own tracker. */
type MakeFeed = (services: AiviServices) => TicketFeed;

export function createLinearModule(config: LinearConfig, makeTracker?: MakeTracker, makeFeed?: MakeFeed): AiviModule {
  return {
    id: MODULE_ID,
    start: services =>
      startLinear(
        config,
        services,
        makeTracker ?? (({ routes, log }) => createLinearTracker(config, routes, undefined, log.getChild(MODULE_ID))),
        makeFeed ?? (s => linearFeed(config, s, s.log.getChild(MODULE_ID))),
      ),
  };
}

async function startLinear(config: LinearConfig, services: AiviServices, makeTracker: MakeTracker, makeFeed: MakeFeed) {
  const log = services.log.getChild(MODULE_ID);
  const collisions = linearTeamCollisions(services.loaded);
  if (collisions.length) throw new Error(`Linear config: ${collisions.join('; ')}`);
  const store = openLinearStore(services.store);
  const links = new RunLinks(services.store);
  // The installation's own reader: the primary app when it is named, else
  // the first configured — every app reads the same workspace, so the
  // choice is credentials and nothing more. Picked-up work has no agent
  // session to speak through; what its ticket is owed is said with these.
  const readerApp = primaryLinearApp(config) ?? Object.keys(config.apps)[0]!;
  let reader: LinearClient | undefined;
  const read = () => (reader ??= clientFor(config, readerApp, log));
  const stopped = new StoppedTickets(services.store);
  const watermark = new WalkWatermark(services.store);
  const interrupted = store.recover();
  if (interrupted.length) log.warn('turns.interrupted', { blocked: interrupted.length });

  // The adapter takes the whole platform in: apps, credentials, endpoints.
  const tracker = await makeTracker(services);
  // The eligibility walk reads the board through this feed: which projects
  // this installation speaks for, what sits in a lane, how a ticket enters
  // one. Webhooks keep pushing delegations; the walk needs none of them.
  services.orchestrator.addFeed(MODULE_ID, makeFeed(services));

  const abort = new AbortController();
  let engine: ChannelEngine | undefined;
  const stop = () => {
    abort.abort();
    engine?.stop();
  };
  services.signal.addEventListener('abort', stop, { once: true });
  let mcp: LinearMcp | undefined;
  const teardown = async () => {
    stop();
    try {
      await engine?.shutdown();
    } finally {
      await mcp?.stop();
      services.signal.removeEventListener('abort', stop);
    }
  };

  const say = (conversation: string, text: string, kind: TrackerCommentKind) =>
    tracker.comment(conversation, text, kind).catch(error => log.warn('notify.failed', { error }));

  try {
    const home = services.loaded.path.replace(/\/[^/]*$/, '');
    // The assistant's turn machinery. A worker is NOT here: the orchestrator
    // creates the worker's own OpenCode session and drives it; only the
    // conversations people bring us directly ride this engine.
    const ask = await createTurnRunner(
      LINEAR,
      { agent: 'unbound', directory: home },
      services.loaded,
      services.opencode,
      services.events,
      services.store,
      services.log,
    );
    // The adapter's agent-session activities are Linear's way to deliver:
    // answers and outcomes visible, progress the ephemeral thought.
    const delivery: ChannelDelivery = {
      send: async (conversation, text) => tracker.comment(conversation, text, 'answer'),
      placeholder: async (conversation, text) => tracker.comment(conversation, text, 'progress'),
      edit: async (conversation, _id, text) => {
        await tracker.comment(conversation, text, 'progress');
      },
      delete: async () => {}, // the response that follows replaces the ephemeral thought
      notice: async (conversation, text) => {
        await tracker.comment(conversation, text, 'outcome');
      },
    };
    engine = new ChannelEngine(
      store,
      { resource: config.resource, maxConcurrent: 8, turnTimeoutMs: config.turnTimeoutMs },
      services.loaded.config.scheduler,
      ask,
      delivery,
      {
        log, // the module's own child, so engine records carry the module category
        onRelease: services.wake,
        onFailure: services.fail,
        progress: { mode: config.progress, events: services.events },
      },
    );

    const refuse = async (conversation: string, why: string) => {
      log.info('session.refused', { conversation, why });
      await say(conversation, why, 'outcome');
    };

    /** A delegation no lane can run gets one plain, fixed answer: the
     *  assistant holds conversations people bring it, it does not improvise
     *  over a job the config never claimed. The delegate is un-taken first —
     *  the app must not sit on the ticket as a worker it cannot be. */
    const unclaimed = async (issue: TrackerIssue, conversation: string, why: string) => {
      log.info('session.unclaimed', { conversation, issue: issue.identifier, why });
      await tracker.unassign(conversation, issue.id).catch(error => log.warn('delegate.undone', { error }));
      await say(
        conversation,
        `I looked into ${issue.identifier}, and there is nothing I can do at this time: ${why} I have removed myself as delegate — @mention me if you want to talk about it.`,
        'answer',
      );
    };

    /**
     * The follower's catch-up: make Linear say what the run says, in our
     * order. The **result first** — Linear's response completes the agent
     * session and stops the "working" state, the human-visible wound — then
     * the **closing note** on the ticket (a forwarding of the same text, so
     * the ending is readable without opening the session), then the
     * **move** the orchestrator's lane order chose (a follower performs a
     * decision, it never makes one), then the **delegate**, which Linear
     * leaves sitting. Each step asks Linear's real state before acting
     * (`resultShown`, the issue's current state, the current delegate), so a
     * half-landed ceremony re-drives without saying anything twice. A failure
     * keeps the run owed in memory; the next wake tries again, and the boot
     * pass re-derives the list from our own pairs — no outbox lives in the
     * orchestrator's record, because delivery is ours.
     */
    const owed = new Map<string, { event: Extract<RunEvent, { type: 'ended' }>; link: RunLink }>();

    const drive = async (runId: string): Promise<void> => {
      const entry = owed.get(runId);
      if (!entry) return;
      const { event, link } = entry;
      const conversation = tracker.idFor(link.agentSession);
      try {
        if (!(await tracker.resultShown(conversation))) {
          if (event.outcome.kind === 'success') await tracker.comment(conversation, event.outcome.summary, 'answer');
          else await tracker.comment(conversation, event.outcome.reason, 'outcome');
        }
        // The ending readable on the ticket itself, not only inside the
        // session (ruled 2026-10-02). The adapter is idempotent, so this
        // rides every retry without ever saying it twice.
        if (tracker.closingNote)
          await tracker.closingNote(
            conversation,
            event.run.ticketId,
            event.outcome.kind === 'success' ? event.outcome.summary : event.outcome.reason,
          );
        if (event.targetLane) {
          const issue = await tracker.issue(conversation, event.run.ticketId);
          if (issue.state.name !== event.targetLane) {
            if (!tracker.apply) throw new Error('Linear cannot apply a move');
            await tracker.apply(conversation, event.run.ticketId, { kind: 'move', lane: event.targetLane });
          }
        }
        // Only a success releases the ticket from the app's hands; a failure
        // leaves the delegate sitting so the session stays the readable trail
        // and the next lane change re-triggers through the ordinary path.
        if (event.outcome.kind === 'success')
          await tracker
            .unassign(conversation, event.run.ticketId)
            .catch(error => log.warn('delegate.undone', { error }));
        owed.delete(runId);
        log.info('run.caughtup', { run: runId, ticket: event.run.ticketId });
      } catch (error) {
        // Ours to retry, not the run's to carry: it stays owed and the next
        // wake or boot tries again. Never silence — the log says it plainly.
        log.warn('catchup.failed', { run: runId, error });
      }
    };

    const catchUp = async (event: Extract<RunEvent, { type: 'ended' }>, link: RunLink): Promise<void> => {
      if (owed.has(event.run.id)) return; // the event and the boot pass may race for one run
      owed.set(event.run.id, { event, link });
      await drive(event.run.id);
    };

    /**
     * A picked-up run's ending, owed to the ticket without an agent session:
     * the **closing note** on the ticket, then the **move** the lane order
     * chose — both ask Linear's real state first, so the live event and the
     * boot pass can both try without ever saying anything twice. There is no
     * result step (no session to complete) and no delegate to release (the
     * app never sat on this ticket as its worker). A failure keeps the run
     * owed: the next wake tries again, and the boot pass re-derives the list
     * from the orchestrator's record through the watermark.
     */
    const walkOwed = new Map<string, Extract<RunEvent, { type: 'ended' }>>();

    const walkEnding = async (event: Extract<RunEvent, { type: 'ended' }>): Promise<void> => {
      // The stop's memory rides the ending even when the ending arrives
      // after a restart: the event fired while nobody listened, but the
      // person said stop and that stands.
      if (event.run.state === 'cancelled') stopped.mark(event.run.ticketId);
      const text = event.outcome.kind === 'success' ? event.outcome.summary : event.outcome.reason;
      if (tracker.closingNote) await tracker.closingNote(readerApp, event.run.ticketId, text);
      if (event.targetLane) {
        const issue = await tracker.issue(readerApp, event.run.ticketId);
        if (issue.state.name !== event.targetLane) {
          if (!tracker.apply) throw new Error('Linear cannot apply a move');
          await tracker.apply(readerApp, event.run.ticketId, { kind: 'move', lane: event.targetLane });
        }
      }
      watermark.advanceTo(event.run.updatedAt);
      log.info('walk.caught-up', { run: event.run.id, ticket: event.run.ticketId });
    };

    const driveWalk = async (runId: string, event?: Extract<RunEvent, { type: 'ended' }>): Promise<void> => {
      if (event) walkOwed.set(runId, event);
      const ending = walkOwed.get(runId);
      if (!ending) return;
      try {
        await walkEnding(ending);
        walkOwed.delete(runId);
      } catch (error) {
        log.warn('walk.catchup.failed', { run: runId, error }); // owed to the next wake and to the boot pass
      }
    };

    /** The wait made visible where the ticket lives: picked-up work has no
     *  agent session to carry a `select`, so the question arrives as a
     *  ticket comment while the OpenCode form stays the durable record of
     *  the wait — the answer reaches the worker through the form, and the
     *  elicitation keep-alive holds the slot meanwhile (docs/orchestrator.md). */
    const walkQuestion = async (event: Extract<RunEvent, { type: 'question' }>): Promise<void> => {
      const options = event.question.options?.length
        ? `\n\n${event.question.options.map(o => `- ${o.label}`).join('\n')}`
        : '';
      await read().createComment(
        event.run.ticketId,
        `The worker on this ticket needs an answer:\n\n> ${event.question.question}${options}\n\nAnswer in the worker's session and it reaches them there; the ticket keeps its slot until the elicitation keep-alive says otherwise.`,
      );
    };

    const retryOwed = async (): Promise<void> => {
      for (const runId of [...owed.keys()]) await drive(runId);
      for (const runId of [...walkOwed.keys()]) await driveWalk(runId);
    };

    /** The pair store's other half: `started` attaches the OpenCode session
     *  to the delegation we recorded; question and plan render as they
     *  arrive; `ended` starts the catch-up. A listener's failure is said in
     *  the log — the orchestrator never waits on us. */
    const unsubscribeRuns = services.orchestrator.subscribe(async (event): Promise<void> => {
      if (abort.signal.aborted || event.run.trackerId !== MODULE_ID) return;
      // The stop and its answer are recorded in the same synchronous breath
      // the events arrive: the walk wakes off the very ending, and a pass
      // starting one microtask later must never read a board not yet told.
      if (event.type === 'ended' && event.run.state === 'cancelled') stopped.mark(event.run.ticketId);
      if (event.type === 'started') stopped.clear(event.run.ticketId); // a fresh run answers the stop
      try {
        if (event.type === 'started') {
          if (event.run.sessionId) links.attach(event.run.ticketId, event.run.sessionId);
          return;
        }
        const link = event.run.sessionId ? links.byOpencodeSession(event.run.sessionId) : undefined;
        if (!link) {
          // A run the eligibility walk picked up: no delegation, so no agent
          // session — and the ticket is owed its ceremony all the same, with
          // the installation's own credentials. The question gets the ticket
          // as its comment, because the person who must answer watches the
          // ticket; the plan is the one thing a sessionless run cannot show,
          // and the lane it moves in says enough.
          if (event.type === 'ended') return void (await driveWalk(event.run.id, event));
          if (event.type === 'question') return void (await walkQuestion(event));
          if (event.type === 'plan') return log.info('plan.sessionless', { run: event.run.id });
          // Today every event has its sessionless answer above; an event
          // type added later says so here, loudly, instead of going quiet.
          return void log.warn('event.sessionless.unrendered');
        }
        const conversation = tracker.idFor(link.agentSession);
        if (event.type === 'question') return void (await tracker.ask(conversation, event.question));
        if (event.type === 'plan') return void (await tracker.plan(conversation, event.plan.steps));
        await catchUp(event, link);
      } catch (error) {
        log.warn('run.event.failed', { error });
      }
    });

    /**
     * A delegated issue a lane claims is handed to the orchestrator. The pair
     * is recorded **before** the request — the `started` event arrives from
     * the background preparation and must find its agent session waiting.
     * The work environment is the project's checkout: ruled 2026-09-30,
     * forge → the forge's worktree, no forge → the source dir — and no forge
     * is wired yet. The ledger's guard answers a redelivery with the live
     * run, so one ticket never gets two workers at a time.
     */
    const handWork = async (
      issue: TrackerIssue,
      project: Project,
      lane: ProjectLane,
      conversation: string,
      promptContext?: string,
    ): Promise<void> => {
      const agent = lane.agent;
      if (!agent) return log.warn('lane.without.agent', { issue: issue.identifier, lane: issue.state.name });
      const directory = project.directory;
      const { app, session: agentSession } = tracker.parts(conversation);
      links.bind(agentSession, issue.id);
      const { created, refused, queued } = await services.orchestrator.requestWork({
        projectId: project.id,
        trackerId: MODULE_ID,
        ticketId: issue.id,
        lane: issue.state.name,
        agent,
        directory,
        firstMessage: [
          `[Linear delegated ${issue.identifier} "${issue.title}" to you (app ${app}) in project ${project.id}, lane "${issue.state.name}". You work in the project's checkout ${directory}; the agent file says what you may change.]`,
          promptContext ?? issueDossier(issue),
        ].join('\n\n'),
      });
      if (queued) {
        // No slot now, but the request holds the pool's queue place and the
        // pair stays bound: when the lease lands the run attaches here and
        // the worker speaks in this very session. A progress line for the
        // wait; the start itself will say more.
        await say(
          conversation,
          `Every slot in the pool behind lane "${issue.state.name}" is working. ${issue.identifier} waits in the queue and I start it the moment one frees.`,
          'progress',
        );
        return log.info('run.queued', { issue: issue.identifier, request: queued, conversation });
      }
      if (refused) {
        // No slot and no queue place either — said plainly, because silence
        // is not an answer a delegator gets. The ticket stays in the lane
        // it is in, and the eligibility walk starts it when a slot frees;
        // the pair goes with the refusal so that moment arrives as fresh
        // work, not a swallowed replay.
        links.release(agentSession);
        await say(
          conversation,
          refused === 'waiting'
            ? `The pool behind lane "${issue.state.name}" already holds a request of mine, and a pool waits for one at a time. ${issue.identifier} is not started — the walk will take it when a slot frees.`
            : `No slot is free in the pool behind lane "${issue.state.name}" right now. ${issue.identifier} stays where it is and I will start it as soon as a slot frees.`,
          'answer',
        );
        return log.info('run.refused', { issue: issue.identifier, pool: refused, conversation });
      }
      if (!created) return log.info('run.deduped', { issue: issue.identifier, conversation });
      // The first activity inside the session's first seconds: Linear marks a
      // silent new session unresponsive. The orchestrator's own progress
      // stream (the ephemeral thought) comes with the session observer later.
      await say(
        conversation,
        `Starting as \`${lane.agent}\` in project ${project.id}, working in the project checkout.`,
        'progress',
      );
    };

    /**
     * The assistant: who people reach directly. A delegation nothing claims
     * is un-taken here; the assistant's response is the trail.
     */
    const startAssistant = async (
      issue: TrackerIssue,
      project: Project | undefined,
      conversation: string,
      promptContext?: string,
    ) => {
      store.bind(conversation, {
        agent: assistantAgent(services.loaded.config.plugins['tracker-linear'] as LinearConfig | undefined),
        directory: project ? project.directory : home,
        project: project?.id ?? null,
      });
      await say(conversation, `One moment — reading ${issue.identifier}.`, 'progress');
      // Facts only: who is talking and what was brought. How the assistant
      // behaves with them is the agent file's, the whole boundary. A
      // delegation never arrives here: what no lane can run is answered
      // plainly before any agent is bound.
      const situation = `[platform: linear; issue: ${issue.identifier} "${issue.title}"; project: ${project?.id ?? 'none'}; came by: a person brought you the issue]`;
      const text = [situation, promptContext ?? issueDossier(issue)].join('\n\n');
      const { session: sessionId } = tracker.parts(conversation);
      store.enqueue(
        {
          id: `created:${sessionId}`,
          channel: conversation,
          user: tracker.ownerOf(conversation),
          name: 'Linear',
          text,
        },
        100,
      );
    };

    /** End the assistant turn in `conversation` because the person asked; the session stays. */
    const stopAssistant = async (conversation: string, why: string) => {
      const result = await stopRunningTurn(engine!, services.opencode, conversation);
      if (result.error) log.warn('stop.interrupt_failed', { error: result.error });
      // The engine's stopped notice follows for a running turn; queued-only conversations hear this one.
      if (!result.stopped) await say(conversation, why, 'outcome');
      else await say(conversation, why, 'note');
      log.info('assistant.stopped', { conversation, why });
    };

    /**
     * A session started. Routing is deterministic, from the issue re-read:
     * a redelivery finds the pair we recorded, the live run, or the bound
     * conversation and stops; a deleted ticket gets nothing at all; the HITL
     * label refuses for any agent — the tracker decides what needs-human looks
     * like on its platform; a delegation whose lane maps an agent is handed to
     * the orchestrator; a delegation no lane can run gets its delegate
     * un-taken and one plain fixed answer saying why; and what a person brings
     * us any other way — a comment mention above all — lands on the assistant.
     * The face is never a routing input: a delegation into a mapped lane runs
     * the lane's agent whatever app the session lives on.
     */
    const onStarted = async (conversation: string, issueId: string, promptContext?: string) => {
      const { session: agentSession } = tracker.parts(conversation);
      if (
        store.has(conversation) ||
        (agentSession && links.byAgentSession(agentSession)) ||
        (issueId && services.orchestrator.activeRun(MODULE_ID, issueId))
      )
        return; // a redelivery
      if (!issueId) return refuse(conversation, 'I only work on issues; this session has none.');
      const issue = await tracker.issue(conversation, issueId);
      if (issue.archived) return log.debug('session.archived', { issue: issue.identifier });
      if (issue.labels.some(l => l.name === config.humanLabel))
        return refuse(
          conversation,
          `${issue.identifier} carries the \`${config.humanLabel}\` label, so a person handles it. Remove the label to let me work on it.`,
        );
      const routed = projectForIssue(services.loaded, {
        teamId: issue.teamId,
        // The org the app's own credentials belong to: the issue was read
        // with that token, so it is the trustworthy workspace, not the words
        // of whichever delivery mentioned one.
        organizationId: await tracker.orgOf(conversation),
      });
      const lane = routed && laneOf(routed.project, issue.state.name);
      if (issue.delegateId === tracker.ownerOf(conversation)) {
        // The app was named to work: a lane that claims it hands the ticket to
        // the orchestrator; a delegation nothing can run is answered plainly,
        // and no agent is left behind to improvise.
        if (issue.completed)
          return refuse(conversation, `${issue.identifier} is already finished as far as work goes; nothing to start.`);
        if (routed && lane?.agent) {
          await handWork(issue, routed.project, lane, conversation, promptContext);
        } else if (!routed) {
          await unclaimed(issue, conversation, 'its team is not connected to an aivi project.');
        } else if (lane) {
          await unclaimed(
            issue,
            conversation,
            `the "${issue.state.name}" lane is worked by humans — it names no agent.`,
          );
        } else {
          await unclaimed(
            issue,
            conversation,
            `"${issue.state.name}" is not a lane of project ${routed?.project.id ?? 'this'} — it names no place in the workflow.`,
          );
        }
        return;
      }
      // A person addressing us is a conversation the assistant holds,
      // mapped lanes or not.
      await startAssistant(issue, routed?.project, conversation, promptContext);
      engine?.tick();
    };

    /**
     * A person's message inside a session. If a run lives on the pair, the
     * **orchestrator is not in this path**: we post into the OpenCode session
     * ourselves, and the open form is the discriminator — a pending form makes
     * the message an ANSWER (the worker gets the text, the form closes as the
     * record; OpenCode resumes the session), its absence an INTERJECTION
     * steered into the running turn — never read from the words. Otherwise
     * the assistant holds the conversation, and a follow-up to a finished run
     * is the assistant answering about a ticket it can read afresh.
     */
    const onPrompted = async (event: Extract<TrackerEvent, { kind: 'prompted' }>) => {
      const conversation = event.conversation;
      const { session: agentSession } = tracker.parts(conversation);
      const link = agentSession ? links.byAgentSession(agentSession) : undefined;
      const record = link?.opencodeSession ? services.orchestrator.runBySession(link.opencodeSession) : undefined;
      // Only a run still live on the pair makes this a working session. A
      // finished one is the assistant's ground: a message into a completed
      // conversation is a follow-up, not an answer or an interjection.
      const run = record && !isTerminal(record.state) ? record : undefined;
      if (event.signal === 'stop') {
        if (run) {
          // Stop means stop: the worker is interrupted and the run ends
          // cancelled; the ending's catch-up renders Linear's final activity.
          await services.orchestrator.stop(run.id, `A person asked to stop ${run.ticketId} from the session.`);
          return;
        }
        if (!store.has(conversation))
          return refuse(
            conversation,
            'I do not know this session (it started before aivi did, or its state is gone). Delegate the issue to me again.',
          );
        const result = await stopRunningTurn(engine!, services.opencode, conversation);
        if (result.error) log.warn('stop.interrupt_failed', { error: result.error });
        if (!result.stopped) await say(conversation, 'Nothing is running right now.', 'answer');
        return;
      }
      const text = event.body?.trim();
      if (!text) return;
      if (run?.sessionId) {
        const client = await services.opencode();
        const [form] = await client.session.form.list({ sessionID: run.sessionId });
        if (form) {
          // The orchestrator owns the answer's delivery: the slot may have
          // been given back while the person thought, and an answer that
          // finds no capacity **reacquires** it — in the session's own pool,
          // queue included — before the same session resumes. The worker
          // gets the text first, then the form closes as the record.
          const outcome = await services.orchestrator.answer(run.sessionId, text, form.id);
          if ('refused' in outcome)
            return refuse(
              conversation,
              'The worker’s slot is gone and no capacity is free to wake it again — the pool behind its lane is full and its one queue place is taken. The question still stands: answer it again once a slot opens.',
            );
          if ('queued' in outcome)
            await say(
              conversation,
              'I have your answer. No slot is free to wake that worker yet, so it wakes the moment one opens.',
              'progress',
            );
          return log.info('run.answered', { run: run.id, form: form.id, ...outcome });
        }
        try {
          // Interjections steer (ruled 2026-10-01): the message lands between
          // turns and steers what comes next. With no turn to steer, the same
          // message queues instead — said in the log, never lost.
          await client.session.prompt({
            sessionID: run.sessionId,
            id: `msg_${crypto.randomUUID()}`,
            text,
            delivery: 'steer',
          });
          return log.info('run.interjected', { run: run.id });
        } catch (error) {
          log.warn('run.steer.failed', { run: run.id, error });
          await client.session.prompt({
            sessionID: run.sessionId,
            id: `msg_${crypto.randomUUID()}`,
            text,
            delivery: 'queue',
          });
          return log.info('run.interjected.queued', { run: run.id });
        }
      }
      if (store.has(conversation)) {
        store.enqueue({ id: event.id, channel: conversation, user: 'linear', name: 'a person in Linear', text }, 100);
        return engine?.tick();
      }
      // The session belongs to a run that has ended: a person continuing a
      // finished conversation is talking to us. The assistant answers in its
      // own session, with the ticket read afresh.
      if (record && isTerminal(record.state)) {
        const issue = await tracker.issue(conversation, record.ticketId);
        const routed = projectForIssue(services.loaded, {
          teamId: issue.teamId,
          organizationId: await tracker.orgOf(conversation),
        });
        await startAssistant(
          issue,
          routed?.project,
          conversation,
          `[follow-up: the run on this ticket ended (${record.state})${record.outcome ? `: ${record.outcome.kind === 'success' ? record.outcome.summary : record.outcome.reason}` : ''}. The person now says: ${text}]`,
        );
        return engine?.tick();
      }
      return refuse(
        conversation,
        'I do not know this session (it started before aivi did, or its state is gone). Delegate the issue to me again.',
      );
    };

    /** The assistant conversations the update orphaned: the HITL label, a
     *  lane move or a delegate change each stops only its own kind of change. */
    const stopOrphans = async (
      pending: string[],
      issue: TrackerIssue,
      lane: ProjectLane | undefined,
      human: boolean,
      changed: TrackerChange[],
    ) => {
      for (const conversation of pending) {
        const workerAgent = store.sessionOf(conversation)?.agent;
        if (human && changed.includes('labels'))
          await stopAssistant(
            conversation,
            `Stopped: \`${config.humanLabel}\` was added to ${issue.identifier}; a person takes over.`,
          );
        else if (changed.includes('state') && lane?.agent !== workerAgent)
          await stopAssistant(
            conversation,
            `Stopped: ${issue.identifier} moved to "${issue.state.name}", which is not my lane.`,
          );
        else if (changed.includes('delegate') && issue.delegateId !== tracker.ownerOf(conversation))
          await stopAssistant(conversation, `Stopped: I am no longer the delegate of ${issue.identifier}.`);
      }
    };

    /** The run the update orphaned — same three reasons: interrupt the
     *  worker and end the run cancelled; the ending's catch-up says so in
     *  Linear's own activity. */
    const stopOrphanRun = async (
      issue: TrackerIssue,
      lane: ProjectLane | undefined,
      human: boolean,
      changed: TrackerChange[],
    ) => {
      const run = services.orchestrator.activeRun(MODULE_ID, issue.id);
      if (!run) return;
      const link = run.sessionId ? links.byOpencodeSession(run.sessionId) : undefined;
      if (human && changed.includes('labels'))
        await services.orchestrator.stop(
          run.id,
          `Stopped: \`${config.humanLabel}\` was added to ${issue.identifier}; a person takes over.`,
        );
      else if (changed.includes('state') && lane?.agent !== run.agent)
        await services.orchestrator.stop(
          run.id,
          `Stopped: ${issue.identifier} moved to "${issue.state.name}", which is not my lane.`,
        );
      else if (
        link &&
        changed.includes('delegate') &&
        issue.delegateId !== tracker.ownerOf(tracker.idFor(link.agentSession))
      )
        await services.orchestrator.stop(run.id, `Stopped: I am no longer the delegate of ${issue.identifier}.`);
    };

    /** The listener's pickup: an issue entering a mapped lane with nobody on
     *  it. The delegation is the whole start: making the app the delegate
     *  makes Linear create the agent session itself and hand it back in the
     *  mutation's own answer (live, 2026-09-26) — nothing opens a session by
     *  hand, and the `created` webhook that follows is a redelivery the
     *  pair record folds into the run already made. */
    const listenerPickup = async (issue: TrackerIssue, lane: ProjectLane, project: Project, conversation: string) => {
      if (issue.delegateId) return;
      // Linear's native blocking: an issue blocked by unfinished issues is not picked up.
      if (issue.blockedBy.some(b => !b.completed)) {
        log.info('listener.blocked', { issue: issue.identifier });
        return;
      }
      const sessionId = await tracker.startSession(conversation, issue.id);
      if (!sessionId) {
        // Linear made no session, so there is nothing to start. The route
        // acknowledged the delivery already — nothing will retry this — so
        // the failure is loud, and the delegation is undone: the issue must
        // not sit in the lane wearing the app as if a worker were coming.
        await tracker.unassign(conversation, issue.id).catch(error => log.warn('delegate.undone', { error }));
        log.error('listener.no-session', { issue: issue.identifier, lane: issue.state.name });
        return;
      }
      log.info('listener.delegated', {
        issue: issue.identifier,
        lane: issue.state.name,
        agent: lane.agent,
        agentSession: sessionId,
      });
      await handWork(issue, project, lane, tracker.idFor(sessionId));
    };

    const onIssue = async (event: Extract<TrackerEvent, { kind: 'updated' }>) => {
      if (!event.changed.length) return;
      const issue = await tracker.issue(event.conversation, event.issueId);
      const routed = projectForIssue(services.loaded, {
        teamId: issue.teamId,
        organizationId: await tracker.orgOf(event.conversation),
      });
      if (!routed) return;
      // Lane names are per Linear team; two mapped teams sharing a state name share the lane's agent.
      const lane = laneOf(routed.project, issue.state.name);
      const human = issue.labels.some(l => l.name === config.humanLabel);
      await stopOrphanRun(issue, lane, human, event.changed);
      const pending = store.pendingForIssue(issue.id);
      await stopOrphans(pending, issue, lane, human, event.changed);
      // Anything a person does to a ticket's place or standing wakes the
      // walk — including moves no lane claims (a queue lane has no agent),
      // which is exactly what the walk exists to pick up.
      if (event.changed.includes('state') || event.changed.includes('labels')) {
        stopped.clear(issue.id); // the person's own move answers a stop
        services.orchestrator.cancelWaiting(MODULE_ID, issue.id); // and their move cancels a waiting request
        void services.orchestrator.wake(routed.project.id);
      }
      if (!config.listener || !event.changed.includes('state') || !lane?.agent || human || pending.length) return;
      if (services.orchestrator.activeRun(MODULE_ID, issue.id)) return; // one worker per ticket
      await listenerPickup(issue, lane, routed.project, event.conversation);
    };

    /** Everything downstream keys off the adapter's normalized events — the
     *  endpoints, the signatures and the acknowledgements are the adapter's.
     *  A handler that throws is logged and dropped: the delivery was
     *  acknowledged already, so a retry would only replay what failed. */
    const unsubscribeEvents = tracker.events(async event => {
      try {
        if (abort.signal.aborted) return;
        if (event.kind === 'started') await onStarted(event.conversation, event.issueId, event.promptContext);
        else if (event.kind === 'prompted') await onPrompted(event);
        else await onIssue(event);
      } catch (error) {
        log.warn('event.failed', { error });
      }
    });

    // An assistant turn interrupted by a restart is blocked (nobody knows whether the agent stopped); say so in its session.
    for (const turn of interrupted)
      await say(
        turn.channel,
        'aivi was restarted while I was working. The OpenCode session is left as it is; an operator must inspect and resolve this before the project is worked on again.',
        'outcome',
      );

    // Our boot pass, ours alone: every pair whose run has ended owes Linear
    // its ceremony — the result may have died in an outage, the move may
    // never have landed. Each step asks Linear's real state first, so a
    // catch-up that already happened says nothing twice.
    for (const link of links.attached()) {
      const run = services.orchestrator.runBySession(link.opencodeSession!);
      if (run && run.state === 'cancelled') stopped.mark(link.ticketId); // stop survives the restart
      if (run && isTerminal(run.state) && run.outcome)
        await catchUp(
          { type: 'ended', run, outcome: run.outcome, ...(run.targetLane ? { targetLane: run.targetLane } : {}) },
          link,
        );
    }

    // Picked-up work has no pair to boot from: its endings live in the
    // orchestrator's record, and the watermark is where this module left
    // off reading it. Delegated endings above are the pairs' own business;
    // seeing them again here costs a local check and no word to Linear.
    for (const run of services.orchestrator.endedSince(MODULE_ID, watermark.since())) {
      if (run.sessionId && links.byOpencodeSession(run.sessionId)) continue;
      if (run.outcome)
        walkOwed.set(run.id, {
          type: 'ended',
          run,
          outcome: run.outcome,
          ...(run.targetLane ? { targetLane: run.targetLane } : {}),
        });
    }
    for (const runId of [...walkOwed.keys()]) await driveWalk(runId);

    const unregister = services.channels.register({
      id: LINEAR.id,
      accepts: () => false,
      ownsSession: session => store.channelOf(session) !== null,
      channelOf: async () => undefined,
      async reenter(session, text, context) {
        store.enqueueJobResult(context.run.id, session, text, 100);
        engine?.tick();
      },
      async post() {
        throw new Error('Linear is not a report destination; report to a chat channel instead');
      },
    });
    const unsubscribeWake = services.onWake(() => {
      engine!.tick();
      void retryOwed();
    });
    engine.tick();
    log.info('ready', { apps: Object.keys(config.apps), listener: config.listener });

    return {
      async stop() {
        unsubscribeEvents();
        unsubscribeRuns();
        unregister();
        unsubscribeWake();
        await teardown();
      },
    };
  } catch (error) {
    await teardown();
    throw error;
  }
}

/** For `aivi linear status`: what each assistant conversation is doing.
 *  Workers live in the orchestrator's ledger now; their lines join this view
 *  when the status command is formalized with the extraction. */
export function describeWorkers(
  store: ConversationStore,
): { conversation: string; agent: string | null; issue: string | null; turn: Turn }[] {
  return store
    .list()
    .filter(t => !['sent', 'discarded'].includes(t.state))
    .map(t => {
      const binding = store.sessionOf(t.channel);
      return {
        conversation: t.channel,
        agent: binding?.agent ?? null,
        issue: binding?.issue ?? null,
        turn: t,
      };
    });
}

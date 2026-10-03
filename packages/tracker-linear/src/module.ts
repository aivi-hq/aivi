/**
 * The Linear module: the platform's listener, adapter and **tracker**.
 * Everything Linear-shaped — webhooks, GraphQL, activity types, the apps and
 * their credentials — lives behind `./tracker.ts`. The host's **orchestrator**
 * owns a run: its durable record, its OpenCode session, the worker tools and
 * the rule that only a tool call ends it. We answer for the **stages**
 * (`@aivi/plugin`, work): `initWork` delegates the ticket to our own app and
 * Linear's answer carries the agent session, which we record and answer with
 * the ticket's **summary**; `ready` joins the OpenCode session to that pair;
 * `question` and `plan` render as they arrive; `endWork` says the closing
 * words in our order — the result first, because Linear's response is what
 * stops the "working" state — and only after we speak does the orchestrator
 * move the ticket and return the lease. Our failures stay ours: the closing
 * retries on the next wake and at boot, decided against Linear's real state,
 * never a flag in somebody else's database, and a person hears of a failed
 * closing the moment it fails — the human label rides the ticket, help is on
 * the way. A person's message into a worker's session never passes through
 * the orchestrator either: we post it straight into the OpenCode session — an
 * answer when a form is open, a steer otherwise. A hand **delegation** gets
 * one fixed answer: work reaches us through the board, not through a
 * delegation. What stays ours besides all that is the assistant — the
 * conversation a person brings us directly, which still rides the channel
 * machinery until the channels reform.
 */
import { errorMessage, laneOf, type Project, type ProjectLane } from '@aivi/core';
import {
  ChannelEngine,
  ConfigurationError,
  ConversationStore,
  createTurnRunner,
  isTerminal,
  stopTurn as stopRunningTurn,
} from '@aivi/host';
import type { AiviModule, AiviServices, RunView, Store, Tracker } from '@aivi/plugin';
import type { ChannelDelivery, ChannelPlatform, Turn } from '@aivi/plugin/channel';
import type { Platform, TrackerChange, TrackerCommentKind, TrackerEvent, TrackerIssue } from '@aivi/plugin/tracker';
import type { LinearConfig } from './config.ts';
import { assistantAgent, MODULE_ID, primaryLinearApp } from './config.ts';
import { RunLinks } from './links.ts';
import type { LinearMcp } from './mcp.ts';
import { linearTeamCollisions, projectForIssue, projectLinear } from './projects.ts';
import { RunProgress } from './runprogress.ts';
import { createLinearPlatform, LinearPlatform } from './tracker.ts';
import type { LinearBoard } from './work.ts';
import { issueDossier, linearBoard } from './work.ts';

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
type MakeTracker = (services: AiviServices) => Promise<Platform>;

/**
 * The module, built on a tracker. What lives here is routing and Linear's
 * voice — the `Tracker` contract decides what a question and an outcome look
 * like on Linear; the run itself — its record, session, tools and exits — is
 * the host orchestrator's, and Linear is one follower among any number it
 * will never know about.
 */
/** The board, pull-shaped, for the orchestrator's walk; a test hands its own
 *  lanes the way it hands its own tracker. */
type MakeBoard = (services: AiviServices) => LinearBoard;

export function createLinearModule(config: LinearConfig, makeTracker?: MakeTracker, makeBoard?: MakeBoard): AiviModule {
  return {
    id: MODULE_ID,
    start: services =>
      startLinear(
        config,
        services,
        makeTracker ?? (({ routes, log }) => createLinearPlatform(config, routes, undefined, log.getChild(MODULE_ID))),
        makeBoard ?? (s => linearBoard(config, s, s.log.getChild(MODULE_ID))),
      ),
  };
}

async function startLinear(
  config: LinearConfig,
  services: AiviServices,
  makeTracker: MakeTracker,
  makeBoard: MakeBoard,
) {
  const log = services.log.getChild(MODULE_ID);
  const collisions = linearTeamCollisions(services.loaded);
  if (collisions.length) throw new Error(`Linear config: ${collisions.join('; ')}`);
  const store = openLinearStore(services.store);
  const links = new RunLinks(services.store);
  /** One progress follower per run: the worker's OpenCode session mirrored
   *  into the agent session as ephemeral activities (docs/linear.md). It
   *  starts with the pair at `ready`, pauses while a question awaits a
   *  person, resumes when the answer lands, and stops before the closing
   *  so the closing is the last word. */
  const runProgress = new Map<string, RunProgress>();
  // The installation's own identity: the primary app when it is named, else
  // the first configured — every app reads the same workspace, so the
  // choice is credentials and nothing more. initWork delegates the ticket to
  // this app, and the agent session Linear hands back is the one we speak in.
  const readerApp = primaryLinearApp(config) ?? Object.keys(config.apps)[0]!;
  const interrupted = store.recover();
  if (interrupted.length) log.warn('turns.interrupted', { blocked: interrupted.length });

  // The adapter takes the whole platform in: apps, credentials, endpoints.
  const tracker = await makeTracker(services);
  // The board the eligibility walk reads: which projects this installation
  // speaks for, what sits in a lane, how a ticket enters one. The stages
  // that speak through the adapter join it below; webhooks keep pushing
  // conversations, and the walk needs none of them.
  const board = makeBoard(services);

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
    for (const follower of runProgress.values()) void follower.stop();
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
      { resource: config.resource, maxConcurrent: 8 },
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
     * The closings we owe Linear: every ended run whose closing has not
     * landed. A failed closing informs a person the moment it fails — the
     * human label rides the ticket and the session says why — and stays owed
     * to the next wake and the next boot; the label stands until a person
     * removes it. Nothing here lives in the orchestrator's record: delivery
     * is ours, so the outbox is ours too.
     */
    const closings = new Map<string, RunView>();
    /** Runs whose failure a person has already been told about: the help is
     *  on the way once, never repeated on every failed retry. */
    const helped = new Set<string>();

    /** Our platform's word for "a person, please": the human label. */
    const markForHuman = async (conversation: string, ticketId: string): Promise<void> => {
      if (!tracker.apply) return void log.warn('help.unavailable', { ticket: ticketId });
      try {
        await tracker.apply(conversation, ticketId, { kind: 'label', label: config.humanLabel, on: true });
      } catch (error) {
        log.warn('help.label.failed', { ticket: ticketId, error });
      }
    };

    /**
     * One closing, driven against Linear's real state: the **result first** —
     * Linear's response completes the agent session and stops the "working"
     * state, the human-visible wound — then the **closing note** on the
     * ticket itself (the adapter is idempotent, so a retry never says it
     * twice), then the **delegate**, which **every ending releases**: the
     * delegate means "an app is working this issue", and a finished run works
     * it no more — leaving it sitting would blacklist the ticket from the
     * walk (composed 2026-10-02 with the eligibility rule), while the agent
     * session stays on the ticket as the readable trail either way. The lane
     * move is not here: it is the orchestrator's decision and its debt,
     * performed through `moveTo` after this returns.
     */
    const driveClosing = async (runId: string): Promise<void> => {
      const entry = closings.get(runId);
      if (!entry) return;
      const link = entry.sessionId ? links.byOpencodeSession(entry.sessionId) : undefined;
      if (!link) {
        closings.delete(runId);
        return void log.error('closing.unpaired', { run: runId, ticket: entry.ticketId });
      }
      const conversation = tracker.idFor(link.agentSession);
      const words =
        entry.outcome?.kind === 'success'
          ? entry.outcome.summary
          : (entry.outcome?.reason ?? 'The run ended without an outcome.');
      try {
        if (!(await tracker.resultShown(conversation)))
          await tracker.comment(conversation, words, entry.outcome?.kind === 'success' ? 'answer' : 'outcome');
        if (tracker.closingNote) await tracker.closingNote(conversation, entry.ticketId, words);
        // A worker the dispatcher could not kill, or a worker a person asked
        // to stop while OpenCode would not answer the interrupt (ruled
        // 2026-10-02; the stop's twin 2026-10-03): the ticket carries the
        // human label and says plainly that a worker may still be running —
        // help is on the way, and a person goes looking. The claim "stopped
        // at your request" is never made here.
        if (
          entry.outcome?.kind === 'failure' &&
          (entry.outcome.code === 'kill-unconfirmed' || entry.outcome.code === 'stop-unconfirmed') &&
          !helped.has(runId)
        ) {
          helped.add(runId);
          await tracker.comment(
            conversation,
            entry.outcome.code === 'stop-unconfirmed'
              ? 'A person asked me to stop this worker, but my agent runtime would not answer the interrupt — it may still be running. I have marked this issue for a person.'
              : 'The dispatcher could not stop my worker session, so one may still be loose. I have marked this issue for a person.',
            'outcome',
          );
          await markForHuman(conversation, entry.ticketId);
        }
        await tracker.unassign(conversation, entry.ticketId).catch(error => log.warn('delegate.undone', { error }));
        closings.delete(runId);
        log.info('run.caughtup', { run: runId, ticket: entry.ticketId });
      } catch (error) {
        // The closing failed: the person hears it NOW — the operator must be
        // informed — and the closing stays owed: the next wake and the next
        // boot try again, and each step asks Linear's real state first so a
        // half-landed ceremony finishes without saying anything twice.
        if (!helped.has(runId)) {
          helped.add(runId);
          log.error('closing.failed', { run: runId, ticket: entry.ticketId, error });
          await say(
            conversation,
            `I could not finish reporting this run: ${errorMessage(error)}. The issue is marked for a person — help is on the way.`,
            'outcome',
          );
          await markForHuman(conversation, entry.ticketId);
        } else log.warn('closing.retry.failed', { run: runId, error });
        throw error;
      }
    };

    const retryClosings = async (): Promise<void> => {
      for (const runId of [...closings.keys()]) await driveClosing(runId).catch(() => {});
    };

    /** The session a stage speaks through: the pair `initWork` opened and
     *  `ready` attached. A stage that cannot find it says so — the render is
     *  lost, the log is not, and the tracker's own retries answer. */
    const conversationOf = (run: RunView): string => {
      const link = run.sessionId ? links.byOpencodeSession(run.sessionId) : undefined;
      if (!link) throw new Error(`run ${run.id} has no agent-session pair to speak through`);
      return tracker.idFor(link.agentSession);
    };

    /**
     * Linear as the orchestrator knows it: one `Tracker` — the board the walk
     * reads and the stages every run of ours walks through
     * (docs/orchestrator.md). The lifecycle stages the orchestrator awaits
     * (`initWork`, `endWork`) fail visibly; the renders it fires and forgets
     * (`ready`, `question`, `plan`) throw into its log and are retried, if
     * they matter, by us. `startWork` we answer with silence on purpose:
     * Linear watches its own agent sessions, and a working session shows
     * itself.
     */
    const work: Tracker = {
      id: MODULE_ID,
      projects: board.projects,
      tickets: board.tickets,
      moveTo: board.moveTo,
      /** Where the ticket sits right now, in the walk's own read: gone means
       *  deleted or on a team this project does not map. The orchestrator
       *  asks before every ending move (ruled 2026-10-02). */
      ticketLane: async (projectId, ticketId) => {
        const words = await board.issue(ticketId);
        if (!words) return undefined;
        const teams = projectLinear(services.loaded, projectId)?.teams ?? [];
        return teams.includes(words.teamId) ? words.stateName : undefined;
      },
      /** The delegation is the whole opening: making the app the delegate
       *  makes Linear create the agent session itself and hand it back in the
       *  mutation's own answer (live, 2026-09-26) — nothing opens a session by
       *  hand. The pair is recorded **before** anything can arrive: Linear's
       *  webhook for this very delegation is a redelivery the run's own guard
       *  folds away, and "preparing the workspace" is the first word inside
       *  the new session. The answer doubles as the ticket's summary. */
      initWork: async run => {
        const issue = await board.issue(run.ticketId);
        if (!issue) throw new Error('the ticket is gone from the board (deleted by a person)');
        // A run that dies here has no session to speak through, and silence
        // was seven failures (live, 2026-10-02): the ticket itself gets the
        // plain word before the run fails. If even the comment cannot land,
        // the log carries it — never nothing.
        const visible = async (why: string): Promise<never> => {
          await tracker
            .notify(readerApp, run.ticketId, `I could not start work on this ticket: ${why}`)
            .catch(error => log.warn('initWork.notice.failed', { error }));
          throw new Error(why);
        };
        let agentSession: string | null;
        try {
          agentSession = await tracker.startSession(readerApp, run.ticketId);
        } catch (error) {
          return visible(`the delegation failed: ${errorMessage(error)}`);
        }
        if (!agentSession)
          return visible(
            'Linear made no agent session for the delegation. If aivi still holds this ticket as its delegate, clear the delegate — and archive the old session — before asking again.',
          );
        links.bind(agentSession, run.ticketId);
        await say(tracker.idFor(agentSession), 'Preparing the workspace…', 'progress');
        // Linear names the ticket's branch (`Issue.branchName`); a worktree
        // lane checks out exactly this name, and the orchestrator never
        // invents one. An empty title-derived name says so by being absent.
        return { summary: issueDossier(issue), ...(issue.branchName ? { branch: issue.branchName } : {}) };
      },
      ready: run => {
        if (!run.sessionId) return void log.warn('ready.sessionless', { run: run.id });
        // Absent means the pair was already attached: a replay, said never.
        if (!links.attach(run.ticketId, run.sessionId)) log.debug('ready.replayed', { run: run.id });
        // The progress stream starts with the pair it can speak through:
        // while the run works, its session is shown as ephemeral activities.
        // A platform without a progress surface gets no follower at all.
        if (config.progress === 'silent' || !tracker.progress) return;
        const follower =
          runProgress.get(run.id) ??
          new RunProgress(tracker, conversationOf(run), run.sessionId, {
            mode: config.progress,
            events: services.events,
            log,
          });
        runProgress.set(run.id, follower);
        follower.start();
      },
      question: async (run, question) => {
        // Parked: nothing happens while a person thinks, and an idle
        // follower would only refresh a line that stands still. Guarded so
        // a run that never streamed says nothing a beat later than before.
        const follower = runProgress.get(run.id);
        if (follower) await follower.stop();
        await tracker.ask(conversationOf(run), question);
      },
      plan: async (run, plan) => {
        await tracker.plan(conversationOf(run), plan);
      },
      endWork: async run => {
        // The closing is the run's last word: the progress stream falls
        // silent before it, never after.
        const follower = runProgress.get(run.id);
        if (follower) await follower.stop();
        runProgress.delete(run.id);
        if (closings.has(run.id)) return; // the stage and the boot pass may race for one run
        closings.set(run.id, run);
        await driveClosing(run.id);
      },
    };
    services.orchestrator.addTracker(work);

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
     * like on its platform; a **delegation** gets one fixed refusal — work
     * reaches me through the board, not through a delegation, and the only
     * delegation not refused is my own `initWork`'s, whose webhook the pair
     * and the live run already fold into the run they belong to; and what a
     * person brings us any other way — a comment mention above all — lands
     * on the assistant, the project's configured assistant, in the fixed
     * context of a project (ruled 2026-10-02).
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
        // A delegation not initiated by us (ruled 2026-10-02): our own
        // initWork delegation was folded away by the redelivery guard above,
        // so whoever named us here did it by hand. One fixed refusal — the
        // delegate un-taken, the answer plain — whatever the lane maps:
        // work reaches me through the board, and the walk starts it there.
        if (issue.completed)
          return refuse(conversation, `${issue.identifier} is already finished as far as work goes; nothing to start.`);
        return void (await unclaimed(
          issue,
          conversation,
          'work reaches me through the board, not through a delegation: I start a worker myself once the ticket sits in a lane I work.',
        ));
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
          // Stop means stop — and the stop has to **stick**. The ending
          // releases the delegate and wakes the walk in the same breath, so
          // the ticket must go to a person's hands on the board *before* the
          // run ends (ruled 2026-10-03): "not that one again" is the HITL
          // label's job, never a memory in a database — and now the label
          // actually rides. Lifting it off is what lets the walk work the
          // ticket again.
          await markForHuman(conversation, run.ticketId);
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
          // queue included — before the same session resumes. OpenCode
          // first, the books second (ruled 2026-10-03): the worker gets the
          // text, then the form closes as the record.
          let outcome: Awaited<ReturnType<typeof services.orchestrator.answer>>;
          try {
            outcome = await services.orchestrator.answer(run.sessionId, text, form.id);
          } catch (error) {
            // OpenCode would not take the answer. Nothing moved — the run
            // is still parked, the question still stands — and the person
            // hears that now, in these words, not by silence.
            log.warn('answer.delivery.failed', { run: run.id, error });
            return refuse(
              conversation,
              'I could not reach my agent runtime to wake the worker — the question still stands; answer it again once the runtime is back.',
            );
          }
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
          // Work resumes (now or when the slot opens): the progress stream resumes with it.
          runProgress.get(run.id)?.start();
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
        if (issue.archived && changed.includes('archive'))
          await stopAssistant(conversation, `Stopped: ${issue.identifier} was deleted; there is no work to do.`);
        else if (human && changed.includes('labels'))
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
      if (issue.archived && changed.includes('archive'))
        await services.orchestrator.stop(run.id, `Stopped: ${issue.identifier} was deleted; there is no work.`);
      else if (human && changed.includes('labels'))
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
      ) {
        // A person took the issue back: it carries their hands' label **before**
        // the stop wakes the walk (ruled 2026-10-03), or aivi would re-delegate
        // itself in the same breath the human un-delegated it.
        await markForHuman(tracker.idFor(link.agentSession), issue.id);
        await services.orchestrator.stop(run.id, `Stopped: I am no longer the delegate of ${issue.identifier}.`);
      }
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
        services.orchestrator.cancelWaiting(MODULE_ID, issue.id); // a person's move cancels a waiting request
        void services.orchestrator.wake(routed.project.id); // and a lane move is a wake and nothing more
      }
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
    // its closing — the result may have died in an outage. Each step asks
    // Linear's real state first, so a catch-up that already happened says
    // nothing twice. Walk-picked work has a pair too now (initWork delegates
    // for every run), so the pairs are the whole list; the lane moves are the
    // orchestrator's own debt and its boot pass re-drives them.
    for (const link of links.attached()) {
      const run = services.orchestrator.runBySession(link.opencodeSession!);
      if (run && isTerminal(run.state)) {
        closings.set(run.id, run);
        await driveClosing(run.id).catch(() => {});
      }
    }

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
      void retryClosings();
    });
    engine.tick();
    log.info('ready', { apps: Object.keys(config.apps) });

    return {
      async stop() {
        unsubscribeEvents();
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

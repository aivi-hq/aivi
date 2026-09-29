/**
 * The Linear module: the platform's conversations on top of Linear's tracker
 * adapter. Everything Linear-shaped — webhooks, GraphQL, activity types, the
 * apps and their credentials — lives behind `./tracker.ts`; what happens
 * here is aivi's own machinery speaking the `Tracker` contract: routing a
 * session to a worker or the assistant, the delegate guards, the listener's
 * pickup, and the worktree a lane's agent works in. That machinery is the
 * orchestrator waiting to be extracted ([orchestrator.md](../../../docs/plans/templates/orchestrator.md));
 * the worktree code in `./worktree.ts` is its machinery too, and moves with
 * that extraction.
 */
import type { Project } from '@aivi/core';
import { errorMessage, gitIdentity } from '@aivi/core';
import {
  ChannelEngine,
  ConfigurationError,
  ConversationStore,
  createTurnRunner,
  stopTurn as stopRunningTurn,
} from '@aivi/host';
import type { AiviModule, AiviServices, Store } from '@aivi/plugin';
import type { ChannelDelivery, ChannelPlatform, Turn } from '@aivi/plugin/channel';
import type { Tracker, TrackerChange, TrackerCommentKind, TrackerEvent, TrackerIssue } from '@aivi/plugin/tracker';
import type { LinearConfig } from './config.ts';
import { assistantAgent, MODULE_ID } from './config.ts';
import { LinearMcp } from './mcp.ts';
import type { LaneBinding } from './projects.ts';
import { linearTeamCollisions, projectForIssue } from './projects.ts';
import { createLinearTracker, LinearTracker } from './tracker.ts';
import { ensureWorktree, globalGitConfig, worktreePathFor } from './worktree.ts';

/**
 * The platform: an agent session is a conversation. Its id is `<app>:<agent session id>`
 * so a turn always knows which app's token speaks for it, restarts included. Workers have
 * effects beyond their reply, so a restart mid-turn blocks instead of discarding.
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
    stopped: 'Stopped at your request. The worktree and the OpenCode session are left as they are for inspection.',
    notStarted: 'I could not reach my agent runtime, so nothing was started. Send another message to try again.',
    offline:
      'aivi is going offline (a restart or shutdown). This worker was stopped; the worktree and the OpenCode session are left as they are.',
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

/** The `<issue>` block that accompanies every enqueue when the event brought
 *  no context of its own. */
const issueDossier = (issue: TrackerIssue) =>
  `<issue identifier="${issue.identifier}"><title>${issue.title}</title><description>${issue.description ?? ''}</description></issue>`;

// Which aivi project an issue belongs to lives in `./projects.ts` with the
// project's `linear` section: core hands the section through unread and the
// plugin merges it here.

/** Where the module's tracker comes from: Linear's adapter by default, a
 *  fake tracker in a test of the decisions below. */
type MakeTracker = (services: AiviServices) => Promise<Tracker>;

/**
 * The module, built on a tracker. What lives here is aivi's machinery —
 * routing, guards, the listener's pickup, the worktree — speaking only the
 * `Tracker` contract; everything Linear-shaped is the adapter's, in
 * `./tracker.ts`.
 */
export function createLinearModule(config: LinearConfig, makeTracker?: MakeTracker): AiviModule {
  return {
    id: MODULE_ID,
    start: services =>
      startLinear(
        config,
        services,
        makeTracker ?? (({ routes, log }) => createLinearTracker(config, routes, undefined, log.getChild(MODULE_ID))),
      ),
  };
}

async function startLinear(config: LinearConfig, services: AiviServices, makeTracker: MakeTracker) {
  const log = services.log.getChild(MODULE_ID);
  const collisions = linearTeamCollisions(services.loaded);
  if (collisions.length) throw new Error(`Linear config: ${collisions.join('; ')}`);
  const store = openLinearStore(services.store);
  const interrupted = store.recover();
  if (interrupted.length) log.warn('turns.interrupted', { blocked: interrupted.length });

  // The adapter takes the whole platform in: apps, credentials, endpoints.
  const tracker = await makeTracker(services);

  // Who a worker commits as, resolved once for the run: aivi launched that work,
  // so the bot authors it and no co-author trailer follows. Logged because it is
  // the first thing to look at when a commit carries the wrong name.
  const workerIdentity = await gitIdentity(services.loaded.config.identity, globalGitConfig);
  log.info('worker.identity', { name: workerIdentity.name, email: workerIdentity.email });

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

    /** The Linear MCP: the module's own loopback forwarder, authorised with the
     *  primary's app-actor token. Agents act in Linear; writes attribute to the
     *  app. It is Linear's own machinery rather than part of the neutral seam,
     *  so it comes with Linear's adapter and with nothing else. */
    if (config.mcp && tracker instanceof LinearTracker) {
      const primary = tracker.primary.client;
      mcp = new LinearMcp(primary, { port: config.mcp.port, log });
      try {
        const port = await mcp.start();
        log.info('linear.mcp.ready', { url: `http://127.0.0.1:${port}/mcp` });
      } catch (error) {
        await mcp.stop();
        throw new ConfigurationError(`Linear MCP could not bind 127.0.0.1:${config.mcp.port}: ${errorMessage(error)}`);
      }
    }

    /** End the worker in `conversation` because the tracker says it must not continue; the worktree stays. */
    const stopWorker = async (conversation: string, why: string) => {
      const result = await stopRunningTurn(engine!, services.opencode, conversation);
      if (result.error) log.warn('stop.interrupt_failed', { error: result.error });
      // The engine's stopped notice follows for a running turn; queued-only conversations hear this one.
      if (!result.stopped) await say(conversation, why, 'outcome');
      else await say(conversation, why, 'note');
      log.info('worker.stopped', { conversation, why });
    };

    /**
     * A delegated issue a lane claims: the worker. Worktree first (a failure
     * refuses and nothing is bound), then the bind, the notice and the prompt.
     * False when the worktree could not be prepared — the caller skips its
     * tick then, exactly as the early return used to.
     */
    const startWorker = async (
      issue: TrackerIssue,
      project: Project,
      lane: LaneBinding,
      conversation: string,
      promptContext?: string,
    ): Promise<boolean> => {
      const { app, session: sessionId } = tracker.parts(conversation);
      const path = worktreePathFor(project.directory, sessionId);
      let made: Awaited<ReturnType<typeof ensureWorktree>> | null = null;
      if (lane.worktree) {
        try {
          made = await ensureWorktree({
            source: project.directory,
            path,
            branch: issue.branchName,
            identity: workerIdentity,
            signal: abort.signal,
          });
        } catch (error) {
          await refuse(conversation, `I could not prepare a worktree for ${issue.identifier}: ${errorMessage(error)}`);
          return false;
        }
      }
      const directory = made ? made.path : project.directory;
      store.bind(conversation, { agent: lane.agent, directory, project: project.id, issue: issue.id });
      const waiting = store.waitingOn(conversation);
      await say(
        conversation,
        waiting
          ? `Queued: another worker is busy on ${issue.identifier}; I start when it finishes.`
          : `Starting as \`${lane.agent}\` in project ${project.id}${made ? ` on branch \`${issue.branchName}\`` : ', working in the project checkout'}.`,
        'progress',
      );
      if (made && made.path !== path) store.rebind(conversation, { directory: made.path });
      const place = made
        ? `You work in the git worktree ${made.path} on branch ${issue.branchName} (from ${made.base}).`
        : `You work in the project's clean checkout ${project.directory} on its current branch; leave it as you found it — the checkout is the source of truth. The agent file says what you may change.`;
      const text = [
        `[Linear delegated ${issue.identifier} "${issue.title}" to you (app ${app}) in project ${project.id}, lane "${issue.state.name}". ${place} Your final answer is posted to the issue as your response; questions you ask are posted too and answered as follow-ups.]`,
        promptContext ?? issueDossier(issue),
      ].join('\n\n');
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
      return true;
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

    /**
     * A session started. Routing is deterministic, from the issue re-read:
     * a deleted ticket gets nothing at all; the HITL label refuses for any
     * agent; a delegation whose lane maps an agent is a worker (the lane
     * decides worktree or checkout); a delegation no lane can run gets its
     * delegate un-taken and one plain fixed answer saying why — nobody
     * improvises over work the config never claimed; and what a person
     * brings us any other way — a comment mention above all — lands on the
     * assistant, in the checkout or the home. The face is never a routing
     * input: a delegation into a mapped lane runs the lane's agent whatever
     * app the session lives on.
     */
    const onStarted = async (conversation: string, issueId: string, promptContext?: string) => {
      if (store.has(conversation)) return; // a redelivery
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
      const lane = routed?.linear.lanes[issue.state.name];
      if (issue.delegateId === tracker.ownerOf(conversation)) {
        // The app was named to work: a lane that claims it runs the worker;
        // a delegation nothing can run is answered plainly, and no agent is
        // left behind to improvise.
        if (routed && lane) {
          if (!(await startWorker(issue, routed.project, lane, conversation, promptContext))) return;
          engine?.tick();
        } else if (!routed) {
          await unclaimed(issue, conversation, 'its team is not connected to an aivi project.');
        } else if (lane === null) {
          await unclaimed(issue, conversation, `the "${issue.state.name}" lane is marked as human's work.`);
        } else {
          await unclaimed(issue, conversation, `the "${issue.state.name}" lane has no agent mapping.`);
        }
        return;
      }
      // A person addressing us is a conversation the assistant holds,
      // mapped lanes or not.
      await startAssistant(issue, routed?.project, conversation, promptContext);
      engine?.tick();
    };

    const onPrompted = async (event: Extract<TrackerEvent, { kind: 'prompted' }>) => {
      const conversation = event.conversation;
      if (!store.has(conversation))
        return refuse(
          conversation,
          'I do not know this session (it started before aivi did, or its state is gone). Delegate the issue to me again.',
        );
      if (event.signal === 'stop') {
        const result = await stopRunningTurn(engine!, services.opencode, conversation);
        if (result.error) log.warn('stop.interrupt_failed', { error: result.error });
        if (!result.stopped) await say(conversation, 'Nothing is running right now.', 'answer');
        return;
      }
      const text = event.body?.trim();
      if (!text) return;
      store.enqueue({ id: event.id, channel: conversation, user: 'linear', name: 'a person in Linear', text }, 100);
      engine?.tick();
    };

    /** Workers the update orphaned: the HITL label, a lane move or a delegate
     *  change each stops only its own kind of change. */
    const stopOrphans = async (
      pending: string[],
      issue: TrackerIssue,
      lane: LaneBinding | undefined,
      human: boolean,
      changed: TrackerChange[],
    ) => {
      for (const conversation of pending) {
        const workerAgent = store.sessionOf(conversation)?.agent;
        if (human && changed.includes('labels'))
          await stopWorker(
            conversation,
            `Stopped: \`${config.humanLabel}\` was added to ${issue.identifier}; a person takes over.`,
          );
        else if (changed.includes('state') && lane?.agent !== workerAgent)
          await stopWorker(
            conversation,
            `Stopped: ${issue.identifier} moved to "${issue.state.name}", which is not my lane.`,
          );
        else if (changed.includes('delegate') && issue.delegateId !== tracker.ownerOf(conversation))
          await stopWorker(conversation, `Stopped: I am no longer the delegate of ${issue.identifier}.`);
      }
    };

    /** The listener's pickup: an issue entering a mapped lane with nobody on
     *  it. The delegation is the whole start: making the app the delegate
     *  makes Linear create the agent session itself and hand it back in the
     *  mutation's own answer (live, 2026-09-26) — nothing opens a session by
     *  hand, and the `created` webhook that follows is a redelivery. */
    const listenerPickup = async (issue: TrackerIssue, lane: LaneBinding, conversation: string) => {
      if (issue.delegateId) return;
      // Linear's native blocking: an issue blocked by unfinished issues is not picked up.
      if (issue.blockedByStates.some(t => t !== 'completed' && t !== 'canceled')) {
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
      // The `created` webhook for this session may still arrive; one worker
      // per issue (docs/linear.md) folds it into this one as a redelivery.
      await onStarted(tracker.idFor(sessionId), issue.id);
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
      const lane = routed.linear.lanes[issue.state.name];
      const human = issue.labels.some(l => l.name === config.humanLabel);
      const pending = store.pendingForIssue(issue.id);
      await stopOrphans(pending, issue, lane, human, event.changed);
      if (!config.listener || !event.changed.includes('state') || !lane || human || pending.length) return;
      await listenerPickup(issue, lane, event.conversation);
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

    // A worker interrupted by a restart is blocked (nobody knows whether the agent stopped); say so in its session.
    for (const turn of interrupted)
      await say(
        turn.channel,
        'aivi was restarted while I was working. The worktree and the OpenCode session are left as they are; an operator must inspect and resolve this before the project is worked on again.',
        'outcome',
      );

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
    });
    engine.tick();
    log.info('ready', { apps: Object.keys(config.apps), listener: config.listener });

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

/** For `aivi linear status`: what each conversation is doing — a worker on an
 *  issue, or an assistant session bound to no issue. */
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

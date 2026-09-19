import type { LinearConfig, Project } from '@aivi/core';
import {
  assistantAgent,
  errorMessage,
  linearPrimarySecretNames,
  linearSecretNames,
  primaryLinearApp,
} from '@aivi/core';
import type { ChannelDelivery, ChannelPlatform, HostModule, HostServices, Store, Turn } from '@aivi/host';
import {
  ChannelEngine,
  ConfigurationError,
  ConversationStore,
  createTurnRunner,
  stopTurn as stopRunningTurn,
} from '@aivi/host';
import { LinearApiError, LinearClient } from './client.ts';
import { registerWebhookRoutes } from './routes.ts';
import {
  type AgentSessionEventPayload,
  type IssueEventPayload,
  isAgentSessionEvent,
  isIssueEvent,
  type LinearWebhook,
} from './webhook.ts';
import { ensureWorktree, worktreePathFor } from './worktree.ts';

/**
 * The platform: an agent session is a conversation. Its id is `<app>:<agent session id>`
 * so a turn always knows which app's token speaks for it, restarts included. Workers have
 * effects beyond their reply, so a restart mid-turn blocks instead of discarding.
 */
export const LINEAR: ChannelPlatform = {
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

export const conversationFor = (app: string, agentSession: string) => `${app}:${agentSession}`;
export const conversationParts = (conversation: string): { app: string; agentSession: string } => {
  const at = conversation.indexOf(':');
  return { app: conversation.slice(0, at), agentSession: conversation.slice(at + 1) };
};

export function openLinearStore(store: Store): ConversationStore {
  // Every conversation is bound individually; the module binding never changes.
  return new ConversationStore(store, LINEAR, 'linear');
}

export interface LinearAppRuntime {
  id: string;
  client: LinearClient;
  webhookSecret: string;
  /** The app user's id in the workspace; what `Issue.delegate` points at when it is us. */
  userId: string;
}

/**
 * Credentials for every configured app, from the environment; a missing one is
 * the operator's to fix. The primary app (the one app, or `linear.primary`)
 * keeps the bare `LINEAR_*` names; every other app — a face — uses
 * `LINEAR_<APP>_*`.
 */
export function requireLinearSecrets(config: LinearConfig, env: NodeJS.ProcessEnv = process.env) {
  const primary = primaryLinearApp(config);
  if (!primary)
    throw new ConfigurationError('Linear: with several apps one must carry the data feed — set `linear.primary`');
  const out: { id: string; clientId: string; clientSecret: string; webhookSecret: string }[] = [];
  for (const id of Object.keys(config.apps)) {
    const names = id === primary ? linearPrimarySecretNames : linearSecretNames(id);
    const missing = Object.values(names).filter(name => !env[name]);
    if (missing.length) throw new ConfigurationError(`Linear app ${id}: set ${missing.join(', ')} in <home>/.env`);
    out.push({
      id,
      clientId: env[names.clientId]!,
      clientSecret: env[names.clientSecret]!,
      webhookSecret: env[names.webhookSecret]!,
    });
  }
  return out;
}

/** `clients` is a test seam keyed by endpoint id (an app id or `data`); real clients come from the environment. */
export function createLinearModule(config: LinearConfig, clients?: Map<string, LinearClient>): HostModule {
  return { id: LINEAR.id, start: services => startLinear(config, services, clients) };
}

/** Which aivi project an issue belongs to: by the issue's Linear team, and by workspace when one is configured. */
export function projectForIssue(
  projects: Project[],
  issue: { teamId: string; organizationId: string },
): Project | undefined {
  return projects.find(
    p =>
      !p.removed &&
      p.linear?.teams.includes(issue.teamId) === true &&
      (!p.linear.workspaceId || p.linear.workspaceId === issue.organizationId),
  );
}

async function startLinear(config: LinearConfig, services: HostServices, givenClients?: Map<string, LinearClient>) {
  const log = services.log.child({ component: 'linear' });
  const store = openLinearStore(services.store);
  const interrupted = store.recover();
  if (interrupted.length) log.warn('turns.interrupted', { blocked: interrupted.length });

  const apps = new Map<string, LinearAppRuntime>();
  const primaryId = primaryLinearApp(config);
  for (const secret of requireLinearSecrets(config)) {
    const client = givenClients?.get(secret.id) ?? new LinearClient(secret, { log });
    let userId: string;
    try {
      userId = await client.viewerId();
    } catch (error) {
      if (error instanceof LinearApiError && (error.status === 400 || error.status === 401))
        throw new ConfigurationError(`Linear app ${secret.id}: credentials rejected (${error.message})`);
      throw error;
    }
    apps.set(secret.id, { id: secret.id, client, webhookSecret: secret.webhookSecret, userId });
  }

  const abort = new AbortController();
  let engine: ChannelEngine | undefined;
  const stop = () => {
    abort.abort();
    engine?.stop();
  };
  services.signal.addEventListener('abort', stop, { once: true });
  const teardown = async () => {
    stop();
    try {
      await engine?.shutdown();
    } finally {
      services.signal.removeEventListener('abort', stop);
    }
  };

  const clientFor = (conversation: string) => {
    const { app } = conversationParts(conversation);
    const runtime = apps.get(app);
    if (!runtime) throw new Error(`Linear app ${app} is not configured`);
    return runtime;
  };
  const activity = (
    conversation: string,
    content: Parameters<LinearClient['createActivity']>[0]['content'],
    ephemeral = false,
  ) =>
    clientFor(conversation).client.createActivity({
      agentSessionId: conversationParts(conversation).agentSession,
      content,
      ...(ephemeral ? { ephemeral: true } : {}),
    });
  const delivery: ChannelDelivery = {
    send: async (conversation, text) => activity(conversation, { type: 'response', body: text }),
    placeholder: (conversation, text) => activity(conversation, { type: 'thought', body: text }, true),
    edit: async (conversation, _id, text) => {
      await activity(conversation, { type: 'thought', body: text }, true);
    },
    delete: async () => {}, // the response that follows replaces the ephemeral thought
    notice: async (conversation, text) => {
      await activity(conversation, { type: 'error', body: text });
    },
  };

  try {
    const home = services.loaded.path.replace(/\/[^/]*$/, '');
    const ask = await createTurnRunner(
      LINEAR,
      { agent: 'unbound', directory: home },
      services.loaded,
      services.opencode,
      services.events,
      services.log,
    );
    engine = new ChannelEngine(
      store,
      { resource: config.resource, maxConcurrent: 8, turnTimeoutMs: config.turnTimeoutMs },
      services.loaded.config.scheduler,
      ask,
      delivery,
      {
        log: services.log,
        onRelease: services.wake,
        onFailure: services.fail,
        progress: { mode: config.progress, events: services.events },
      },
    );

    const refuse = async (conversation: string, why: string) => {
      log.info('session.refused', { conversation, why });
      await activity(conversation, { type: 'error', body: why }).catch(error => log.warn('notify.failed', { error }));
    };

    /** End the worker in `conversation` because Linear says it must not continue; the worktree stays. */
    const stopWorker = async (conversation: string, why: string) => {
      const result = await stopRunningTurn(engine!, services.opencode, conversation);
      if (result.error) log.warn('stop.interrupt_failed', { error: result.error });
      // The engine's stopped notice follows for a running turn; queued-only conversations hear this one.
      if (!result.stopped) await activity(conversation, { type: 'error', body: why }).catch(() => {});
      else await activity(conversation, { type: 'thought', body: why }).catch(() => {});
      log.info('worker.stopped', { conversation, why });
    };

    /**
     * A session started. Routing is deterministic, from the issue re-read:
     * the HITL label refuses for any agent; a delegation whose lane maps an
     * agent is a worker (the lane decides worktree or checkout); everything
     * else people send — a mention, a delegation into an unmapped lane, a
     * team that maps no project — lands on the assistant, in the checkout or
     * the home. The face is never a routing input: a delegation into a mapped
     * lane runs the lane's agent whatever app the session lives on.
     */
    const onCreated = async (app: LinearAppRuntime, payload: AgentSessionEventPayload) => {
      const conversation = conversationFor(app.id, payload.agentSession.id);
      if (store.has(conversation)) return; // a redelivery
      const issueId = payload.agentSession.issue?.id;
      if (!issueId) return refuse(conversation, 'I only work on issues; this session has none.');
      const issue = await app.client.issue(issueId);
      if (issue.labels.some(l => l.name === config.humanLabel))
        return refuse(
          conversation,
          `${issue.identifier} carries the \`${config.humanLabel}\` label, so a person handles it. Remove the label to let me work on it.`,
        );
      const project = projectForIssue(services.loaded.projects, {
        teamId: issue.team.id,
        organizationId: payload.organizationId,
      });
      const lane = project?.linear?.lanes[issue.state.name];
      const delegated = issue.delegate?.id === app.userId;
      if (project && lane && delegated) {
        const path = worktreePathFor(project.directory, payload.agentSession.id);
        let made: Awaited<ReturnType<typeof ensureWorktree>> | null = null;
        if (lane.worktree) {
          try {
            made = await ensureWorktree({
              source: project.directory,
              path,
              branch: issue.branchName,
              signal: abort.signal,
            });
          } catch (error) {
            return refuse(
              conversation,
              `I could not prepare a worktree for ${issue.identifier}: ${errorMessage(error)}`,
            );
          }
        }
        const directory = made ? made.path : project.directory;
        store.bind(conversation, { agent: lane.agent, directory, project: project.id, issue: issue.id });
        const waiting = store.waitingOn(conversation);
        await activity(
          conversation,
          {
            type: 'thought',
            body: waiting
              ? `Queued: another worker is busy on ${issue.identifier}; I start when it finishes.`
              : `Starting as \`${lane.agent}\` in project ${project.id}${made ? ` on branch \`${issue.branchName}\`` : ', working in the project checkout'}.`,
          },
          true,
        ).catch(error => log.warn('notify.failed', { error }));
        if (made && made.path !== path) store.rebind(conversation, { directory: made.path });
        const place = made
          ? `You work in the git worktree ${made.path} on branch ${issue.branchName} (from ${made.base}).`
          : `You work in the project's clean checkout ${project.directory} on its current branch; leave it as you found it — the checkout is the source of truth. The agent file says what you may change.`;
        const text = [
          `[Linear delegated ${issue.identifier} "${issue.title}" to you (app ${app.id}) in project ${project.id}, lane "${issue.state.name}". ${place} Your final answer is posted to the issue as your response; questions you ask are posted too and answered as follow-ups.]`,
          payload.promptContext ??
            `<issue identifier="${issue.identifier}"><title>${issue.title}</title><description>${issue.description ?? ''}</description></issue>`,
        ].join('\n\n');
        store.enqueue(
          { id: `created:${payload.agentSession.id}`, channel: conversation, user: app.userId, name: 'Linear', text },
          100,
        );
      } else {
        // The assistant: who people reach directly. A delegation nothing
        // claims is un-taken here; the assistant's response is the trail.
        if (delegated)
          await app.client.setDelegate(issue.id, null).catch(error => log.warn('delegate.undone', { error }));
        store.bind(conversation, {
          agent: assistantAgent(services.loaded.config),
          directory: project ? project.directory : home,
          project: project?.id ?? null,
        });
        await activity(
          conversation,
          { type: 'thought', body: `One moment — reading ${issue.identifier}.` },
          true,
        ).catch(error => log.warn('notify.failed', { error }));
        const situation = delegated
          ? `[${issue.identifier} "${issue.title}" was delegated to you, but its lane ("${issue.state.name}") is not mapped to any agent. Do not do the work: respond briefly — a refusal or a clarification — and leave it with the people.]`
          : `[Someone brought you ${issue.identifier} in ${project ? `project ${project.id}` : 'a team no project maps'}. Answer, clarify or decline; you do not do the work.]`;
        const text = [
          situation,
          payload.promptContext ??
            `<issue identifier="${issue.identifier}"><title>${issue.title}</title><description>${issue.description ?? ''}</description></issue>`,
        ].join('\n\n');
        store.enqueue(
          { id: `created:${payload.agentSession.id}`, channel: conversation, user: app.userId, name: 'Linear', text },
          100,
        );
      }
      engine?.tick();
    };

    const onPrompted = async (app: LinearAppRuntime, payload: AgentSessionEventPayload) => {
      const conversation = conversationFor(app.id, payload.agentSession.id);
      const prompt = payload.agentActivity;
      if (!prompt) return;
      if (!store.has(conversation))
        return refuse(
          conversation,
          'I do not know this session (it started before aivi did, or its state is gone). Delegate the issue to me again.',
        );
      if (prompt.signal === 'stop') {
        const result = await stopRunningTurn(engine!, services.opencode, conversation);
        if (result.error) log.warn('stop.interrupt_failed', { error: result.error });
        if (!result.stopped) await activity(conversation, { type: 'response', body: 'Nothing is running right now.' });
        return;
      }
      const text = prompt.content?.body?.trim();
      if (!text) return;
      store.enqueue({ id: prompt.id, channel: conversation, user: 'linear', name: 'a person in Linear', text }, 100);
      engine?.tick();
    };

    /**
     * An issue changed. Three things matter, all read from the API rather than the payload so
     * label names, state names and the delegate are current: the HITL label appearing, the
     * lane leaving its mapping or naming another agent, or the delegate being taken away
     * while a worker is pending (stop it); and, with the listener on, an issue entering a
     * mapped lane with nobody on it (delegate the primary and start its session).
     */
    const onIssue = async (primary: LinearAppRuntime, payload: IssueEventPayload) => {
      if (payload.action !== 'update') return;
      const changed = Object.keys(payload.updatedFrom ?? {});
      if (!changed.some(k => ['stateId', 'labelIds', 'delegateId'].includes(k))) return;
      const issue = await primary.client.issue(payload.data.id);
      const project = projectForIssue(services.loaded.projects, {
        teamId: issue.team.id,
        organizationId: payload.organizationId,
      });
      if (!project) return;
      // Lane names are per Linear team; two mapped teams sharing a state name share the lane's agent.
      const lane = project.linear?.lanes[issue.state.name];
      const human = issue.labels.some(l => l.name === config.humanLabel);
      const pending = store.pendingForIssue(issue.id);
      for (const conversation of pending) {
        const { app: workerApp } = conversationParts(conversation);
        const workerAgent = store.sessionOf(conversation)?.agent;
        if (human && changed.includes('labelIds'))
          await stopWorker(
            conversation,
            `Stopped: \`${config.humanLabel}\` was added to ${issue.identifier}; a person takes over.`,
          );
        else if (changed.includes('stateId') && lane?.agent !== workerAgent)
          await stopWorker(
            conversation,
            `Stopped: ${issue.identifier} moved to "${issue.state.name}", which is not my lane.`,
          );
        else if (changed.includes('delegateId') && issue.delegate?.id !== apps.get(workerApp)?.userId)
          await stopWorker(conversation, `Stopped: I am no longer the delegate of ${issue.identifier}.`);
      }
      if (!config.listener || !changed.includes('stateId') || !lane || human || pending.length) return;
      if (issue.delegate) return;
      // Linear's native blocking: an issue blocked by unfinished issues is not picked up.
      if (issue.blockedBy.some(b => b.state.type !== 'completed' && b.state.type !== 'canceled')) {
        log.info('listener.blocked', { issue: issue.identifier, by: issue.blockedBy.map(b => b.id) });
        return;
      }
      const agentSession = await primary.client.createSessionOnIssue(issue.id);
      await primary.client.setDelegate(issue.id, primary.userId);
      log.info('listener.delegated', {
        issue: issue.identifier,
        lane: issue.state.name,
        agent: lane.agent,
        agentSession,
      });
      // Whether Linear also sends a `created` for a session we opened ourselves is open (plan, verify 2);
      // starting from the mutation is right either way, the later webhook being a redelivery.
      await onCreated(primary, {
        type: 'AgentSessionEvent',
        action: 'created',
        organizationId: payload.organizationId,
        webhookTimestamp: Date.now(),
        agentSession: { id: agentSession, issue: { id: issue.id, identifier: issue.identifier } },
      });
    };

    /**
     * A delivery at the wrong endpoint is a checkbox in Linear disagreeing
     * with the config: acknowledged so Linear does not retry a working
     * endpoint, and dropped; `logMisroutes` decides whether the drop is
     * audible. An unknown payload type is not a misroute, only unheard.
     */
    const misrouted = (endpoint: string, payload: LinearWebhook) => {
      const fields = { endpoint, type: payload.type, action: payload.action };
      if (config.logMisroutes) log.warn('webhook.misrouted', fields);
      else log.debug('webhook.misrouted', fields);
    };

    /**
     * One route shape: `POST /v1/linear/webhooks/app/<id>`, verified by that
     * app's secret. The primary's route carries both families — its own
     * agent-session events and the workspace's Issues data changes. A data
     * change on a face's route is a misroute: acknowledged, dropped, audible
     * per `linear.logMisroutes`.
     */
    const dispatch = async (appId: string, payload: LinearWebhook) => {
      if (abort.signal.aborted) return;
      const app = apps.get(appId);
      if (!app) return log.warn('webhook.unknown-app', { app: appId, type: payload.type, action: payload.action });
      if (isAgentSessionEvent(payload)) {
        if (payload.action === 'created') await onCreated(app, payload);
        else await onPrompted(app, payload);
        return;
      }
      if (isIssueEvent(payload)) {
        if (appId !== primaryId) return misrouted(appId, payload);
        return onIssue(app, payload);
      }
      log.debug('webhook.ignored', { app: appId, type: payload.type, action: payload.action });
    };

    const unroute = registerWebhookRoutes(services.routes, [...apps.values()], dispatch, log);

    // A worker interrupted by a restart is blocked (nobody knows whether the agent stopped); say so in its session.
    for (const turn of interrupted) {
      void activity(turn.channel, {
        type: 'error',
        body: 'aivi was restarted while I was working. The worktree and the OpenCode session are left as they are; an operator must inspect and resolve this before the project is worked on again.',
      }).catch(error => log.warn('notify.failed', { error }));
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
    });
    engine.tick();
    log.info('ready', { apps: [...apps.keys()], listener: config.listener });

    return {
      async stop() {
        unroute();
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
 * issue, or an assistant session bound to no issue. */
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

import type { LinearConfig, Project } from '@aivi/core';
import { errorMessage, linearSecretNames } from '@aivi/core';
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
import { type AgentSessionEventPayload, isAgentSessionEvent, isIssueEvent, type LinearWebhook } from './webhook.ts';
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
    stopped: 'Stopped at your request. The worktree and the OpenCode session are left as they are for inspection.',
    notStarted: 'I could not reach my agent runtime, so nothing was started. Send another message to try again.',
    offline:
      'aivi is going offline (a restart or shutdown). This worker was stopped; the worktree and the OpenCode session are left as they are.',
    offlineMidReply: 'aivi is going offline while posting my answer; it may be incomplete.',
    offlineQueued:
      'aivi is going offline (a restart or shutdown). This request stays queued and starts when it is back.',
    blocked:
      'I could not finish this and cannot tell whether the agent stopped. An operator has been notified; the project stays locked until they resolve it.',
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
  agent: string;
  client: LinearClient;
  webhookSecret: string;
  /** The app user's id in the workspace; what `Issue.delegate` points at when it is us. */
  userId: string;
}

/** Credentials for every configured app, from the environment; a missing one is the operator's to fix. */
export function requireLinearSecrets(config: LinearConfig, env: NodeJS.ProcessEnv = process.env) {
  const out: { id: string; agent: string; clientId: string; clientSecret: string; webhookSecret: string }[] = [];
  for (const [id, app] of Object.entries(config.apps)) {
    const names = linearSecretNames(id);
    const missing = Object.values(names).filter(name => !env[name]);
    if (missing.length) throw new ConfigurationError(`Linear app ${id}: set ${missing.join(', ')} in <home>/.env`);
    out.push({
      id,
      agent: app.agent,
      clientId: env[names.clientId]!,
      clientSecret: env[names.clientSecret]!,
      webhookSecret: env[names.webhookSecret]!,
    });
  }
  return out;
}

export function createLinearModule(config: LinearConfig, clients?: Map<string, LinearClient>): HostModule {
  return { id: LINEAR.id, start: services => startLinear(config, services, clients) };
}

/** Which aivi project an issue belongs to: by Linear project id, and by workspace when one is configured. */
export function projectForIssue(
  projects: Project[],
  issue: { projectId: string | null; organizationId: string },
): Project | undefined {
  return projects.find(
    p =>
      !p.removed &&
      p.linear?.projectId === issue.projectId &&
      (!p.linear.workspaceId || p.linear.workspaceId === issue.organizationId),
  );
}

async function startLinear(config: LinearConfig, services: HostServices, givenClients?: Map<string, LinearClient>) {
  const log = services.log.child({ component: 'linear' });
  const store = openLinearStore(services.store);
  const interrupted = store.recover();
  if (interrupted.length) log.warn('turns.interrupted', { blocked: interrupted.length });

  const apps = new Map<string, LinearAppRuntime>();
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
    apps.set(secret.id, { id: secret.id, agent: secret.agent, client, webhookSecret: secret.webhookSecret, userId });
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

    const onCreated = async (app: LinearAppRuntime, payload: AgentSessionEventPayload) => {
      const conversation = conversationFor(app.id, payload.agentSession.id);
      if (store.has(conversation)) return; // a redelivery
      const issueId = payload.agentSession.issue?.id;
      if (!issueId) return refuse(conversation, 'I only work on issues; this session has none.');
      const issue = await app.client.issue(issueId);
      const project = projectForIssue(services.loaded.projects, {
        projectId: issue.project?.id ?? null,
        organizationId: payload.organizationId,
      });
      if (!project)
        return refuse(
          conversation,
          `${issue.identifier} is not in a Linear project that aivi maps to a checkout (\`projects.<id>.linear.projectId\`), so I cannot work on it.`,
        );
      if (issue.labels.some(l => l.name === config.humanLabel))
        return refuse(
          conversation,
          `${issue.identifier} carries the \`${config.humanLabel}\` label, so a person handles it. Remove the label to let me work on it.`,
        );
      const path = worktreePathFor(project.directory, payload.agentSession.id);
      store.bind(conversation, { agent: app.agent, directory: path, project: project.id, issue: issue.id });
      const waiting = store.waitingOn(conversation);
      await activity(
        conversation,
        {
          type: 'thought',
          body: waiting
            ? `Queued: another worker is busy in project ${project.id}${waiting.issue && waiting.issue !== issue.id ? ' on another issue' : ''}; I start when it finishes.`
            : `Starting as \`${app.agent}\` in project ${project.id} on branch \`${issue.branchName}\`.`,
        },
        true,
      ).catch(error => log.warn('notify.failed', { error }));
      let made: Awaited<ReturnType<typeof ensureWorktree>>;
      try {
        made = await ensureWorktree({
          source: project.directory,
          path,
          branch: issue.branchName,
          signal: abort.signal,
        });
      } catch (error) {
        return refuse(conversation, `I could not prepare a worktree for ${issue.identifier}: ${errorMessage(error)}`);
      }
      if (made.path !== path) store.rebind(conversation, { directory: made.path });
      const lane = issue.state.name;
      const text = [
        `[Linear delegated ${issue.identifier} "${issue.title}" to you (app ${app.id}) in project ${project.id}, lane "${lane}". You work in the git worktree ${made.path} on branch ${issue.branchName} (from ${made.base}). Your final answer is posted to the issue as your response; questions you ask are posted too and answered as follow-ups.]`,
        payload.promptContext ??
          `<issue identifier="${issue.identifier}"><title>${issue.title}</title><description>${issue.description ?? ''}</description></issue>`,
      ].join('\n\n');
      store.enqueue(
        { id: `created:${payload.agentSession.id}`, channel: conversation, user: app.userId, name: 'Linear', text },
        100,
      );
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

    const dispatch = async (appId: string, payload: LinearWebhook) => {
      if (abort.signal.aborted) return;
      const app = apps.get(appId)!;
      if (isAgentSessionEvent(payload)) {
        if (payload.action === 'created') await onCreated(app, payload);
        else await onPrompted(app, payload);
        return;
      }
      if (isIssueEvent(payload)) {
        log.debug('issue.event', { app: appId, action: payload.action, issue: payload.data.identifier });
        return; // the listener and the HITL-mid-run stop come with step 6 of docs/plans/linear.md
      }
      log.debug('webhook.ignored', { app: appId, type: payload.type, action: payload.action });
    };
    const unroute = registerWebhookRoutes(
      services.routes,
      [...apps.values()].map(a => ({ id: a.id, webhookSecret: a.webhookSecret })),
      dispatch,
      log,
    );

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

/** For `aivi linear status`: what each worker conversation is doing. */
export function describeWorkers(store: ConversationStore): { conversation: string; turn: Turn }[] {
  return store
    .list()
    .filter(t => !['sent', 'discarded'].includes(t.state))
    .map(t => ({ conversation: t.channel, turn: t }));
}

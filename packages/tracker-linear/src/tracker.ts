/** Linear's **platform**: the `Platform` contract of `@aivi/plugin/tracker`
 *  spelled in Linear's words. It owns everything Linear-shaped below the
 *  neutral surface — the apps and their credentials, the webhook endpoints
 *  and their signatures, the GraphQL reads and mutations, the agent-session
 *  activity types — and translates at the border: platform events become
 *  `TrackerEvent`s, neutral updates become Linear mutations. The module's
 *  decision code imports **no** Linear types through this file; if it needs
 *  something Linear-shaped, the neutral contract grows (or the answer stays
 *  here), never the other way around.
 *
 *  `createStates` and `candidates` come with the orchestrator extraction's
 *  dispatch work (the lane-map fetch and the pull-shaped queue read); the
 *  module never polled today, so the adapter does not pretend to.
 */
import { getLogger, type Logger } from '@aivi/core';
import { ConfigurationError } from '@aivi/host';
import type { PublicRoutes } from '@aivi/plugin';
import type { RunPlan, RunQuestion } from '@aivi/plugin/run';
import type {
  Platform,
  TrackerChange,
  TrackerCommentKind,
  TrackerEvent,
  TrackerIssue,
  TrackerProgressLine,
  TrackerState,
  TrackerUpdate,
} from '@aivi/plugin/tracker';
import { LinearApiError, LinearClient } from './client.ts';
import type { LinearConfig } from './config.ts';
import { linearPrimarySecretNames, linearSecretNames, MODULE_ID, primaryLinearApp } from './config.ts';
import { registerWebhookRoutes } from './routes.ts';
import { isAgentSessionEvent, isIssueEvent, type LinearWebhook } from './webhook.ts';

/** One Linear app, ready to speak: its client, its webhook secret, and who
 *  aivi is there (`userId`) and in which workspace (`orgId`), learned at
 *  `ready` from the credentials themselves. */
export interface LinearAppRuntime {
  id: string;
  client: LinearClient;
  webhookSecret: string;
  userId: string;
  orgId: string;
}

/** Credentials for every configured app, from the environment; a missing one
 *  is the operator's to fix. The primary app (the one app, or `linear.primary`)
 *  keeps the bare `LINEAR_*` names; every other app — a face — uses
 *  `LINEAR_<APP>_*`. */
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

/** The client to ask for teams: the one configured app, or the one `--app` names.
 * `requireLinearSecrets` names the missing LINEAR_* variables when secrets are absent. */
export function clientFor(config: LinearConfig, app: string | undefined, log: Logger): LinearClient {
  const ids = Object.keys(config.apps);
  if (!ids.length) throw new Error('linear.apps is empty: configure a Linear app before pointing projects at teams');
  if (ids.length > 1 && !app) throw new Error(`Several Linear apps are configured (${ids.join(', ')}): pass --app`);
  const id = app ?? ids[0]!;
  if (!config.apps[id]) throw new Error(`Unknown Linear app ${id}. Configured: ${ids.join(', ')}`);
  const creds = requireLinearSecrets(config).find(cred => cred.id === id);
  return new LinearClient(creds!, { log });
}

/** Linear's verdict of *finished as far as work goes*: `completed` (Done) and
 *  `canceled` (Canceled, Won't Fix, Could not reproduce) both end the ticket's
 *  claim on anyone's attention. The words live here and nowhere above — the
 *  neutral contract carries only the verdict (`completed`), which is what the
 *  decision code and the orchestrator ever see. */
export const isClosed = (stateType: string): boolean =>
  stateType === 'completed' || stateType === 'canceled' || stateType === 'duplicate';

/** Translate a fresh Linear issue into the neutral facts the decision code
 *  reads. This is the only place Linear field names survive. */
export function neutralIssue(issue: Awaited<ReturnType<LinearClient['issue']>>): TrackerIssue {
  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    branchName: issue.branchName ?? '',
    url: issue.url,
    state: issue.state,
    teamId: issue.team.id,
    labels: issue.labels,
    delegateId: issue.delegate?.id ?? null,
    assignee: issue.assignee,
    archived: issue.archivedAt !== null,
    completed: isClosed(issue.state.type),
    blockedBy: issue.blockedBy.map(b => ({ id: b.id, completed: isClosed(b.state.type) })),
  };
}

export class LinearPlatform implements Platform {
  readonly id = MODULE_ID;

  private readonly config: LinearConfig;
  private readonly routes: PublicRoutes;
  private readonly clients: Map<string, LinearClient> | undefined;
  private readonly apps = new Map<string, LinearAppRuntime>();
  private readonly primaryId: string | undefined;
  private readonly logMisroutes: boolean;
  private readonly log: Logger;

  /** `clients` is a test seam keyed by app id; real clients come from the
   *  environment. Construction checks the config's shape; `ready` and
   *  `events` reach the network and the host's routes. */
  constructor(
    config: LinearConfig,
    routes: PublicRoutes,
    clients?: Map<string, LinearClient>,
    log: Logger = getLogger(['aivi', MODULE_ID]),
  ) {
    this.config = config;
    this.log = log;
    this.routes = routes;
    this.clients = clients;
    this.primaryId = primaryLinearApp(config);
    this.logMisroutes = config.logMisroutes;
    if (!Object.keys(config.apps).length)
      throw new ConfigurationError('linear.apps is empty: configure a Linear app before pointing projects at teams');
    for (const secret of requireLinearSecrets(config))
      this.apps.set(secret.id, {
        id: secret.id,
        client: clients?.get(secret.id) ?? new LinearClient(secret, { log }),
        webhookSecret: secret.webhookSecret,
        userId: '',
        orgId: '',
      });
  }

  /** The app that carries the data feed and authorises the Linear MCP. */
  get primary(): LinearAppRuntime {
    const primary = this.primaryId ? this.apps.get(this.primaryId) : undefined;
    if (!primary) throw new ConfigurationError('Linear: no primary app is ready');
    return primary;
  }

  /** Learn who aivi is in each app's workspace; bad credentials are a setup
   *  error the operator fixes, not a retry. `createLinearPlatform` awaits
   *  this; it is public so a caller may re-learn the identities. */
  async ready(): Promise<void> {
    for (const runtime of this.apps.values()) {
      try {
        const viewer = await runtime.client.viewer();
        runtime.userId = viewer.id;
        runtime.orgId = viewer.organizationId;
      } catch (error) {
        if (error instanceof LinearApiError && (error.status === 400 || error.status === 401))
          throw new ConfigurationError(`Linear app ${runtime.id}: credentials rejected (${error.message})`);
        throw error;
      }
    }
  }

  /** The app a conversation belongs to. A conversation is `<app>:<agent
   *  session id>`; a bare app id is the app's own feed — a ticket's data
   *  change arrives before any session of its own exists. */
  private of(conversation: string): LinearAppRuntime {
    const runtime = this.apps.get(this.parts(conversation).app);
    if (!runtime) throw new Error(`Linear app for conversation ${conversation} is not configured`);
    return runtime;
  }

  /** A session the platform names arrives on the primary's endpoint — a
   *  face's agent sessions reach aivi through the primary's data feed — so
   *  its conversation carries the primary's namespace. */
  idFor(sessionId: string): string {
    return `${this.primaryId}:${sessionId}`;
  }

  parts(conversation: string): { app: string; session: string } {
    const at = conversation.indexOf(':');
    return at < 0
      ? { app: conversation, session: '' }
      : { app: conversation.slice(0, at), session: conversation.slice(at + 1) };
  }

  async orgOf(conversation: string): Promise<string> {
    return this.of(conversation).orgId;
  }

  ownerOf(conversation: string): string {
    return this.of(conversation).userId;
  }

  async issue(conversation: string, issueId: string): Promise<TrackerIssue> {
    return neutralIssue(await this.of(conversation).client.issue(issueId));
  }

  async laneStates(conversation: string, teamId: string): Promise<TrackerState[]> {
    const teams = await this.of(conversation).client.listTeams();
    const team = teams.find(t => t.id === teamId);
    if (!team) throw new Error(`Linear team ${teamId} is not visible to app ${this.of(conversation).id}`);
    return team.states;
  }

  async assign(conversation: string, issueId: string, userId: string): Promise<void> {
    await this.of(conversation).client.setDelegate(issueId, userId);
  }

  async unassign(conversation: string, issueId: string): Promise<void> {
    await this.of(conversation).client.setDelegate(issueId, null);
  }

  /** Making the app the delegate creates the agent session itself, in the
   *  mutation's own answer (live, 2026-09-26); the `created` webhook that
   *  follows is a redelivery the module dedupes. */
  async startSession(conversation: string, issueId: string): Promise<string | null> {
    const app = this.of(conversation);
    const answer = await app.client.setDelegate(issueId, app.userId);
    const made = answer.issue?.agentSessions.nodes.find(s => s.status === 'pending');
    return made?.id ?? null;
  }

  /** The agent session a conversation names. A bare app id — the ticket's
   *  own feed — has no session to speak into: only a worker or the
   *  assistant, which always arrive with one, may comment. */
  private sessionOf(conversation: string): string {
    const { session } = this.parts(conversation);
    if (!session) throw new Error(`conversation ${conversation} names no agent session`);
    return session;
  }

  /** The neutral kinds, rendered as Linear's agent-session activities: an
   *  answer is a visible response, an outcome the visible error, progress
   *  the ephemeral thought replaced as work moves, a note a visible thought. */
  async comment(conversation: string, text: string, kind: TrackerCommentKind): Promise<string | undefined> {
    const content =
      kind === 'answer'
        ? { type: 'response' as const, body: text }
        : kind === 'outcome'
          ? { type: 'error' as const, body: text }
          : { type: 'thought' as const, body: text };
    return this.of(conversation).client.createActivity({
      agentSessionId: this.sessionOf(conversation),
      content,
      ...(kind === 'progress' ? { ephemeral: true } : {}),
    });
  }

  /** The progress stream, in Linear's own activities (docs/linear.md): a
   *  running tool is an ephemeral `action` naming it, anything else an
   *  ephemeral `thought`. Ephemeral is Linear's word for *replaced*: the
   *  person sees the worker's current moment, never a trail of lines. */
  async progress(conversation: string, line: TrackerProgressLine): Promise<void> {
    await this.of(conversation).client.createActivity({
      agentSessionId: this.sessionOf(conversation),
      content: line.tool
        ? { type: 'action', action: line.tool.name, parameter: line.tool.detail ?? line.text }
        : { type: 'thought', body: line.text },
      ephemeral: true,
    });
  }

  /**
   * Linear's way with a question: an `elicitation` activity in the agent
   * session, carrying the `select` signal with the options when there are
   * any (docs/agent-signals, live shape). The person may answer by picking —
   * the choice arrives as an ordinary `prompted` event carrying the value —
   * or in free text, which dismisses the elicitation just the same. The
   * session waits in `awaitingInput` for as long as it takes: an elicitation
   * is not on any clock.
   */
  async ask(conversation: string, question: RunQuestion): Promise<void> {
    await this.of(conversation).client.createActivity({
      agentSessionId: this.sessionOf(conversation),
      content: { type: 'elicitation', body: question.question },
      ...(question.options?.length ? { signal: 'select' as const, signalMetadata: { options: question.options } } : {}),
    });
  }

  /** Linear's way with a plan: replace the agent session's plan wholesale —
   *  the same words Linear's own API uses for it, statuses and all
   *  (docs/agent-interaction, Agent Plans). */
  async plan(conversation: string, plan: RunPlan): Promise<void> {
    await this.of(conversation).client.setPlan(this.sessionOf(conversation), plan.steps);
  }

  /** Linear's word for "the result was shown": the response activity that
   *  renders a success *completes* the agent session (docs, live), so an
   *  ended session has said its piece and a retry must not say it again. */
  async resultShown(conversation: string): Promise<boolean> {
    return this.of(conversation).client.agentSessionEnded(this.sessionOf(conversation));
  }

  /** The closing note on the **ticket** (ruled 2026-10-02: the answer was
   *  only readable by opening the agent session). The person gets the text
   *  plus a link to the session that did the work. Idempotence is ours, as
   *  the seam demands: the marker is this conversation's agent session id —
   *  a comment already carrying it means the note stands, so wake retries
   *  and the boot pass never post it twice. */
  async closingNote(conversation: string, issueId: string, text: string): Promise<void> {
    const session = this.sessionOf(conversation);
    const facts = await this.of(conversation).client.closingNoteFacts(issueId);
    if (facts.comments.some(c => c.body.includes(session))) return;
    const url = facts.sessions.find(s => s.id === session)?.url;
    const link = url ? `[agent session](${url})` : `agent session \`${session}\``;
    await this.of(conversation).client.createComment(issueId, `${text}\n\n— aivi · ${link}`);
  }

  /**
   * Perform one neutral update. A `move` resolves the lane's *name* against
   * the issue's team — the names come from the project's lane config, which
   * is core's decision; Linear is only ever asked to transition, and only
   * when the issue is not in that state already (the boot pass may re-drive
   * a move that already landed). Labels wait for their own mutation work;
   * nothing on today's path asks for one.
   */
  async apply(conversation: string, issueId: string, update: TrackerUpdate): Promise<void> {
    if (update.kind === 'comment') return void (await this.comment(conversation, update.text, 'note'));
    if (update.kind !== 'move') throw new Error(`Linear cannot apply "${update.kind}" yet`);
    const client = this.of(conversation).client;
    const issue = await client.issue(issueId);
    const teams = await client.listTeams();
    const state = teams.find(t => t.id === issue.team.id)?.states.find(s => s.name === update.lane);
    if (!state)
      throw new Error(`Linear team ${issue.team.key} has no state named "${update.lane}" — check the project's lanes`);
    if (issue.state.id === state.id) return; // already there: the move landed before a crash
    await client.transitionIssue(issueId, state.id);
  }

  /** One public route per app, verified by that app's secret, acknowledged
   *  at once (Linear retries anything but a 200), then translated into the
   *  normalized events. A data change on a face's route is a misroute:
   *  dropped, audible per `linear.logMisroutes`. */
  events(sink: (event: TrackerEvent) => Promise<void>): () => void {
    const dispatch = async (appId: string, payload: LinearWebhook): Promise<void> => {
      const app = this.apps.get(appId);
      if (!app) return this.log.warn('webhook.unknown-app', { app: appId, type: payload.type, action: payload.action });
      if (isAgentSessionEvent(payload)) {
        const conversation = `${appId}:${payload.agentSession.id}`;
        if (payload.action === 'created') {
          const issueId = payload.agentSession.issue?.id;
          if (!issueId) return this.log.warn('webhook.session-without-issue', { conversation });
          return sink({
            kind: 'started',
            conversation,
            issueId,
            ...(payload.promptContext ? { promptContext: payload.promptContext } : {}),
          });
        }
        const prompt = payload.agentActivity;
        return sink({
          kind: 'prompted',
          id: prompt?.id ?? `seen:${payload.agentSession.id}`,
          conversation,
          ...(prompt?.content?.body ? { body: prompt.content.body } : {}),
          ...(prompt?.signal !== undefined ? { signal: prompt.signal } : {}),
        });
      }
      if (isIssueEvent(payload)) {
        if (appId !== this.primaryId) return this.misroute(appId, payload);
        const changed: TrackerChange[] = [];
        for (const [field, change] of [
          ['stateId', 'state'],
          ['labelIds', 'labels'],
          ['delegateId', 'delegate'],
        ] as const)
          if (payload.updatedFrom && field in payload.updatedFrom) changed.push(change);
        // A data change always arrives on the primary: its route carries
        // the workspace's feed, so the re-read speaks with the primary.
        return sink({ kind: 'updated', conversation: `${this.primaryId}`, issueId: payload.data.id, changed });
      }
      this.log.debug('webhook.ignored', { app: appId, type: payload.type, action: payload.action });
    };
    return registerWebhookRoutes(this.routes, [...this.apps.values()], dispatch, this.log);
  }

  private misroute(endpoint: string, payload: LinearWebhook): void {
    const fields = { endpoint, type: payload.type, action: payload.action };
    if (this.logMisroutes) this.log.warn('webhook.misrouted', fields);
    else this.log.debug('webhook.misrouted', fields);
  }
}

/** Build Linear's adapter: the config's shape is checked here and the
 *  identities are learned before it comes back — a tracker from here is
 *  ready to speak. Route registration stays with `events`, which the module
 *  calls once its own handlers exist. */
export async function createLinearPlatform(
  config: LinearConfig,
  routes: PublicRoutes,
  clients?: Map<string, LinearClient>,
  log?: Logger,
): Promise<LinearPlatform> {
  const tracker = new LinearPlatform(config, routes, clients, log);
  await tracker.ready();
  return tracker;
}

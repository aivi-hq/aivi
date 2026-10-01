import type { Logger } from '@aivi/core';
import { errorMessage, getLogger } from '@aivi/core';
import { MODULE_ID } from './config.ts';

/** What one Linear app needs to talk to the API: a client-credentials token, nothing persisted. */
export interface LinearCredentials {
  clientId: string;
  clientSecret: string;
}

export interface LinearClientOptions {
  /** `https://api.linear.app` unless a test points elsewhere. */
  baseUrl?: string | undefined;
  /** Called with string URLs only; exactly what the setup context can give. */
  fetch?: ((url: string, init?: RequestInit) => Promise<Response>) | undefined;
  log?: Logger | undefined;
  /** Scopes requested with the token; the agent scopes are what make the app delegable and mentionable. */
  scope?: string | undefined;
  /** Refresh this long before `expires_in` says the token is gone (default one hour). */
  refreshSkewMs?: number | undefined;
}

/** One of the five activity types an app may emit; `prompt` is what people send and never ours. */
export type AgentActivityContent =
  | { type: 'thought'; body: string }
  | { type: 'elicitation'; body: string }
  | { type: 'action'; action: string; parameter: string; result?: string }
  | { type: 'response'; body: string }
  | { type: 'error'; body: string };

export interface AgentActivityInput {
  agentSessionId: string;
  content: AgentActivityContent;
  /** Shown until the next activity replaces it; only `thought` and `action` may be ephemeral. */
  ephemeral?: boolean;
  signal?: 'auth' | 'select';
  signalMetadata?: Record<string, unknown>;
}

/** The issue fields eligibility and routing read. */
export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  branchName: string;
  url: string;
  state: { id: string; name: string; type: string };
  team: { id: string; key: string };
  labels: { id: string; name: string }[];
  delegate: { id: string } | null;
  assignee: { id: string; name: string } | null;
  /** ISO instant the issue was archived — Linear's delete — null while it
   *  lives. A dead ticket gets nothing from a session: there is no work. */
  archivedAt: string | null;
  /** Issues blocking this one; a blocker not in a finished state holds the listener back. */
  blockedBy: { id: string; state: { id: string; name: string; type: string } }[];
}

export interface LinearAgentSession {
  id: string;
  status: string;
  issue: { id: string } | null;
}

/**
 * What the delegate mutation answers: whether it worked, and the issue's
 * agent sessions as Linear sees them in that very moment. Making the app
 * the delegate creates the session itself, and it appears here — the
 * listener starts the worker from this answer, not from a webhook.
 */
export interface DelegateAnswer {
  success: boolean;
  issue?:
    | {
        identifier: string;
        agentSessions: { nodes: { id: string; status: string; startedAt: string | null; url: string | null }[] };
      }
    | undefined;
}

/** A team in the workspace: the `id` is what aivi's config holds, the `key`
 * is what Linear's URLs and issue identifiers show. States drive the lane
 * picker; `type` completed or canceled lanes are never offered for work. */
export interface LinearTeam {
  id: string;
  key: string;
  name: string;
  states: { id: string; name: string; type: string }[];
}

export class LinearApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'LinearApiError';
    this.status = status;
  }
}

const DEFAULT_SCOPE = 'read,write,app:assignable,app:mentionable';

const ISSUE_FIELDS = `
  id identifier title description branchName url
  state { id name type }
  team { id key }
  labels { nodes { id name } }
  delegate { id }
  assignee { id name }
  archivedAt
  inverseRelations { nodes { type issue { id state { id name type } } } }
`;

type RawIssue = Omit<LinearIssue, 'labels' | 'blockedBy'> & {
  labels: { nodes: LinearIssue['labels'] };
  inverseRelations: { nodes: { type: string; issue: LinearIssue['blockedBy'][number] }[] };
};
const issueOf = ({ labels, inverseRelations, ...rest }: RawIssue): LinearIssue => ({
  ...rest,
  labels: labels.nodes,
  // The live Linear schema has no `blockedBy` on Issue: relations are
  // directional, and in `inverseRelations` the relation's source (`issue`) is
  // the blocker of our issue, with `type` the lowercase string `blocks`.
  blockedBy: inverseRelations.nodes.filter(r => r.type === 'blocks').map(r => r.issue),
});

/**
 * A small GraphQL client for one Linear app. The token is obtained with the
 * `client_credentials` grant (an `app` actor token valid for 30 days), kept in
 * memory, refreshed ahead of its expiry and re-fetched once on a 401. There is
 * no `@linear/sdk`: six operations do not justify it.
 */
/** Linear's workflow state groups in board order. `position` is scoped
 *  **within a type group** (SDL: "States are displayed in ascending order
 *  of position within their type group"), so sorting by position alone
 *  interleaves the groups: Done and Canceled each rank near 0 of their own
 *  group and would sort before a late `started` lane. Group first, then
 *  position — that is the board. */
const stateGroupOrder = ['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled', 'duplicate'];
const byBoardOrder = (a: { type: string; position: number }, b: { type: string; position: number }): number => {
  const group = stateGroupOrder.indexOf(a.type) - stateGroupOrder.indexOf(b.type);
  return group !== 0 ? group : a.position - b.position;
};

export class LinearClient {
  private readonly credentials: LinearCredentials;
  private readonly baseUrl: string;
  private readonly fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  private readonly log: Logger;
  private readonly scope: string;
  private readonly skew: number;
  private token: { value: string; expiresAt: number } | null = null;
  private refreshing: Promise<string> | null = null;

  constructor(credentials: LinearCredentials, options: LinearClientOptions = {}) {
    this.credentials = credentials;
    this.baseUrl = (options.baseUrl ?? 'https://api.linear.app').replace(/\/$/, '');
    this.fetchImpl = options.fetch ?? fetch;
    this.log = options.log ?? getLogger(['aivi', MODULE_ID]);
    this.scope = options.scope ?? DEFAULT_SCOPE;
    this.skew = options.refreshSkewMs ?? 3_600_000;
  }

  /** A valid token, fetching or refreshing when needed; concurrent callers share one request. */
  async accessToken(force = false): Promise<string> {
    if (!force && this.token && this.token.expiresAt - this.skew > Date.now()) return this.token.value;
    if (!this.refreshing) {
      this.refreshing = this.fetchToken().finally(() => {
        this.refreshing = null;
      });
    }
    return this.refreshing;
  }

  private async fetchToken(): Promise<string> {
    const body = new URLSearchParams({ grant_type: 'client_credentials', scope: this.scope });
    const basic = Buffer.from(`${this.credentials.clientId}:${this.credentials.clientSecret}`).toString('base64');
    const response = await this.fetchImpl(`${this.baseUrl}/oauth/token`, {
      method: 'POST',
      headers: { authorization: `Basic ${basic}`, 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new LinearApiError(`Linear token request failed (${response.status}): ${describe(text)}`, response.status);
    }
    const parsed = JSON.parse(text) as { access_token?: string; expires_in?: number };
    if (!parsed.access_token) throw new LinearApiError('Linear token response had no access_token', 502);
    this.token = { value: parsed.access_token, expiresAt: Date.now() + (parsed.expires_in ?? 86_400) * 1000 };
    // A token fetch per API burst is debug-level detail, not something a setup prompt should interleave.
    this.log.debug('linear.token', { expiresIn: parsed.expires_in ?? null });
    return this.token.value;
  }

  /** Run one GraphQL operation; a 401 refreshes the token and retries once. */
  async graphql<T>(query: string, variables: Record<string, unknown> = {}, retried = false): Promise<T> {
    const token = await this.accessToken();
    const response = await this.fetchImpl(`${this.baseUrl}/graphql`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
    });
    if (response.status === 401 && !retried) {
      await this.accessToken(true);
      return this.graphql(query, variables, true);
    }
    const text = await response.text();
    if (!response.ok) throw new LinearApiError(`Linear API ${response.status}: ${describe(text)}`, response.status);
    const parsed = JSON.parse(text) as { data?: T; errors?: { message: string }[] };
    if (parsed.errors?.length) throw new LinearApiError(parsed.errors.map(e => e.message).join('; '), 200);
    if (parsed.data === undefined) throw new LinearApiError('Linear API returned no data', 502);
    return parsed.data;
  }

  /** The app user's own id and its workspace in one round; also proves the
   *  credentials work. The tracker adapter learns `userId`/`orgId` here. */
  async viewer(): Promise<{ id: string; organizationId: string }> {
    const data = await this.graphql<{ viewer: { id: string; organization: { id: string } } }>(
      'query { viewer { id organization { id } } }',
    );
    return { id: data.viewer.id, organizationId: data.viewer.organization.id };
  }

  /** The app user's own id in this workspace; also proves the credentials work. */
  async viewerId(): Promise<string> {
    return (await this.viewer()).id;
  }

  /** The teams this app can see with their workflow states, archived excluded:
   * the answer to "which id is PEC?" and "which lanes does PEC have?".
   * Linear returns `states` as a connection; its `nodes` are flattened here. */
  async listTeams(): Promise<LinearTeam[]> {
    const data = await this.graphql<{
      teams: {
        nodes: {
          id: string;
          key: string;
          name: string;
          states: { nodes: { id: string; name: string; type: string; position: number }[] };
        }[];
      };
    }>('query { teams { nodes { id key name states { nodes { id name type position } } } } }');
    // The connection's own order is not the board's; the group order and
    // the per-group `position` are.
    return data.teams.nodes.map(team => ({
      id: team.id,
      key: team.key,
      name: team.name,
      states: team.states.nodes.sort(byBoardOrder).map(({ position: _position, ...state }) => state),
    }));
  }

  async createActivity(input: AgentActivityInput): Promise<string> {
    const data = await this.graphql<{ agentActivityCreate: { success: boolean; agentActivity: { id: string } } }>(
      `mutation($input: AgentActivityCreateInput!) { agentActivityCreate(input: $input) { success agentActivity { id } } }`,
      { input },
    );
    if (!data.agentActivityCreate.success) throw new LinearApiError('agentActivityCreate was not successful', 200);
    return data.agentActivityCreate.agentActivity.id;
  }

  /** Move an issue to a workflow state by its id — how a lane move is
   *  performed. (schema: `issueUpdate(id: String!, input: IssueUpdateInput!)`,
   *  the state carried as `input.stateId`.) */
  async transitionIssue(issueId: string, stateId: string): Promise<void> {
    const data = await this.graphql<{ issueUpdate: { success: boolean } }>(
      `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
      { id: issueId, input: { stateId } },
    );
    if (!data.issueUpdate.success) throw new LinearApiError('issueUpdate was not successful', 200);
  }

  /** A comment on the **issue** itself, not the agent session's activity:
   *  the closing note a person reads without opening the session. Posted
   *  with the app's token, so it stands as the app's comment. */
  async createComment(issueId: string, body: string): Promise<void> {
    const data = await this.graphql<{ commentCreate: { success: boolean } }>(
      `mutation($input: CommentCreateInput!) { commentCreate(input: $input) { success } }`,
      { input: { issueId, body } },
    );
    if (!data.commentCreate.success) throw new LinearApiError('commentCreate was not successful', 200);
  }

  /** What a closing note asks Linear for in one round: the issue's comment
   *  bodies (the idempotence check — a note already standing is never
   *  posted twice) and the agent sessions with their web urls (the note's
   *  marker and the link a person clicks to read the whole trail). The
   *  comment page is deliberately wide: the check must see a note older
   *  than any retry horizon. */
  async closingNoteFacts(
    issueId: string,
  ): Promise<{ comments: { body: string }[]; sessions: { id: string; url: string | null }[] }> {
    const data = await this.graphql<{
      issue: {
        comments: { nodes: { body: string }[] };
        agentSessions: { nodes: { id: string; url: string | null }[] };
      } | null;
    }>(
      `query($id: String!) { issue(id: $id) { comments(first: 100) { nodes { body } } agentSessions { nodes { id url } } } }`,
      { id: issueId },
    );
    if (!data.issue) throw new LinearApiError(`issue ${issueId} not found`, 200);
    return { comments: data.issue.comments.nodes, sessions: data.issue.agentSessions.nodes };
  }

  /** Whether Linear has closed this agent session: `endedAt` is its own word
   *  for "the result was shown", which is what a follower's retry asks
   *  before it would render a result twice. */
  async agentSessionEnded(agentSessionId: string): Promise<boolean> {
    const data = await this.graphql<{ agentSession: { endedAt: string | null } }>(
      'query($id: String!) { agentSession(id: $id) { endedAt } }',
      { id: agentSessionId },
    );
    return data.agentSession.endedAt !== null;
  }

  /** Replace the session's plan wholesale — Linear takes the full array
   *  every time (docs/agent-interaction, Agent Plans: partial updates are
   *  explicitly not a thing). `plan` is a JSONObject: the steps array as
   *  `{content, status}`. */
  async setPlan(agentSessionId: string, steps: { content: string; status: string }[]): Promise<void> {
    const data = await this.graphql<{ agentSessionUpdate: { success: boolean } }>(
      `mutation($id: String!, $input: AgentSessionUpdateInput!) { agentSessionUpdate(id: $id, input: $input) { success } }`,
      { id: agentSessionId, input: { plan: steps } },
    );
    if (!data.agentSessionUpdate.success) throw new LinearApiError('agentSessionUpdate was not successful', 200);
  }

  async issue(id: string): Promise<LinearIssue> {
    const data = await this.graphql<{ issue: RawIssue }>(`query($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`, {
      id,
    });
    return issueOf(data.issue);
  }

  /** Make (or unmake, with `null`) this app the issue's delegate; the human
   *  assignee stays. Making the app the delegate is what creates the agent
   *  session — Linear returns it in this very answer (live, 2026-09-26). */
  async setDelegate(issueId: string, delegateId: string | null): Promise<DelegateAnswer> {
    const data = await this.graphql<{ issueUpdate: DelegateAnswer }>(
      `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success issue { identifier agentSessions { nodes { id status startedAt url } } } } }`,
      { id: issueId, input: { delegateId } },
    );
    if (!data.issueUpdate.success) throw new LinearApiError('issueUpdate(delegateId) failed', 200);
    return data.issueUpdate;
  }

  /** Create an issue in a team; the installer's throwaway ticket. */
  async createIssue(input: { teamId: string; title: string; description?: string }): Promise<LinearIssue> {
    const data = await this.graphql<{ issueCreate: { success: boolean; issue: RawIssue } }>(
      `mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { ${ISSUE_FIELDS} } } }`,
      { input },
    );
    if (!data.issueCreate.success) throw new LinearApiError('issueCreate failed', 200);
    return issueOf(data.issueCreate.issue);
  }

  /** Archive an issue — Linear's delete, off the board. The installer tidies
   *  its own throwaway ticket with this. */
  async deleteIssue(issueId: string): Promise<void> {
    const data = await this.graphql<{ issueDelete: { success: boolean } }>(
      `mutation($id: String!) { issueDelete(id: $id) { success } }`,
      { id: issueId },
    );
    if (!data.issueDelete.success) throw new LinearApiError('issueDelete failed', 200);
  }
}

/**
 * Turn what an operator pastes — a team key from a Linear URL or a raw team id —
 * into the ids the config must hold. An exact id matches first, then a key
 * regardless of case; duplicates collapse and the given order is kept. An
 * unknown token is an error naming it and listing the teams the app can see:
 * a private team the app has not joined shows up here as unknown.
 */
export function resolveTeams(teams: LinearTeam[], tokens: string[]): string[] {
  const byId = new Map(teams.map(t => [t.id, t.id]));
  const byKey = new Map(teams.map(t => [t.key.toLowerCase(), t.id]));
  const out: string[] = [];
  for (const token of tokens) {
    const id = byId.get(token) ?? byKey.get(token.toLowerCase());
    if (!id) {
      const visible = teams.map(t => `${t.key} (${t.name})`).join(', ') || 'none';
      throw new Error(
        `${token} is not a team this app can see (visible: ${visible}). A private team needs the app added to it.`,
      );
    }
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

const describe = (text: string): string => {
  try {
    const parsed = JSON.parse(text) as { error?: string; error_description?: string; errors?: { message: string }[] };
    if (parsed.errors?.length) return parsed.errors.map(e => e.message).join('; ');
    return [parsed.error, parsed.error_description].filter(Boolean).join(': ') || text.slice(0, 200);
  } catch (error) {
    return text.slice(0, 200) || errorMessage(error);
  }
};

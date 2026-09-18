import type { Logger } from '@aivi/core';
import { errorMessage, silentLogger } from '@aivi/core';

/** What one Linear app needs to talk to the API: a client-credentials token, nothing persisted. */
export interface LinearCredentials {
  clientId: string;
  clientSecret: string;
}

export interface LinearClientOptions {
  /** `https://api.linear.app` unless a test points elsewhere. */
  baseUrl?: string | undefined;
  fetch?: typeof fetch | undefined;
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
}

export interface LinearAgentSession {
  id: string;
  status: string;
  issue: { id: string } | null;
}

/** A team in the workspace: the `id` is what aivi's config holds, the `key`
 * is what Linear's URLs and issue identifiers show. */
export interface LinearTeam {
  id: string;
  key: string;
  name: string;
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
`;

type RawIssue = Omit<LinearIssue, 'labels'> & { labels: { nodes: LinearIssue['labels'] } };
const issueOf = (raw: RawIssue): LinearIssue => ({ ...raw, labels: raw.labels.nodes });

/**
 * A small GraphQL client for one Linear app. The token is obtained with the
 * `client_credentials` grant (an `app` actor token valid for 30 days), kept in
 * memory, refreshed ahead of its expiry and re-fetched once on a 401. There is
 * no `@linear/sdk`: six operations do not justify it.
 */
export class LinearClient {
  private readonly credentials: LinearCredentials;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly log: Logger;
  private readonly scope: string;
  private readonly skew: number;
  private token: { value: string; expiresAt: number } | null = null;
  private refreshing: Promise<string> | null = null;

  constructor(credentials: LinearCredentials, options: LinearClientOptions = {}) {
    this.credentials = credentials;
    this.baseUrl = (options.baseUrl ?? 'https://api.linear.app').replace(/\/$/, '');
    this.fetchImpl = options.fetch ?? fetch;
    this.log = options.log ?? silentLogger;
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
    this.log.info('linear.token', { expiresIn: parsed.expires_in ?? null });
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

  /** The app user's own id in this workspace; also proves the credentials work. */
  async viewerId(): Promise<string> {
    const data = await this.graphql<{ viewer: { id: string } }>('query { viewer { id } }');
    return data.viewer.id;
  }

  /** The teams this app can see, archived excluded: the answer to "which id is PEC?".
   * A private team the app has not joined is simply not in this list. */
  async listTeams(): Promise<LinearTeam[]> {
    const data = await this.graphql<{ teams: { nodes: LinearTeam[] } }>('query { teams { nodes { id key name } } }');
    return data.teams.nodes;
  }

  async createActivity(input: AgentActivityInput): Promise<string> {
    const data = await this.graphql<{ agentActivityCreate: { success: boolean; agentActivity: { id: string } } }>(
      `mutation($input: AgentActivityCreateInput!) { agentActivityCreate(input: $input) { success agentActivity { id } } }`,
      { input },
    );
    if (!data.agentActivityCreate.success) throw new LinearApiError('agentActivityCreate was not successful', 200);
    return data.agentActivityCreate.agentActivity.id;
  }

  async issue(id: string): Promise<LinearIssue> {
    const data = await this.graphql<{ issue: RawIssue }>(`query($id: String!) { issue(id: $id) { ${ISSUE_FIELDS} } }`, {
      id,
    });
    return issueOf(data.issue);
  }

  async agentSession(id: string): Promise<LinearAgentSession> {
    const data = await this.graphql<{ agentSession: LinearAgentSession }>(
      `query($id: String!) { agentSession(id: $id) { id status issue { id } } }`,
      { id },
    );
    return data.agentSession;
  }

  /** Start an agent session on an issue without waiting to be delegated; the listener uses this. */
  async createSessionOnIssue(issueId: string): Promise<string> {
    const data = await this.graphql<{ agentSessionCreateOnIssue: { success: boolean; agentSession: { id: string } } }>(
      `mutation($input: AgentSessionCreateOnIssueInput!) { agentSessionCreateOnIssue(input: $input) { success agentSession { id } } }`,
      { input: { issueId } },
    );
    if (!data.agentSessionCreateOnIssue.success) throw new LinearApiError('agentSessionCreateOnIssue failed', 200);
    return data.agentSessionCreateOnIssue.agentSession.id;
  }

  /** Make (or unmake, with `null`) this app the issue's delegate; the human assignee stays. */
  async setDelegate(issueId: string, delegateId: string | null): Promise<void> {
    const data = await this.graphql<{ issueUpdate: { success: boolean } }>(
      `mutation($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`,
      { id: issueId, input: { delegateId } },
    );
    if (!data.issueUpdate.success) throw new LinearApiError('issueUpdate(delegateId) failed', 200);
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

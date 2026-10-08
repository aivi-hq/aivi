import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { GITHUB_APP_ID_ENV, GITHUB_PRIVATE_KEY_ENV, GitHubApp } from '@aivi/github';

/** A throwaway key, secret to nothing: what the tests prove is which bytes
 *  octokit signs and where they are sent. Every test that connects needs
 *  one, so it goes where the code looks for it, exactly as `<home>/.env`
 *  does. */
export const privateKey = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;

process.env[GITHUB_APP_ID_ENV] ??= '7';
process.env[GITHUB_PRIVATE_KEY_ENV] ??= privateKey;

/** A GitHub that only says what the test wrote. Nothing here reaches a
 *  network: a call nobody scripted is an error rather than a miss. */

/** One call as aivi's side saw it. */
export interface Seen {
  method: string;
  path: string;
  search: string;
  authorization?: string;
  body?: string;
}

/** What one route answers. */
export interface Answer {
  status: number;
  body: unknown;
}

export interface Scripted {
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  seen: Seen[];
  /** The calls so far, as `METHOD path`, in the order they arrived. */
  calls: () => string[];
  /** The calls whose path is `what`, bodies parsed where they are JSON. */
  bodies: (what: string) => any[];
}

const requestOf = (input: string | URL | Request, init?: RequestInit): Request | undefined =>
  typeof input === 'object' && !init?.method ? (input as Request) : undefined;

const bodyOf = async (request: Request | undefined, init?: RequestInit): Promise<string | undefined> =>
  request ? request.clone().text() : typeof init?.body === 'string' ? init.body : undefined;

async function readCall(input: string | URL | Request, init?: RequestInit): Promise<Seen> {
  const request = requestOf(input, init);
  const url = new URL(request?.url ?? String(input));
  const method = (request?.method ?? init?.method ?? 'GET').toUpperCase();
  const headers = new Headers(request?.headers ?? init?.headers);
  const authorization = headers.get('authorization') ?? undefined;
  const body = await bodyOf(request, init);
  return {
    method,
    path: url.pathname,
    search: url.search,
    ...(authorization ? { authorization } : {}),
    ...(body ? { body } : {}),
  };
}

export function scripted(routes: Record<string, (call: Seen) => Answer>): Scripted {
  const seen: Seen[] = [];
  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const call = await readCall(input, init);
    seen.push(call);
    const answer = routes[`${call.method} ${call.path}`];
    if (!answer) {
      // Status 400 on the throw: octokit's retry plugin backs off (seconds,
      // then tens of them) on anything it classifies as retryable, and a
      // test waiting on a backoff is a stuck test, not a proved one. A
      // sub-500 status says "this answer is final" — the message still
      // names the unasked-for call.
      const error = new Error(`unasked-for call: ${call.method} ${call.path}${call.search}`);
      (error as { status?: number }).status = 400;
      throw error;
    }
    const { status, body: payload } = answer(call);
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
  };
  return {
    fetch,
    seen,
    calls: () => seen.map(other => `${other.method} ${other.path}`),
    bodies: what =>
      seen
        .filter(other => other.path === what && other.body)
        .map(other => {
          try {
            return JSON.parse(other.body!);
          } catch {
            return other.body;
          }
        }),
  };
}

/** The routes that connect: one app, one installation, one account — the
 *  shape `GitHubApp.connect` reads, with the app slug the delegate name is
 *  drawn from. */
export function connectRoutes(extra: Record<string, (call: Seen) => Answer> = {}): Record<string, (c: Seen) => Answer> {
  return {
    'GET /app': () => ({ status: 200, body: { id: 7, slug: 'aivi-agent' } }),
    'GET /app/installations': () => ({ status: 200, body: [{ id: 9, account: { login: 'aivi-hq' } }] }),
    'POST /app/installations/9/access_tokens': () => ({
      status: 201,
      body: {
        token: 'ghs_test_token',
        expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        permissions: { issues: 'write' },
        repository_selection: 'all',
      },
    }),
    ...extra,
  };
}

/** One GraphQL route that answers by operation name: the queries are named,
 *  so a test scripts the answers and never matches query text. */
export function graphql(handlers: Record<string, (variables: any) => unknown>): (call: Seen) => Answer {
  return call => {
    const { query, variables } = JSON.parse(call.body ?? '{}');
    const name = /\b(?:query|mutation)\s+(\w+)/.exec(query)?.[1];
    const handler = name ? handlers[name] : undefined;
    if (!handler) {
      // Final answer, no backoff (see `scripted`): the name still says what
      // was asked without a script.
      const error = new Error(`unscripted GraphQL operation: ${name ?? query.slice(0, 60)}`);
      (error as { status?: number }).status = 400;
      throw error;
    }
    return { status: 200, body: { data: handler(variables) } };
  };
}

/** The app's own JWT claim, read back — the place a wrong app id shows up. */
export function jwtClaims(authorization: string | undefined): { iss: string } {
  assert.match(authorization ?? '', /^bearer ey/, 'the app authenticates its own JWT as a bearer token');
  const [, payload] = (authorization ?? '').slice('bearer '.length).split('.');
  const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as { iss: string | number };
  return { iss: String(claims.iss) };
}

// ——— builders for the canned answers ———

/** A GitHub `databaseId` is a global row id, not the repository-local number
 *  (the live ledger says so: a repo's 52nd issue carries a row id in the
 *  billions). Fakes keep the two apart so a read built from the wrong one
 *  fails here the way it fails live. */
const GLOBAL_ID_BASE = 5_745_231_600;

/** A board: Status options in board order and the `Agent` field named for
 *  the app (D5). Numbers are the org-level board numbers GitHub answers. */
export const BOARD = {
  projectId: 'PVT_board_1',
  number: 1,
  statusFieldId: 'PVTSSF_status',
  statusOptions: [
    { id: 'opt_backlog', name: 'Backlog' },
    { id: 'opt_todo', name: 'Todo' },
    { id: 'opt_prog', name: 'In Progress' },
    { id: 'opt_done', name: 'Done' },
  ],
  agentFieldId: 'PVTSSF_agent',
  agentOptions: [{ id: 'opt_aivi', name: 'aivi-agent' }],
};

export function boardFieldsAnswer(org: string, variables: any): unknown {
  if (variables.owner !== org || variables.number !== BOARD.number)
    throw new Error(`board ${variables.number} answers nothing for ${variables.owner}`);
  return {
    organization: {
      projectV2: {
        id: BOARD.projectId,
        fields: {
          nodes: [
            {
              id: BOARD.statusFieldId,
              name: 'Status',
              options: BOARD.statusOptions,
            },
            {
              id: BOARD.agentFieldId,
              name: 'Agent',
              options: BOARD.agentOptions,
            },
          ],
        },
      },
    },
  };
}

export interface IssueNodeOptions {
  number?: number;
  title?: string;
  body?: string | null;
  state?: 'OPEN' | 'CLOSED';
  stateReason?: string | null;
  labels?: string[];
  assignees?: string[];
  /** Status option name on board `boardNumber`; null = not on the board. */
  lane?: string | null;
  /** Agent option name; undefined = field empty. */
  agent?: string;
  boardNumber?: number;
  blockedBy?: { number: number; owner?: string; repo?: string; closed?: boolean }[];
}

export function issueNode(options: IssueNodeOptions = {}, owner = 'acme', repo = 'shop'): any {
  const number = options.number ?? 47;
  const lane = options.lane === undefined ? 'Todo' : options.lane;
  const values: any[] = [];
  if (lane !== null) {
    const option = BOARD.statusOptions.find(o => o.name === lane);
    values.push({ name: lane, optionId: option?.id ?? `opt_x_${lane}`, field: { name: 'Status' } });
  }
  if (options.agent) values.push({ name: options.agent, optionId: 'opt_aivi', field: { name: 'Agent' } });
  return {
    id: `I_${number}`,
    // The fake carries GitHub's real distinction: databaseId is a global row
    // id, nothing like the repository-local number. A read built from the
    // wrong one fails here, as it fails live.
    databaseId: GLOBAL_ID_BASE + number,
    number,
    title: options.title ?? 'Fix it',
    body: options.body === undefined ? 'please' : options.body,
    url: `https://github.com/${owner}/${repo}/issues/${number}`,
    state: options.state ?? 'OPEN',
    stateReason: options.stateReason ?? null,
    labels: { nodes: (options.labels ?? []).map((name, i) => ({ id: `L${i}`, name })) },
    assignees: { nodes: (options.assignees ?? []).map((login, i) => ({ id: `U${i}`, login })) },
    projectItems: {
      nodes:
        lane === null
          ? []
          : [
              {
                id: `PVTI_${number}`,
                project: { number: options.boardNumber ?? BOARD.number },
                fieldValues: { nodes: values },
              },
            ],
    },
    blockedBy: {
      nodes: (options.blockedBy ?? []).map(d => ({
        number: d.number,
        state: d.closed ? 'CLOSED' : 'OPEN',
        stateReason: d.closed ? 'COMPLETED' : null,
        repository: { owner: { login: d.owner ?? owner }, name: d.repo ?? repo },
      })),
    },
  };
}

/** A comment as the REST answers it. */
export function commentJson(
  id: number,
  login: string,
  type: 'User' | 'Bot',
  body: string,
  at = '2026-10-07T00:00:00Z',
): any {
  return { id, user: { login, type }, body, created_at: at, html_url: `https://github.com/x/issues/comments/${id}` };
}

/** Connect an app to the scripted GitHub with the transport's own retries
 *  off: a scripted failure must stand as the answer. Left on, octokit
 *  re-asks every 5xx with 1s/4s/9s backoff — minutes of waiting that read
 *  as a stuck test and prove nothing about aivi's own retry decisions. */
export async function connectApp(fetch: typeof globalThis.fetch): Promise<GitHubApp> {
  return GitHubApp.connect({ fetch, retry: { enabled: false } });
}

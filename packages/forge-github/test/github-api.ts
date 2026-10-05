import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { GITHUB_PRIVATE_KEY_ENV } from '../src/config.ts';

/** A throwaway key, generated here and secret to nothing: what the tests prove
 *  is which bytes octokit signs with and where they are sent, not that a key is
 *  hard to guess. Every test in this package that connects needs one, so it
 *  goes where the code looks for it, exactly as `<home>/.env` does. */
export const privateKey = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;

process.env[GITHUB_PRIVATE_KEY_ENV] = privateKey;

/** A GitHub that only says what the test wrote. Shared by this package's tests,
 *  and named so it is not a `*.test.ts` file — `node --test` never runs it.
 *
 *  Nothing here reaches a network: a call nobody scripted is an error rather
 *  than a miss, because an unasked-for request is exactly what a test about
 *  credentials is looking for.
 */

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
}

/** The Request object when octokit handed one over; undefined when it
 *  called the plain `fetch(url, init)` way. Both are accepted so the double
 *  stays true whatever the transport decides. */
const requestOf = (input: string | URL | Request, init?: RequestInit): Request | undefined =>
  typeof input === 'object' && !init?.method ? (input as Request) : undefined;

/** The body as text, from whichever shape carried it. */
const bodyOf = async (request: Request | undefined, init?: RequestInit): Promise<string | undefined> =>
  request ? request.clone().text() : typeof init?.body === 'string' ? init.body : undefined;

/** One call as aivi's side saw it, read from whatever octokit's transport
 *  handed over. */
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
    if (!answer) throw new Error(`unasked-for call: ${call.method} ${call.path}${call.search}`);
    const { status, body: payload } = answer(call);
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
  };
  return { fetch, seen, calls: () => seen.map(other => `${other.method} ${other.path}`) };
}

/** A fresh installation token, as GitHub hands one out: what it is, and when it
 *  stops being good. */
export function installationToken(sequence = 1): Answer {
  return {
    status: 201,
    body: {
      token: `ghs_token_${sequence}`,
      expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      permissions: { contents: 'write', pull_requests: 'write' },
      repository_selection: 'all',
    },
  };
}

/** The app's own JWT, with the claim that names it read back — the place a
 *  wrong app id shows up. */
export function jwtClaims(authorization: string | undefined): { iss: string } {
  assert.match(authorization ?? '', /^bearer ey/, 'the app authenticates its own JWT as a bearer token');
  const [, payload] = (authorization ?? '').slice('bearer '.length).split('.');
  const claims = JSON.parse(Buffer.from(payload ?? '', 'base64url').toString('utf8')) as { iss: string | number };
  return { iss: String(claims.iss) };
}

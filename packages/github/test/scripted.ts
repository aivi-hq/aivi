import { readCall, type Seen } from './read-call.ts';

export type { Seen };

/** What one route answers. */
export interface Answer {
  status: number;
  body: unknown;
  /** Response headers beyond content-type: the deprecation and sunset pair
   *  GitHub sends with a deprecated endpoint's answer. */
  headers?: Record<string, string>;
}

export interface Scripted {
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  seen: Seen[];
  /** The calls so far, as `METHOD path`, in the order they arrived. */
  calls: () => string[];
  /** The calls whose path is `what`, bodies parsed where they are JSON. */
  bodies: (what: string) => any[];
}

/** A GitHub that only says what the test wrote. Shared by every package whose
 *  tests script GitHub.
 *
 *  Nothing here reaches a network: a call nobody scripted is an error rather
 *  than a miss, because an unasked-for request is exactly what a test about
 *  credentials is looking for.
 */
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
    const { status, body: payload, headers } = answer(call);
    if (status === 204) return new Response(null, { status });
    return new Response(JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json', ...(headers ?? {}) },
    });
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

/** One call as aivi's side saw it, read from whatever octokit's transport handed
 *  over. Shared by every package whose tests script GitHub: a double that parses
 *  the transport one way here and another way there proves nothing about either. */

/** One call as aivi's side saw it. */
export interface Seen {
  method: string;
  path: string;
  search: string;
  authorization?: string;
  body?: string;
}

/** The Request object when octokit handed one over; undefined when it
 *  called the plain `fetch(url, init)` way. Both are accepted so the double
 *  stays true whatever the transport decides. */
const requestOf = (input: string | URL | Request, init?: RequestInit): Request | undefined =>
  typeof input === 'object' && !init?.method ? (input as Request) : undefined;

/** The body as text, from whichever shape carried it. */
const bodyOf = async (request: Request | undefined, init?: RequestInit): Promise<string | undefined> =>
  request ? request.clone().text() : typeof init?.body === 'string' ? init.body : undefined;

export async function readCall(input: string | URL | Request, init?: RequestInit): Promise<Seen> {
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

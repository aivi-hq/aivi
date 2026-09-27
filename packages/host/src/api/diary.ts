import { StringDecoder } from 'node:string_decoder';
import type { Logger } from '@aivi/core';
import type { Store } from '../store.ts';
import type { AppMiddleware } from './env.ts';

/** The diary's body cap: a delivery worth reading is small; a flood is kept
 *  as its first bytes plus the fact that it was a flood. */
export const MAX_DIARY_BODY = 8 * 1024;

/** Header names whose value is a credential. The diary records that they
 *  arrived, never what they said — an operator sees a token was sent. */
const CREDENTIAL_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie']);
const PRESENT = '[present]';

/**
 * The request diary: one store row per arriving request, mounted first in
 * the chain so whatever the chain later makes of it — a refused bearer, an
 * unknown path, a handler that threw — is still visible. That is exactly
 * what an installer watching for one platform delivery needs to see, and
 * what an operator audits afterwards.
 *
 * The body is read from a clone of the request, so the untouched stream
 * still reaches the route that verifies a signature over its bytes.
 */
export function requestDiary(store: Store, log: Logger): AppMiddleware {
  return async (c, next) => {
    const at = Date.now();
    const body = await diaryBody(c.req.raw);
    // A request whose response never arrived gets the 500 the error responder will hand out.
    let status = 500;
    try {
      await next();
      status = c.res.status;
    } finally {
      try {
        store.logRequest({
          at,
          method: c.req.method,
          path: c.req.path,
          status,
          ...body,
          headers: diaryHeaders(c.req.raw.headers),
        });
      } catch (error) {
        // The diary failing is news, never a lost request.
        log.warn('api.diary.failed', { path: c.req.path, error });
      }
    }
  };
}

/** The first MAX_DIARY_BODY bytes, read from a clone; a cap that cuts a
 *  UTF-8 character drops the incomplete tail instead of writing U+FFFD. */
async function diaryBody(raw: Request): Promise<{ body: string | null; truncated: boolean }> {
  let reader: ReadableStreamDefaultReader<Uint8Array>;
  try {
    const cloned = raw.clone().body;
    if (!cloned) return { body: null, truncated: false };
    reader = cloned.getReader();
  } catch {
    // No body to read, or none left to give: the diary loses the body, not the request.
    return { body: null, truncated: false };
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (bytes + value.length > MAX_DIARY_BODY) {
      truncated = true;
      const room = MAX_DIARY_BODY - bytes;
      if (room > 0) chunks.push(Buffer.from(value.subarray(0, room)));
      await reader.cancel();
      break;
    }
    chunks.push(Buffer.from(value));
    bytes += value.length;
  }
  if (!chunks.length) return { body: null, truncated: false };
  const decoder = new StringDecoder('utf8');
  const text = decoder.write(Buffer.concat(chunks));
  return { body: truncated ? text : `${text}${decoder.end()}`, truncated };
}

/** Every header name is recorded with its value; a credential header says
 *  only that it arrived. */
function diaryHeaders(headers: Headers): Record<string, string> {
  const seen: Record<string, string> = {};
  for (const [name, value] of headers) seen[name] = CREDENTIAL_HEADERS.has(name) ? PRESENT : value;
  return seen;
}

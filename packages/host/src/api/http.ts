import { zValidator } from '@hono/zod-validator';
import type { Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { ZodType } from 'zod';
import type { AppEnv, AppMiddleware } from './env.ts';

export const MAX_JOB_BODY = 64 * 1024;
export const MAX_PUBLIC_BODY = 1024 * 1024;

/**
 * A plain JSON response with the API's two standing headers. Fallbacks built
 * outside a route handler carry them directly; the wrapping middleware in
 * `createApp` sets them on every response that crosses the chain normally,
 * so a handler may simply `return c.json(...)`.
 */
export function respond(body: unknown, status: ContentfulStatusCode, extra: HeadersInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...extra },
  });
}

/** The request is not JSON at all: 415 before any body is read, as the API has always answered. */
export const requireJson: AppMiddleware = async (c, next) => {
  if (!c.req.header('content-type')?.startsWith('application/json')) return respond({ error: 'Expected JSON' }, 415);
  await next();
};

/** The body is larger than `max` bytes; refused while reading, never after buffering. */
export function capBody(max: number, message: string): AppMiddleware {
  return bodyLimit({ maxSize: max, onError: () => respond({ error: message }, 413) });
}

/** `path: message; path: message` — the issue summary the API has always returned. */
export function issuesOf(error: { issues: readonly { path: readonly unknown[]; message: string }[] }): string {
  return error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ');
}

/**
 * Body validation an endpoint owns: the schema is the endpoint's own choice,
 * the failure shape (`Invalid <label>: <issues>`) is the API's. A body that
 * is not parseable JSON reads as absent, so it answers as a failed
 * validation, never as a crash — also what the API has always done.
 */
export function zBody<S extends ZodType>(label: string, schema: S) {
  return zValidator('json', schema, result => {
    if (!result.success) return respond({ error: `Invalid ${label}: ${issuesOf(result.error)}` }, 400);
    return undefined;
  });
}

/** The parsed JSON body, or undefined when there was none; for endpoints with no schema. */
export async function looseJson(c: Context<AppEnv>): Promise<unknown> {
  return await c.req.json().catch(() => undefined);
}

/** The raw body up to `max` bytes, or null when larger; signatures are computed over bytes. */
export async function readCapped(stream: ReadableStream<Uint8Array> | null, max: number): Promise<Buffer | null> {
  if (!stream) return Buffer.alloc(0);
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.length;
    if (bytes > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

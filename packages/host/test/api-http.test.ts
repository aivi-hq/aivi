import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppEnv } from '../src/api/env.ts';
import { capBody, issuesOf, looseJson, readCapped, requireJson, respond, zBody } from '../src/api/http.ts';

test('API responses carry JSON and no-store headers alongside endpoint-specific headers', async () => {
  const response = respond({ error: 'try later' }, 429, { 'retry-after': '5' });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('content-type'), 'application/json');
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('retry-after'), '5');
  assert.deepEqual(await response.json(), { error: 'try later' });
});

test('issue summaries retain nested field paths, indexes and each validation message', () => {
  assert.equal(
    issuesOf({
      issues: [
        { path: ['jobs', 0, 'id'], message: 'Required' },
        { path: ['enabled'], message: 'Expected boolean' },
      ],
    }),
    'jobs.0.id: Required; enabled: Expected boolean',
  );
  assert.equal(issuesOf({ issues: [] }), '');
});

test('JSON routes reject missing or wrong content types before reaching their handlers', async () => {
  const app = new Hono<AppEnv>();
  app.use('/json', requireJson);
  app.post('/json', c => c.json({ accepted: true }));
  for (const headers of [{}, { 'content-type': 'text/plain' }]) {
    const response = await app.request('/json', { method: 'POST', headers });
    assert.equal(response.status, 415);
    assert.deepEqual(await response.json(), { error: 'Expected JSON' });
  }
  const response = await app.request('/json', {
    method: 'POST',
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: '{}',
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { accepted: true });
});

test('body validation passes parsed data and answers schema failures and malformed JSON with 400', async () => {
  const app = new Hono<AppEnv>();
  app.post('/item', zBody('item', z.strictObject({ count: z.number().int().positive() })), c =>
    c.json(c.req.valid('json')),
  );
  const post = (body: string) =>
    app.request('/item', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  const valid = await post('{"count":2}');
  assert.equal(valid.status, 200);
  assert.deepEqual(await valid.json(), { count: 2 });
  const invalid = await post('{"count":0}');
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /^Invalid item: count: /);
  assert.equal((await post('{broken')).status, 400);
});

test('loose JSON accepts arbitrary JSON and treats an invalid body as absent', async () => {
  const app = new Hono<AppEnv>();
  app.post('/loose', async c => c.json({ value: (await looseJson(c)) ?? null }));
  for (const [body, value] of [
    ['[1,true]', [1, true]],
    ['{"ok":true}', { ok: true }],
    ['{broken', null],
    ['', null],
  ] as const) {
    const response = await app.request('/loose', { method: 'POST', body });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { value });
  }
});

test('the body cap refuses oversized requests and allows a body exactly at the byte limit', async () => {
  const app = new Hono<AppEnv>();
  app.use('/capped', capBody(4, 'Body exceeds four bytes'));
  app.post('/capped', async c => c.text(await c.req.text()));
  const accepted = await app.request('/capped', { method: 'POST', body: 'four' });
  assert.equal(accepted.status, 200);
  assert.equal(await accepted.text(), 'four');
  const refused = await app.request('/capped', { method: 'POST', body: 'larger' });
  assert.equal(refused.status, 413);
  assert.deepEqual(await refused.json(), { error: 'Body exceeds four bytes' });
});

test('raw body reads concatenate exact bytes and accept absent and empty streams', async () => {
  assert.deepEqual(await readCapped(null, 0), Buffer.alloc(0));
  assert.deepEqual(
    await readCapped(new ReadableStream({ start: controller => controller.close() }), 0),
    Buffer.alloc(0),
  );
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([0, 255]));
      controller.enqueue(new Uint8Array([1, 2]));
      controller.close();
    },
  });
  assert.deepEqual(await readCapped(stream, 4), Buffer.from([0, 255, 1, 2]));
});

test('raw body reads cancel the producer as soon as cumulative bytes exceed the limit', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(Buffer.from('one'));
      controller.enqueue(Buffer.from('two'));
    },
    cancel() {
      cancelled = true;
    },
  });
  assert.equal(await readCapped(stream, 5), null);
  assert.equal(cancelled, true);
});

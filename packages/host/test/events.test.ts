import assert from 'node:assert/strict';
import { createServer, type ServerResponse } from 'node:http';
import { test } from 'node:test';
import { configSchema } from '@aivi/core';
import { EventStream, type SessionEvent } from '../src/events.ts';
import { connectOpenCode } from '../src/opencode.ts';

const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 300 && !check(); i++) await new Promise(r => setTimeout(r, 10));
  assert.ok(check(), what);
};

/** A tiny OpenCode whose only route is the SSE event stream the client requests as `GET /api/event`. */
async function fakeEvents(t: { after(fn: () => Promise<void> | void): void }) {
  const requests: string[] = [];
  const streams: ServerResponse[] = [];
  let refuse = false;
  const server = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    if (refuse) return void res.writeHead(503).end();
    if (req.url !== '/api/event') return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.write(`data: ${JSON.stringify({ type: 'server.connected', data: {} })}\n\n`);
    streams.push(res);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => {
    server.closeAllConnections();
    return new Promise<void>(resolve => server.close(() => resolve()));
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    emit: (event: SessionEvent) => streams.at(-1)!.write(`data: ${JSON.stringify(event)}\n\n`),
    end: () => streams.at(-1)!.end(),
    setRefuse: (value: boolean) => {
      refuse = value;
    },
  };
}

test('one event stream per host fans out by session, drops the unwatched, and reconnects after the stream ends', async t => {
  const server = await fakeEvents(t);
  const loaded = { config: configSchema.parse({ version: 1, opencode: { url: server.url } }) };
  const abort = new AbortController();
  t.after(() => abort.abort());
  let discoveries = 0;
  const events = new EventStream(
    () => {
      discoveries++;
      return connectOpenCode(loaded.config.opencode, {});
    },
    abort.signal,
    undefined,
    { baseMs: 20, maxMs: 50 },
  );
  assert.equal(server.requests.length, 0, 'nothing connects until someone watches');
  const a: string[] = [];
  const b: string[] = [];
  const unwatchA = events.watch('ses_a', e => a.push(e.type));
  events.watch('ses_a', e => a.push(`second:${e.type}`));
  events.watch('ses_b', e => b.push(e.type));
  await until(() => events.connections === 1, 'connected');
  assert.deepEqual(server.requests, ['GET /api/event']);
  server.emit({ type: 'session.tool.called', data: { sessionID: 'ses_a', id: 't', input: {} } });
  server.emit({ type: 'session.text.started', data: { sessionID: 'ses_c' } });
  server.emit({ type: 'session.step.started', data: { sessionID: 'ses_b' } });
  server.emit({ type: 'server.heartbeat' } as SessionEvent);
  await until(() => b.length === 1, 'b delivered');
  assert.deepEqual(a, ['session.tool.called', 'second:session.tool.called']);
  assert.deepEqual(b, ['session.step.started']);
  unwatchA();
  server.emit({ type: 'session.tool.success', data: { sessionID: 'ses_a', id: 't' } });
  server.emit({ type: 'session.text.ended', data: { sessionID: 'ses_b' } });
  await until(() => b.length === 2, 'b again');
  assert.deepEqual(a, ['session.tool.called', 'second:session.tool.called', 'second:session.tool.success']);

  // The server ends the stream (a restart): the client is rediscovered and the stream reopened with backoff.
  server.setRefuse(true);
  server.end();
  await until(() => server.requests.length >= 3, 'retries while the service is away');
  server.setRefuse(false);
  await until(() => events.connections === 2, 'reconnected');
  assert.ok(discoveries >= 3, `rediscovers the client on every attempt (${discoveries})`);
  server.emit({ type: 'session.execution.succeeded', data: { sessionID: 'ses_b' } });
  await until(() => b.length === 3, 'events flow again');

  abort.abort();
  await new Promise(r => setTimeout(r, 60));
  const seen = server.requests.length;
  await new Promise(r => setTimeout(r, 120));
  assert.equal(server.requests.length, seen, 'the host signal ends the loop');
  assert.equal(typeof events.watch('ses_z', () => {}), 'function', 'watching after stop is harmless');
});

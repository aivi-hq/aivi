/** The host's event stream as a unit, over a client whose `event.subscribe` is a
 *  script the test holds: how one failing listener is told and skipped, what a
 *  watched session remembers, and a stop that arrives while the stream waits
 *  to reconnect. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { OpenCodeClient, SessionEvent } from '@aivi/plugin/module';
import { EventStream } from '../src/events.ts';
import { recorder } from './support.ts';

const event = (sessionID: string, type = 'session.step.started') => ({ type, data: { sessionID } }) as SessionEvent;

/** A client whose stream says `events` once and then stays open until the host signal ends it. */
const streaming = (events: SessionEvent[]) =>
  ({
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) =>
        (async function* () {
          yield* events;
          await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
        })(),
    },
  }) as unknown as OpenCodeClient;

test('a listener that throws is told to the log and does not keep the others from the event', async t => {
  const { log, said, next } = recorder();
  const abort = new AbortController();
  t.after(() => abort.abort());
  const events = new EventStream(async () => streaming([event('ses_a')]), abort.signal, log);
  const failure = new Error('listener bug');
  events.watch('ses_a', () => {
    throw failure;
  });
  const heard = Promise.withResolvers<string>();
  events.watch('ses_a', e => heard.resolve(e.type));
  assert.equal(await heard.promise, 'session.step.started', 'the second listener still got the event');
  assert.equal((await next('events.listener.failed')).error, failure);
  assert.deepEqual(
    said('warn').map(line => line.event),
    ['events.listener.failed'],
  );
});

test('a session whose last listener left is forgotten, and delivered to again when it is watched anew', async t => {
  const abort = new AbortController();
  t.after(() => abort.abort());
  const feed = Promise.withResolvers<SessionEvent>();
  const stream = {
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) =>
        (async function* () {
          yield event('ses_a', 'first');
          yield await feed.promise;
          await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
        })(),
    },
  } as unknown as OpenCodeClient;
  const events = new EventStream(async () => stream, abort.signal, recorder().log);
  const heard: string[] = [];
  const first = Promise.withResolvers<void>();
  const unwatch = events.watch('ses_a', e => {
    heard.push(`early:${e.type}`);
    first.resolve();
    unwatch();
  });
  await first.promise;
  const later = Promise.withResolvers<void>();
  events.watch('ses_a', e => {
    heard.push(`late:${e.type}`);
    later.resolve();
  });
  feed.resolve(event('ses_a', 'second'));
  await later.promise;
  assert.deepEqual(heard, ['early:first', 'late:second']);
});

test('a host that stops while the stream waits to reconnect ends the wait, and nothing is tried again', async t => {
  const { log, next } = recorder();
  const abort = new AbortController();
  let attempts = 0;
  const events = new EventStream(
    async () => {
      attempts++;
      throw new Error('No running OpenCode v2 service found');
    },
    abort.signal,
    log,
    { baseMs: 600_000, maxMs: 600_000 },
  );
  t.after(() => abort.abort());
  events.watch('ses_a', () => {});
  const failed = await next('events.connect.failed');
  assert.equal(failed.retryMs, 600_000, 'it was backing off for ten minutes');
  abort.abort();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(attempts, 1, 'the stop ended the wait instead of the wait ending in a new attempt');
  assert.equal(events.connections, 0);
});

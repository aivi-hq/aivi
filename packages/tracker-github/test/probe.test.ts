/** The diary waits of the probe, in mock time. The installer is a second
 *  process: it proves a webhook by re-reading what the live aivi recorded, on
 *  a quiet interval, until what it asked for landed or the window closed.
 *  Every delivery is checked against the secret's seal before it counts. */
import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import type { RequestLogEntry } from '@aivi/core';
import { webhookSignature } from '@aivi/github';
import { setupDiary } from '../../plugin/test/setup-fixture.ts';
import { aboutIssue, waitDiary, waitForSignals } from '../src/probe.ts';
import { GITHUB_WEBHOOK_PATH } from '../src/tracker.ts';

const SECRET = 'probe-secret';
/** The diary's quiet re-read interval; a window shorter than it ends before the first re-read. */
const POLL_MS = 2_000;
const BEFORE_FIRST_POLL_MS = 1_500;
const LONG_WINDOW_MS = 90_000;
const BAD_SEAL = /bad signature \(HTTP 200\)/;

const delivery = (
  id: number,
  event: string,
  payload: unknown,
  extra: Partial<RequestLogEntry> = {},
): RequestLogEntry => {
  const body = JSON.stringify(payload);
  return {
    id,
    at: 0,
    method: 'POST',
    path: GITHUB_WEBHOOK_PATH,
    status: 200,
    body,
    truncated: false,
    headers: { 'x-github-event': event, 'x-hub-signature-256': webhookSignature(SECRET, Buffer.from(body)) },
    ...extra,
  };
};
const forged = (row: RequestLogEntry): RequestLogEntry => ({
  ...row,
  headers: { ...row.headers, 'x-hub-signature-256': 'sha256=forged' },
});

const ours = { issue: { number: 9 }, repository: { full_name: 'acme/shop' } };
const opened = (id: number) => delivery(id, 'issues', { action: 'opened', ...ours });
const commented = (id: number) => delivery(id, 'issue_comment', { action: 'created', ...ours });

function begin(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const diary = setupDiary(t);
  const say = t.mock.fn((_line: string) => {});
  return { ...diary, say, said: () => say.mock.calls.map(call => call.arguments[0]) };
}

const installation = (windowMs: number) => ({
  path: GITHUB_WEBHOOK_PATH,
  secret: SECRET,
  windowMs,
  accepts: (event: string) => event === 'installation',
  about: () => true,
});

const board = (asked: string[], windowMs: number) => ({
  path: GITHUB_WEBHOOK_PATH,
  secret: SECRET,
  windowMs,
  asked,
  about: aboutIssue('acme/shop', 9, 'I_9'),
});

test('the installation wait hears a delivery that lands between polls at the next poll, and ends there', async t => {
  const { rows, store, say, said } = begin(t);
  const waiting = waitDiary(store, installation(LONG_WINDOW_MS), 0, say);
  rows.push(delivery(1, 'installation', { action: 'created' }));
  t.mock.timers.tick(POLL_MS);
  assert.deepEqual(await waiting, { mine: 1, others: 0, last: 1 });
  assert.deepEqual(said(), ['Heard: installation created on something the payload did not name']);
});

test('a delivery that fails its seal at a later poll ends the installation wait with the secret remedy', async t => {
  const { rows, store, say, said } = begin(t);
  const waiting = waitDiary(store, installation(LONG_WINDOW_MS), 0, say);
  rows.push(forged(delivery(1, 'installation', { action: 'created' })));
  t.mock.timers.tick(POLL_MS);
  await assert.rejects(waiting, BAD_SEAL);
  assert.deepEqual(said(), [], 'a delivery that failed its seal is not heard');
});

test('a delivery that lands after the last poll is still read when the installation window closes', async t => {
  const { rows, store, say } = begin(t);
  const waiting = waitDiary(store, installation(BEFORE_FIRST_POLL_MS), 0, say);
  rows.push(delivery(1, 'installation', { action: 'created' }));
  t.mock.timers.tick(BEFORE_FIRST_POLL_MS);
  assert.deepEqual(await waiting, { mine: 1, others: 0, last: 1 });
});

test('a forged delivery that lands after the last poll fails the installation wait at its close', async t => {
  const { rows, store, say } = begin(t);
  const waiting = waitDiary(store, installation(BEFORE_FIRST_POLL_MS), 0, say);
  rows.push(forged(delivery(1, 'installation', { action: 'created' })));
  t.mock.timers.tick(BEFORE_FIRST_POLL_MS);
  await assert.rejects(waiting, BAD_SEAL);
});

test('a delivery the diary kept no body for cannot pass the seal, and ends the installation wait', async t => {
  const { rows, store, say } = begin(t);
  rows.push(delivery(1, 'installation', { action: 'created' }, { body: null }));
  await assert.rejects(waitDiary(store, installation(LONG_WINDOW_MS), 0, say), BAD_SEAL);
});

test('a verified delivery that names little is still heard, for as much as it names', async t => {
  const named = 'something the payload did not name';
  await t.test('a payload that is JSON null', async t => {
    const { rows, store, say, said } = begin(t);
    rows.push(delivery(1, 'installation', null));
    assert.deepEqual(await waitDiary(store, installation(LONG_WINDOW_MS), 0, say), { mine: 1, others: 0, last: 1 });
    assert.deepEqual(said(), [`Heard: installation on ${named}`]);
  });
  await t.test('no body at all, when the seal vouches for the empty one', async t => {
    const { rows, store, say, said } = begin(t);
    const headers = {
      'x-github-event': 'installation',
      'x-hub-signature-256': webhookSignature(SECRET, Buffer.from('')),
    };
    rows.push(delivery(1, 'installation', {}, { body: null, headers }));
    assert.deepEqual(await waitDiary(store, installation(LONG_WINDOW_MS), 0, say), { mine: 1, others: 0, last: 1 });
    assert.deepEqual(said(), [`Heard: installation on ${named}`]);
  });
  await t.test('no event header: it names no event, and the window closes on it', async t => {
    const { rows, store, say, said } = begin(t);
    const body = JSON.stringify({ action: 'created' });
    const headers = { 'x-hub-signature-256': webhookSignature(SECRET, Buffer.from(body)) };
    rows.push(delivery(1, 'installation', { action: 'created' }, { headers }));
    const waiting = waitDiary(store, installation(BEFORE_FIRST_POLL_MS), 0, say);
    t.mock.timers.tick(BEFORE_FIRST_POLL_MS);
    assert.deepEqual(await waiting, { mine: 0, others: 0, last: 1 });
    assert.deepEqual(said(), [`Heard:  created on ${named}`]);
  });
});

test('a diary emptied behind the mark is followed from its new start, by both waits', async t => {
  await t.test('the installation wait', async t => {
    const { rows, store, say } = begin(t);
    rows.push(delivery(1, 'installation', { action: 'created' }));
    assert.deepEqual(await waitDiary(store, installation(LONG_WINDOW_MS), 50, say), { mine: 1, others: 0, last: 1 });
  });
  await t.test('the board wait', async t => {
    const { rows, store, say } = begin(t);
    rows.push(opened(1));
    const { landed, last } = await waitForSignals(store, board(['issue opened'], LONG_WINDOW_MS), 50, say);
    assert.deepEqual([...landed], ['issue opened']);
    assert.equal(last, 1);
  });
});

test('the board wait counts a signal at the poll it lands, keeps waiting for the rest, and ends with the last', async t => {
  const { rows, store, say, said } = begin(t);
  const waiting = waitForSignals(store, board(['issue opened', 'comment posted'], LONG_WINDOW_MS), 0, say);
  rows.push(opened(1));
  t.mock.timers.tick(POLL_MS);
  rows.push(commented(2));
  t.mock.timers.tick(POLL_MS);
  const { landed, last } = await waiting;
  assert.deepEqual([...landed], ['issue opened', 'comment posted']);
  assert.equal(last, 2);
  assert.deepEqual(said(), ['Heard: issues opened on acme/shop#9', 'Heard: issue_comment created on acme/shop#9']);
});

test('a delivery about the probe that fails its seal at a later poll ends the board wait', async t => {
  const { rows, store, say } = begin(t);
  const waiting = waitForSignals(store, board(['issue opened'], LONG_WINDOW_MS), 0, say);
  rows.push(forged(opened(1)));
  t.mock.timers.tick(POLL_MS);
  await assert.rejects(waiting, BAD_SEAL);
});

test('the board wait reads once more when its window closes', async t => {
  await t.test('a signal that landed after the last poll still counts', async t => {
    const { rows, store, say } = begin(t);
    const waiting = waitForSignals(store, board(['issue opened'], BEFORE_FIRST_POLL_MS), 0, say);
    rows.push(opened(1));
    t.mock.timers.tick(BEFORE_FIRST_POLL_MS);
    assert.deepEqual([...(await waiting).landed], ['issue opened']);
  });
  await t.test('a forged delivery that landed after the last poll fails the wait', async t => {
    const { rows, store, say } = begin(t);
    const waiting = waitForSignals(store, board(['issue opened'], BEFORE_FIRST_POLL_MS), 0, say);
    rows.push(forged(opened(1)));
    t.mock.timers.tick(BEFORE_FIRST_POLL_MS);
    await assert.rejects(waiting, BAD_SEAL);
  });
});

test('the board wait passes over what is not about the probe: cut bodies, junk, other issues', async t => {
  const { rows, store, say, said } = begin(t);
  // The newest rows are read first, so the probe's own delivery sits below all of these.
  rows.push(
    opened(1),
    delivery(2, 'issues', {}, { truncated: true, body: '{"issue": {"number": 9, "title": "a cut deliv' }),
    delivery(3, 'issues', {}, { body: null }), // a post that carried no body
    delivery(4, 'issues', {}, { headers: {} }), // a post that names no event
    delivery(5, 'issues', { action: 'opened', issue: { number: 10 }, repository: { full_name: 'acme/shop' } }),
    delivery(6, 'projects_v2_item', { projects_v2_item: { content_node_id: 'I_9' } }), // names no action
  );
  const { landed } = await waitForSignals(store, board(['issue opened'], LONG_WINDOW_MS), 0, say);
  assert.deepEqual([...landed], ['issue opened']);
  assert.deepEqual(said(), [
    'Heard: projects_v2_item on something the payload did not name',
    'Heard: issues opened on acme/shop#9',
  ]);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import setup from '../src/setup.ts';
import { signWebhook } from '../src/webhook.ts';
import { issue, setupWizard as wizard } from './setup-fixture.ts';

test('truncated, invalidly signed and non-JSON deliveries fail setup without losing the owned test issue', async t => {
  for (const [extra, expected] of [
    [{ truncated: true }, /diary cut it off/],
    [{ headers: {} }, /missing Linear-Signature/],
    [{ headers: { 'linear-signature': '00' } }, /signature mismatch/],
    [
      { body: '{broken', headers: { 'linear-signature': signWebhook('{broken', 'signing-secret') } },
      /body is not JSON/,
    ],
    [{ body: null, headers: { 'linear-signature': signWebhook('', 'signing-secret') } }, /body is not JSON/],
  ] as const)
    await t.test(expected.source, async t => {
      const h = wizard(t);
      h.createIssue.mock.mockImplementation(async () => {
        h.append({ type: 'Issue', action: 'create', data: issue }, extra);
        return issue;
      });
      await assert.rejects(setup(h.ctx), expected);
      assert.equal(h.spinners[0]!.cancel.mock.callCount(), 1);
      assert.equal(h.archive.mock.callCount(), 1, 'a failed verification must still archive its temporary issue');
      assert.equal(h.configWrites.mock.callCount(), 0);
      assert.equal(h.secretWrites.mock.callCount(), 0);
    });
});

test('delegation errors still archive the test issue and do not write configuration', async t => {
  const h = wizard(t);
  const failure = new Error('delegation denied');
  h.delegate.mock.mockImplementation(async () => {
    throw failure;
  });
  await assert.rejects(setup(h.ctx), failure);
  assert.equal(h.spinners[1]!.cancel.mock.callCount(), 1);
  assert.equal(h.archive.mock.callCount(), 1);
  assert.equal(h.configWrites.mock.callCount(), 0);
});

test('store-read failures from a poll or the deadline settle the progress line and archive the issue', async t => {
  for (const phase of ['poll', 'deadline'])
    await t.test(phase, async t => {
      const h = wizard(t);
      h.createIssue.mock.mockImplementation(async () => issue);
      const pending = setup(h.ctx);
      await h.watching[0].promise;
      if (phase === 'deadline') t.mock.timers.tick(8999);
      const failure = new Error('diary read failed');
      h.diary.requests.mock.mockImplementation(() => {
        throw failure;
      });
      t.mock.timers.tick(phase === 'poll' ? 2000 : 1);
      await assert.rejects(pending, failure);
      assert.equal(h.spinners[0]!.cancel.mock.callCount(), 1);
      assert.equal(h.archive.mock.callCount(), 1);
      assert.equal(h.secretWrites.mock.callCount(), 0);
    });
});

test('an archive failure is reported without replacing the original probe failure', async t => {
  const h = wizard(t);
  const failure = new Error('delegation denied');
  h.delegate.mock.mockImplementation(async () => {
    throw failure;
  });
  h.archive.mock.mockImplementation(async () => {
    throw new Error('archive denied');
  });
  await assert.rejects(setup(h.ctx), failure);
  assert.ok(h.log.mock.calls.some(call => call.arguments[0].includes('delete it by hand (archive denied)')));
  assert.equal(h.secretWrites.mock.callCount(), 0);
});

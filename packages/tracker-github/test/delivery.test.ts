/**
 * What the assistant's delivery decides, called directly: an answer lands as a
 * comment and the ticket's marks swap, a placeholder is a progress comment,
 * an edit and a delete go to a comment by its id, and a conversation that
 * names no ticket has nothing to touch. GitHub is a fake client of
 * `mock.fn()` calls and the platform's I/O is answered here; its
 * conversation words (`ticketOf`) stay its own.
 */
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import type { LoadedConfig } from '@aivi/core';
import { recorder } from '../../host/test/support.ts';
import type { GithubClient } from '../src/client.ts';
import { githubDelivery } from '../src/delivery.ts';
import { GITHUB_FEED, GithubPlatform } from '../src/tracker.ts';

const TICKET = 'github:acme/shop#47';

function deliveryOver() {
  const lines = recorder();
  const client = {
    addReaction: mock.fn(async (..._reaction: unknown[]) => {}),
    removeOwnReaction: mock.fn(async (..._reaction: unknown[]) => {}),
    updateComment: mock.fn(async (..._edit: unknown[]) => {}),
    deleteComment: mock.fn(async (..._removal: unknown[]) => {}),
  };
  const tracker = new GithubPlatform({} as LoadedConfig, client as unknown as GithubClient, 'secret', lines.log);
  const comment = mock.method(tracker, 'comment', async (..._said: unknown[]) => '55');
  return { delivery: githubDelivery(tracker, lines.log), client, comment, lines };
}

test('an answer lands as a comment, and the ticket’s marks swap the eyes for the rocket', async () => {
  const { delivery, client, comment } = deliveryOver();
  assert.equal(await delivery.send(TICKET, 'The fix is in.'), '55');
  assert.deepEqual(comment.mock.calls[0]!.arguments, [TICKET, 'The fix is in.', 'answer']);
  assert.deepEqual(client.addReaction.mock.calls[0]!.arguments, ['acme/shop#47', 'rocket']);
  assert.deepEqual(client.removeOwnReaction.mock.calls[0]!.arguments, ['acme/shop#47', 'eyes']);
});

test('a mark GitHub refuses is logged and never costs the answer; a run’s conversation has no marks to swap', async () => {
  const { delivery, client, lines } = deliveryOver();
  for (const reaction of [client.addReaction, client.removeOwnReaction])
    reaction.mock.mockImplementationOnce(async () => {
      throw new Error('403');
    });
  assert.equal(await delivery.send(TICKET, 'ok'), '55');
  assert.deepEqual(
    lines.said('warn').map(line => line.event),
    ['reaction.failed', 'reaction.failed'],
  );
  client.addReaction.mock.resetCalls();
  client.removeOwnReaction.mock.resetCalls();
  assert.equal(await delivery.send(`${TICKET}:c1234`, 'ok'), '55', 'the comment still lands');
  assert.equal(client.addReaction.mock.callCount() + client.removeOwnReaction.mock.callCount(), 0);
});

test('the placeholder is a progress comment, an edit and a delete go to the comment by its id, a notice is an outcome', async () => {
  const { delivery, client, comment } = deliveryOver();
  assert.equal(await delivery.placeholder!(TICKET, 'working…'), '55');
  assert.deepEqual(comment.mock.calls[0]!.arguments, [TICKET, 'working…', 'progress']);
  await delivery.edit!(TICKET, '55', 'still working…');
  assert.deepEqual(client.updateComment.mock.calls[0]!.arguments, ['acme/shop#47', 55, 'still working…']);
  await delivery.delete!(TICKET, '55');
  assert.deepEqual(client.deleteComment.mock.calls[0]!.arguments, ['acme/shop#47', 55]);
  await delivery.notice!(TICKET, 'going offline');
  assert.deepEqual(comment.mock.calls[1]!.arguments, [TICKET, 'going offline', 'outcome']);
});

test('a conversation that names no ticket has no comment to edit or delete', async () => {
  const { delivery, client } = deliveryOver();
  await delivery.edit!(GITHUB_FEED, '55', 'x');
  await delivery.delete!(GITHUB_FEED, '55');
  assert.equal(client.updateComment.mock.callCount() + client.deleteComment.mock.callCount(), 0);
});

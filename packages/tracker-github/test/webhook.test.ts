import assert from 'node:assert/strict';
import { test } from 'node:test';
import { issueChanges } from '../src/tracker.ts';
import { DeliveryLedger, editedFieldName, isBotAuthor } from '../src/webhook.ts';

test('the ledger says fresh once: a redelivery by the same id lands as nothing', () => {
  const ledger = new DeliveryLedger(3);
  assert.equal(ledger.fresh('d1'), true);
  assert.equal(ledger.fresh('d1'), false, 'the same delivery id is never fresh twice');
  ledger.fresh('d2');
  ledger.fresh('d3');
  ledger.fresh('d4'); // capacity 3: d1 falls out of the window
  assert.equal(ledger.fresh('d1'), true, 'outside the window an old id is unseen — days of traffic, not forever');
});

test('the edited field is read however GitHub spelled the delivery', () => {
  assert.equal(editedFieldName({ field_name: 'Status' }), 'Status');
  assert.equal(editedFieldName({ field_value: { field_name: 'Agent' } }), 'Agent');
  assert.equal(editedFieldName({ field_value: { from: 'Todo', to: 'Done' } }), undefined);
  assert.equal(editedFieldName(undefined), undefined);
});

test('the actions that move routing, and the noise that does not', () => {
  assert.deepEqual(issueChanges('labeled'), ['labels']);
  assert.deepEqual(issueChanges('unlabeled'), ['labels']);
  assert.deepEqual(issueChanges('closed'), ['state']);
  assert.deepEqual(issueChanges('reopened'), ['state']);
  assert.deepEqual(issueChanges('deleted'), ['archive']);
  // An assignee is a person's word on GitHub, not the delegate (D5); an
  // edit changes nothing routing keys on.
  assert.deepEqual(issueChanges('assigned'), []);
  assert.deepEqual(issueChanges('unassigned'), []);
  assert.deepEqual(issueChanges('edited'), []);
});

test('a Bot author is filtered inbound, a person is not', () => {
  assert.equal(isBotAuthor({ type: 'Bot' }), true);
  assert.equal(isBotAuthor({ type: 'User' }), false);
  assert.equal(isBotAuthor(null), false);
  assert.equal(isBotAuthor(undefined), false);
});

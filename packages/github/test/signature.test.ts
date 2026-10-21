import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseWorker, signComment } from '../src/signature.ts';

test('a comment aivi posts closes with the worker role that wrote it, in text a person reads', () => {
  const posted = signComment('The header was missing. Fixed in the second commit.', 'review');
  assert.equal(posted, 'The header was missing. Fixed in the second commit.\n\n---\n\n_worker: aivi · review_');
});

test('the same bytes give the author fact back: one carrier for both readers', () => {
  assert.equal(parseWorker(signComment('Done.', 'review')), 'review');
  assert.equal(parseWorker(signComment('  Done with trailing space.  ', 'implement')), 'implement');
});

test('a comment aivi did not write names no worker', () => {
  assert.equal(parseWorker('Can you also cover the empty case?'), undefined);
  assert.equal(parseWorker(''), undefined);
  assert.equal(parseWorker('worker: review'), undefined);
  assert.equal(parseWorker('_worker: unterminated'), undefined);
});

test('a label quoted in the middle of someone’s reply is their text, not a fact', () => {
  // A reviewer replying to one of aivi's comments quotes the label. Reading the
  // body for the pattern anywhere would make that person's reply aivi's own.
  const quoted = ['You wrote:', '', '> _worker: aivi · review_', '', 'That is not enough. Please add a test.'].join(
    '\n',
  );
  assert.equal(parseWorker(quoted), undefined);
});

test('a label without aivi’s own name is still a label', () => {
  // The exact look is what the live gate judges; the reading does not insist on
  // the brand, so a shape written before it was agreed keeps naming its worker.
  assert.equal(parseWorker('Fixed.\n\n_worker: review_'), 'review');
});

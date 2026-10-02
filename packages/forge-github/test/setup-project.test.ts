/** What the clone contributor decides without asking a person or a network. The
 *  flow itself — the prompts, the clone landing on disk — is the live gate's;
 *  what is proved here is the name a repository suggests and the transport the
 *  clone goes through, both of which a wrong answer would put in a place a
 *  person has to clean up by hand.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PROJECT_ID } from '@aivi/core';
import { suggestedProjectId } from '../src/setup-project.ts';

test('a repository name becomes the project name a directory can take', () => {
  assert.equal(suggestedProjectId('widget'), 'widget');
  assert.equal(suggestedProjectId('My-Repo'), 'my-repo');
  assert.equal(suggestedProjectId('aivi.core'), 'aivi-core');
  assert.equal(suggestedProjectId('Under_score'), 'under_score');
});

test('and the suggestion is always a name aivi accepts, never one to be fixed later', () => {
  for (const named of ['widget', 'My-Repo', '123-numbers', '-leading', '_under', 'a b c', 're/po'])
    assert.ok(PROJECT_ID.test(suggestedProjectId(named)), `${named} suggests ${suggestedProjectId(named)}`);
  assert.equal(
    suggestedProjectId('123-numbers'),
    'p-123-numbers',
    'a name that no longer starts with a letter keeps one',
  );
});

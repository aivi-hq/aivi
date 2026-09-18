import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConfigurationError } from '../src/modules.ts';
import { TaskRegistry } from '../src/tasks.ts';

const handler = async () => ({ state: 'succeeded' as const, result: null });

test('an operation is claimed exactly once: a second owner is a configuration error', () => {
  const tasks = new TaskRegistry();
  tasks.claim('linear', 'linear.sweep', handler);
  assert.throws(() => tasks.claim('host', 'linear.sweep', handler), ConfigurationError);
  // The loser's message names the winner, so the clash is diagnosable from the error alone.
  assert.throws(() => tasks.claim('host', 'linear.sweep', handler), /already claimed by linear/);
  // The first claim stands; the failed claim did not replace it.
  assert.equal(tasks.get('linear.sweep'), handler);
});

test('the same owner re-claiming replaces its handler; release empties the name', () => {
  const tasks = new TaskRegistry();
  const other = async () => ({ state: 'succeeded' as const, result: null });
  tasks.claim('linear', 'linear.sweep', handler);
  tasks.claim('linear', 'linear.sweep', other);
  assert.equal(tasks.get('linear.sweep'), other, 'a restarted module re-registers itself');
  tasks.release('host', 'linear.sweep');
  assert.ok(tasks.get('linear.sweep'), 'only the owner can release');
  tasks.release('linear', 'linear.sweep');
  assert.equal(tasks.get('linear.sweep'), undefined);
});

test('a module sees a claims door with its own id baked in and cannot speak as another', () => {
  const tasks = new TaskRegistry();
  const linear = tasks.forModule('linear');
  linear.claim('linear.sweep', handler);
  assert.throws(() => tasks.forModule('discord').claim('linear.sweep', handler), ConfigurationError);
  // A release through the module door cannot empty a name owned elsewhere.
  tasks.claim('host', 'dreaming', handler);
  linear.release('dreaming');
  assert.ok(tasks.get('dreaming'));
  assert.deepEqual(tasks.claimed(), [
    { name: 'linear.sweep', owner: 'linear' },
    { name: 'dreaming', owner: 'host' },
  ]);
});

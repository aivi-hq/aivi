import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalize, scanWake, stripWake } from '../src/wake.ts';

test('wake normalization removes diacritics and collapses punctuation and whitespace', () => {
  assert.equal(normalize('  HÉY,\tAssístant!  '), 'hey assistant');
  assert.equal(normalize('!!!'), '');
});

test('wake scans skip empty phrases, require word boundaries and return the configured spelling', () => {
  assert.equal(scanWake('Hey, ASSISTANT! help', ['', '!!!', 'Héy Assistant']), 'Héy Assistant');
  assert.equal(scanWake('they assistantly agree', ['hey assistant']), null);
  assert.equal(scanWake('no address', []), null);
});

test('stripping removes one case-insensitive wake phrase and tidies the remaining sentence', () => {
  assert.equal(stripWake('  HEY   assistant , help me!  ', 'hey assistant'), ', help me!');
  assert.equal(stripWake('hey assistant help hey assistant', 'hey assistant'), 'help hey assistant');
  assert.equal(stripWake('  no address here  ', 'hey assistant'), 'no address here');
  assert.equal(
    stripWake('  HEY assistant  ', 'hey assistant'),
    'HEY assistant',
    'an empty remainder falls back to the original words',
  );
});

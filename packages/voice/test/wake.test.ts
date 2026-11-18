import assert from 'node:assert/strict';
import { test } from 'node:test';
import { normalize, scanWake } from '../src/wake.ts';

test('wake normalization removes diacritics and collapses punctuation and whitespace', () => {
  assert.equal(normalize('  HÉY,\tAssístant!  '), 'hey assistant');
  assert.equal(normalize('!!!'), '');
});

test('wake scans skip empty phrases, require word boundaries and return the configured spelling', () => {
  assert.equal(scanWake('Hey, ASSISTANT! help', ['', '!!!', 'Héy Assistant']), 'Héy Assistant');
  assert.equal(scanWake('they assistantly agree', ['hey assistant']), null);
  assert.equal(scanWake('no address', []), null);
});

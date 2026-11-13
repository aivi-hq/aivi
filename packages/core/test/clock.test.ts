import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatInstant, nextOccurrence, nextOccurrences, parseDue, parseDuration } from '../src/clock.ts';

const now = Date.parse('2026-09-15T07:00:00Z');

test('durations add units, ignoring surrounding whitespace and unit case', () => {
  assert.equal(parseDuration('1s'), 1000);
  assert.equal(parseDuration('2m'), 120_000);
  assert.equal(parseDuration('3h'), 10_800_000);
  assert.equal(parseDuration('4d'), 345_600_000);
  assert.equal(parseDuration(' \t1H  30M\n5s '), 5_405_000);
  assert.equal(parseDuration('0s'), 0);
});

test('empty, fractional, negative and natural-language durations are rejected', () => {
  for (const value of ['', ' \t\n', '1.5h', '-1m', '1h30m', '1 h', 'tomorrow', '1h later'])
    assert.throws(() => parseDuration(value), /Not a duration/, value);
});

test('relative due times must be later than now', () => {
  assert.equal(parseDue(' 2H ', now), now + 7_200_000);
  assert.equal(parseDue('30m', now), now + 1_800_000);
  assert.throws(() => parseDue('0s', now), /relative time must be in the future/);
});

test('absolute due times accept ISO dates and offsets, not invalid or past instants', () => {
  assert.equal(parseDue(' 2026-09-16 ', now), Date.parse('2026-09-16T00:00:00Z'));
  assert.equal(parseDue('2026-09-15T10:00:00+02:00', now), now + 3_600_000);
  for (const value of ['1', 'tomorrow', '2026-99-99T10:00:00Z'])
    assert.throws(() => parseDue(value, now), /Not a time/, value);
  for (const value of ['2026-09-14', '2026-09-15T07:00:00Z'])
    assert.throws(() => parseDue(value, now), /is in the past/, value);
});

test('cron previews start after the supplied instant and honor the requested count', () => {
  const pattern = '0 9 * * *';
  assert.equal(nextOccurrence(pattern, 'Europe/Amsterdam', now), Date.parse('2026-09-16T07:00:00Z'));
  assert.deepEqual(nextOccurrences(pattern, 'Europe/Amsterdam', now), [
    Date.parse('2026-09-16T07:00:00Z'),
    Date.parse('2026-09-17T07:00:00Z'),
    Date.parse('2026-09-18T07:00:00Z'),
  ]);
  assert.deepEqual(nextOccurrences(pattern, 'UTC', now, 1), [Date.parse('2026-09-15T09:00:00Z')]);
});

test('an exhausted schedule has no preview and cannot provide a next occurrence', () => {
  const pattern = '2026-01-01T00:00:00Z';
  assert.deepEqual(nextOccurrences(pattern, 'UTC', now), []);
  assert.throws(() => nextOccurrence(pattern, 'UTC', now), /Job has no future occurrence: 2026-01-01/);
});

test('job instants are rendered in the job timezone', () => {
  assert.equal(formatInstant(now, 'Europe/Amsterdam'), 'Sep 15, 2026, 9:00 AM');
  assert.equal(formatInstant(now, 'UTC'), 'Sep 15, 2026, 7:00 AM');
});

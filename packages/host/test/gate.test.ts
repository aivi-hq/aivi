import assert from 'node:assert/strict';
import { test } from 'node:test';
import { negotiate } from '../src/api/gate.ts';

// The rule over two version strings — fixed on both sides, because the
// server's real version moves with every release and the rule does not.

test('a client at or behind the host is served: minors the host gained are features it never touches', () => {
  assert.deepEqual(negotiate('0.6.0', '0.6.0'), { ok: true });
  assert.deepEqual(negotiate('0.6.99', '0.6.0'), { ok: true }, 'the patch is not a segment');
  assert.deepEqual(negotiate('0.1.0', '0.6.0'), { ok: true });
  assert.deepEqual(negotiate('1.4.0', '1.9.0'), { ok: true }, 'the rule is the same past 0.x');
});

test('a client ahead of its host is refused: features it expects may not answer', () => {
  assert.deepEqual(negotiate('0.7.0', '0.6.0'), {
    ok: false,
    code: 'server_version_too_low',
    minVersion: '0.7.0',
    error:
      'The aivi client 0.7.0 is newer than this host (0.6.0); features it expects may not answer here. Ask an operator to update aivi, or downgrade the client.',
  });
  const aheadMajor = negotiate('2.0.0', '1.9.9');
  assert.ok(!aheadMajor.ok);
  assert.equal(aheadMajor.code, 'server_version_too_low', 'a major ahead is refused alike');
  assert.equal(aheadMajor.minVersion, '2.0.0');
});

test('a different major is a broken contract, and silence names no version at all', () => {
  assert.deepEqual(negotiate('0.9.0', '1.0.0'), {
    ok: false,
    code: 'client_version_unsupported',
    minVersion: '1.0.0',
    error: 'The aivi client 0.9.0 speaks an older contract than this host (1.0.0). Run: aivi upgrade.',
  });
  assert.deepEqual(negotiate(undefined, '0.6.0'), {
    ok: false,
    code: 'client_version_unsupported',
    minVersion: '0.6.0',
    error: 'The aivi client does not name its version is older than this host (0.6.0). Run: aivi upgrade.',
  });
  const garbage = negotiate('weird', '0.6.0');
  assert.ok(!garbage.ok);
  assert.equal(garbage.code, 'client_version_unsupported');
});

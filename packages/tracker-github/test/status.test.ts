import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseStatus, renderStatus } from '../src/tracker.ts';

test('a status body round-trips its head, plan and hidden state', () => {
  const body = renderStatus('**Working** · reading src/x.ts', ['- [x] Read the issue', '- [ ] Fix it'], {
    kind: 'status',
  });
  const parsed = parseStatus(body);
  assert.equal(parsed.head, '**Working** · reading src/x.ts');
  assert.deepEqual(parsed.planLines, ['- [x] Read the issue', '- [ ] Fix it']);
  assert.deepEqual(parsed.meta, { kind: 'status' });
});

test('a body with no hidden line still reads, as a standing status', () => {
  const parsed = parseStatus('**Working** · thinking…\n');
  assert.equal(parsed.head, '**Working** · thinking…');
  assert.deepEqual(parsed.planLines, []);
  assert.deepEqual(parsed.meta, { kind: 'status' });
});

test('a person breaking the JSON never loses the words: the state falls back', () => {
  const parsed = parseStatus('**Working** · thinking…\n\n<!-- {broken json -->');
  assert.equal(parsed.head, '**Working** · thinking…');
  assert.deepEqual(parsed.meta, { kind: 'status' });
});

test('a plan section survives every edit around it, and only its lines are kept', () => {
  const body = [
    '**Working** · editing y.ts',
    '',
    '### Plan',
    '- [x] one',
    '- [ ] two',
    'notes ignored',
    '',
    '<!-- {"kind":"status"} -->',
  ].join('\n');
  const parsed = parseStatus(body);
  assert.deepEqual(parsed.planLines, ['- [x] one', '- [ ] two']);
  const again = renderStatus('**Working** · testing', parsed.planLines, parsed.meta);
  assert.match(again, /### Plan\n- \[x\] one\n- \[ \] two/);
});

test('the closing marks carry their tie: kind closing names the status comment', () => {
  const parsed = parseStatus(renderStatus('All done.', [], { kind: 'closing', status: 987, ok: true }));
  assert.deepEqual(parsed.meta, { kind: 'closing', status: 987, ok: true });
});

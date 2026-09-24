import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatTimestamp, type OutputBlock, print, renderOutput } from '../src/output.ts';

const plain = { colors: false };
const render = (blocks: OutputBlock[]) => renderOutput(blocks, plain);

test('log lines are prefixed two spaces per indent unit', () => {
  assert.equal(render([{ type: 'log', text: 'a' }]), 'a');
  assert.equal(render([{ type: 'log', text: 'a', indent: 2 }]), '    a');
});

test('dividers collapse and leading and trailing ones are dropped', () => {
  const log = (text: string): OutputBlock => ({ type: 'log', text });
  const divider: OutputBlock = { type: 'divider' };
  assert.equal(render([divider, log('a'), divider, divider, log('b'), divider]), 'a\n\nb');
});

test('table columns pad to the widest cell, lines trim and the whole row indents', () => {
  const out = render([
    {
      type: 'table',
      columns: ['ID', 'STATE'],
      rows: [
        ['a', 'active'],
        ['long-id', 'paused'],
      ],
      indent: 1,
    },
  ]);
  assert.deepEqual(out.split('\n'), ['  ID       STATE', '  a        active', '  long-id  paused']);
});

test('cell width is measured without styling codes', () => {
  const styled = '\u001b[31mred\u001b[39m';
  const out = render([
    {
      type: 'table',
      rows: [
        [styled, 'x'],
        ['longer', 'y'],
      ],
    },
  ]);
  const [first, second] = out.split('\n');
  assert.equal(first, `${styled}     x`);
  assert.equal(second, 'longer  y');
});

test('a table without columns is rows only, an empty one renders nothing', () => {
  assert.equal(render([{ type: 'table', rows: [['a', 'b']] }]), 'a  b');
  assert.equal(render([{ type: 'table', rows: [] }]), '');
});

test('headings and table headers are bold only when colors are on', () => {
  assert.equal(render([{ type: 'heading', text: 'Jobs' }]), 'Jobs');
  assert.ok(renderOutput([{ type: 'heading', text: 'Jobs' }], { colors: true }).includes('\u001b[1m'));
});

test('json is raw JSON, the same bytes a pipe gets, and never colored', () => {
  const value = { a: [1, 2], b: 'x' };
  assert.equal(renderOutput([{ type: 'json', value }], { colors: true }), JSON.stringify(value, null, 2));
});

test('pretty is inspect output, colored only when colors are on', () => {
  assert.equal(render([{ type: 'pretty', value: { a: 1 } }]), '{ a: 1 }');
  assert.ok(renderOutput([{ type: 'pretty', value: { a: 1 } }], { colors: true }).includes('\u001b[33m'));
});

test('formatTimestamp answers N/A when there is no timestamp', () => {
  assert.equal(formatTimestamp(null), 'N/A');
  assert.equal(formatTimestamp(undefined), 'N/A');
  assert.equal(formatTimestamp(''), 'N/A');
});

test('formatTimestamp takes ISO strings and epoch milliseconds, and passes non-dates through', () => {
  assert.notEqual(formatTimestamp('2026-09-24T10:00:00.000Z'), 'N/A');
  assert.equal(formatTimestamp(Date.UTC(2026, 8, 24, 10)), formatTimestamp('2026-09-24T10:00:00.000Z'));
  assert.equal(formatTimestamp('not a date'), 'not a date');
});

/** One print call on a stdout faked to `isTTY`; console.log is captured, not written. */
const capturePrint = (tty: boolean, hasColors: boolean) => {
  const lines: string[] = [];
  const log = (line: string) => lines.push(line);
  const originalLog = console.log;
  console.log = log;
  const descriptors = [
    Object.getOwnPropertyDescriptor(process.stdout, 'isTTY'),
    Object.getOwnPropertyDescriptor(process.stdout, 'hasColors'),
  ];
  Object.defineProperty(process.stdout, 'isTTY', { value: tty, configurable: true });
  Object.defineProperty(process.stdout, 'hasColors', { value: hasColors ? () => true : undefined, configurable: true });
  return {
    print: print as (data: unknown, output?: OutputBlock[] | string) => void,
    lines,
    restore: () => {
      console.log = originalLog;
      const [ttyDescriptor, colorsDescriptor] = descriptors;
      if (ttyDescriptor) Object.defineProperty(process.stdout, 'isTTY', ttyDescriptor);
      else Reflect.deleteProperty(process.stdout, 'isTTY');
      if (colorsDescriptor) Object.defineProperty(process.stdout, 'hasColors', colorsDescriptor);
      else Reflect.deleteProperty(process.stdout, 'hasColors');
    },
  };
};

test('print writes data unchanged as JSON when stdout is not a terminal, ignoring output', () => {
  const capture = capturePrint(false, false);
  try {
    capture.print({ a: 1 }, [{ type: 'log', text: 'ignored' }]);
    assert.deepEqual(capture.lines, [JSON.stringify({ a: 1 }, null, 2)]);
  } finally {
    capture.restore();
  }
});

test('on a terminal an absent output falls back: pretty for an object, log for a string', () => {
  const capture = capturePrint(true, false);
  try {
    capture.print({ a: 1 });
    capture.print('hello');
    capture.print(1, 'from a string output');
    assert.deepEqual(capture.lines, ['{ a: 1 }', 'hello', 'from a string output']);
  } finally {
    capture.restore();
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSelection } from '../src/api/selection.ts';

const parse = (query: string, extra: string[] = []) => parseSelection(new URLSearchParams(query), extra);

test('source selection defaults to all visible sources including core', () => {
  assert.deepEqual(parse(''), { ok: true, value: { includeCore: true } });
  assert.deepEqual(parse('includeCore=true&coreOnly=false'), { ok: true, value: { includeCore: true } });
});

test('project and kind selections preserve repeated values and can omit core', () => {
  assert.deepEqual(parse('project=one&project=two&kind=doc&kind=decision&includeCore=false'), {
    ok: true,
    value: { projects: ['one', 'two'], includeCore: false, kinds: ['doc', 'decision'] },
  });
  assert.deepEqual(parse('kind=memory'), { ok: true, value: { includeCore: true, kinds: ['memory'] } });
});

test('core-only selection is explicit and cannot be combined with projects', () => {
  assert.deepEqual(parse('coreOnly=true'), { ok: true, value: { projects: [], includeCore: true } });
  assert.deepEqual(parse('coreOnly=true&project=one'), { ok: false, error: 'Choose projects or coreOnly' });
});

test('unknown parameters and kinds fail, while endpoint-owned extra parameters are accepted', () => {
  assert.deepEqual(parse('unexpected=value'), { ok: false, error: 'Unknown parameter: unexpected' });
  assert.deepEqual(parse('q=words', ['q']), { ok: true, value: { includeCore: true } });
  assert.deepEqual(parse('kind=not-a-kind'), { ok: false, error: 'Unknown kind: not-a-kind' });
});

test('boolean query flags must say true or false, not a truthy spelling or an empty value', () => {
  for (const key of ['includeCore', 'coreOnly'])
    for (const value of ['', '1', 'TRUE', 'yes'])
      assert.deepEqual(parse(`${key}=${value}`), { ok: false, error: `Invalid ${key}` });
});

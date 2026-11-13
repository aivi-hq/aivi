import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { test } from 'node:test';

const root = new URL('../../../', import.meta.url);
const coverage = JSON.parse(readFileSync(new URL('.c8rc.json', root), 'utf8')) as {
  all: boolean;
  include: string[];
  exclude: string[];
};
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8')) as { scripts: Record<string, string> };

test('coverage includes untested production files, not the tests themselves', () => {
  assert.equal(coverage.all, true);
  assert.deepEqual(coverage.include, ['packages/*/src/**']);
  assert.doesNotMatch(
    pkg.scripts['test:cov']!,
    /--(?:include|exclude|all)\b/,
    'coverage scope has one owner: .c8rc.json',
  );
});

test('every excluded source file contains only erased types, never runtime code', () => {
  for (const path of coverage.exclude.filter(path => !['coverage/**', 'node_modules/**'].includes(path))) {
    assert.match(path, /^packages\/[^/]+\/src\//, `${path}: only type-only source files may be excluded`);
    assert.ok(!/[?*{}[\]]/.test(path), `${path}: source exclusions must name individual files`);
    const javascript = stripTypeScriptTypes(readFileSync(new URL(path, root), 'utf8'));
    const code = javascript
      .replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, '')
      .replace(/\bexport\s*\{\s*\}\s*;?/g, '')
      .trim();
    assert.equal(code, '', `${path}: runtime code must remain in coverage`);
  }
});

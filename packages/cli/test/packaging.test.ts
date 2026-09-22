import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const src = fileURLToPath(new URL('../src', import.meta.url));
const pkg = JSON.parse(readFileSync(fileURLToPath(new URL('../package.json', import.meta.url)), 'utf8')) as {
  dependencies: Record<string, string>;
};

const bareImports = (file: string): string[] =>
  [...readFileSync(file, 'utf8').matchAll(/from '([^'.][^']*)'/g)]
    .map(match => match[1]!)
    .filter(spec => !spec.startsWith('node:'));

test('the thin CLI stands alone: every import is a declared dependency', () => {
  // The published package has no workspace hoisting to lean on — `aivi help`
  // died in the wild when the banner reached for @aivi/core, which resolves
  // in the repo and nowhere else. This test is that release gate.
  const declared = new Set(Object.keys(pkg.dependencies));
  for (const file of readdirSync(src).filter(name => name.endsWith('.ts'))) {
    for (const spec of bareImports(join(src, file))) {
      const base = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!;
      assert.ok(declared.has(base), `${file} imports ${spec}; ${base} is not in @aivi/cli dependencies`);
    }
  }
});

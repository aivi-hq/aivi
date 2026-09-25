import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { aiviVersion } from '../src/version.ts';

const here = dirname(fileURLToPath(import.meta.url));

test('the version constant is the version of the API owner, @aivi/host', () => {
  const manifest = JSON.parse(readFileSync(join(here, '..', '..', 'host', 'package.json'), 'utf8')) as {
    version: string;
  };
  assert.equal(
    manifest.version,
    aiviVersion,
    '@aivi/host owns the wire API; bump packages/core/src/version.ts beside it',
  );
});

test('the thin CLI carries the same API version it must speak', () => {
  // @aivi/cli ships with no dependencies and copies the constant; drift would
  // be a 403 the operator cannot explain.
  const source = readFileSync(join(here, '..', '..', 'cli', 'src', 'api-version.ts'), 'utf8');
  const copy = /export const aiviVersion = '([^']+)'/.exec(source)?.[1];
  assert.equal(copy, aiviVersion, 'packages/cli/src/api-version.ts drifted from packages/core/src/version.ts');
});

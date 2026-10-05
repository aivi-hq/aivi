/** The bytes the setup writes, tested where they land: core's `.env` writer, the
 *  file, Node's own loader, and the reader that hands the key to octokit. A
 *  private key is many lines and the file is line-based, so the escaping is the
 *  thing that breaks in real life — hence testing the whole round trip rather
 *  than the function alone.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseEnv } from 'node:util';
import { upsertEnvFile } from '@aivi/core';
import { GITHUB_PRIVATE_KEY_ENV } from '../src/config.ts';
import { githubCredentials } from '../src/github.ts';
import { pemForEnvFile } from '../src/setup.ts';
import { privateKey } from './github-api.ts';

function envFile(body = ''): { path: () => string; read: () => string } {
  const path = join(mkdtempSync(join(tmpdir(), 'aivi-env-')), '.env');
  if (body) writeFileSync(path, body);
  return { path: () => path, read: () => readFileSync(path, 'utf8') };
}

test('a PEM written to <home>/.env is read back as the key it was', () => {
  const file = envFile('OPENCODE_PASSWORD=elsewhere\n');
  upsertEnvFile(file.path(), GITHUB_PRIVATE_KEY_ENV, pemForEnvFile(privateKey));

  // The file is one line per variable; the key is many. Node's loader is the
  // one the host's context runs (`process.loadEnvFile`), and `parseEnv` is the
  // parser underneath it, so this is the same read without editing the test
  // process's environment.
  const loaded = parseEnv(file.read());
  assert.equal(loaded.OPENCODE_PASSWORD, 'elsewhere', 'the neighbour’s secret is untouched');
  assert.equal(loaded[GITHUB_PRIVATE_KEY_ENV], privateKey.trim());
  assert.ok(
    file
      .read()
      .split('\n')
      .filter(line => line.startsWith(GITHUB_PRIVATE_KEY_ENV)).length === 1,
  );
});

test('and the bytes Node hands over are the bytes octokit signs with', () => {
  const file = envFile();
  upsertEnvFile(file.path(), GITHUB_PRIVATE_KEY_ENV, pemForEnvFile(privateKey));
  const loaded = parseEnv(file.read());
  // The key as read is PEM-shaped, so the credential reader takes it as it
  // stands — no second unescaping needed for the shape Node produces.
  assert.equal(githubCredentials({ app: 7 }, loaded).privateKey, privateKey.trim().replaceAll('\r', ''));
});

test('writing the key again replaces it, it does not append a second one', () => {
  const file = envFile();
  upsertEnvFile(file.path(), GITHUB_PRIVATE_KEY_ENV, pemForEnvFile(privateKey));
  upsertEnvFile(file.path(), GITHUB_PRIVATE_KEY_ENV, pemForEnvFile(`${privateKey}rotated`));
  const written = file
    .read()
    .split('\n')
    .filter(line => line.startsWith(GITHUB_PRIVATE_KEY_ENV));
  assert.equal(written.length, 1);
  assert.match(parseEnv(file.read())[GITHUB_PRIVATE_KEY_ENV] ?? '', /rotated/);
});

test('a PEM becomes one quoted line, which is all a line-based file can hold', () => {
  const file = envFile();
  upsertEnvFile(file.path(), GITHUB_PRIVATE_KEY_ENV, pemForEnvFile(privateKey));
  const key = pemForEnvFile(privateKey);
  assert.match(key, /^"-----BEGIN /, 'quoted, so the loader knows the value continues');
  assert.ok(!key.includes('\n'), 'one line, whatever the key holds');
});

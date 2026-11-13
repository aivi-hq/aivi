import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { collect, configPath, context, home, hostUrl, withStore } from '../src/cli/context.ts';
import { Store } from '../src/store.ts';

test('CLI context loads the real env file without replacing inherited values and brackets the store on success and failure', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aivi-cli-context-'));
  const keys = ['AIVI_HOME', 'AIVI_COVERAGE_INHERITED', 'AIVI_COVERAGE_FILE'];
  const saved = Object.fromEntries(Object.entries(process.env).filter(([key]) => keys.includes(key)));
  t.after(() => {
    for (const key of keys) delete process.env[key];
    Object.assign(process.env, saved);
    return rm(directory, { recursive: true, force: true });
  });
  process.env.AIVI_HOME = directory;
  process.env.AIVI_COVERAGE_INHERITED = 'from-process';
  delete process.env.AIVI_COVERAGE_FILE;
  await writeFile(join(directory, 'config.json'), '{"version":1}');
  await writeFile(join(directory, '.env'), 'AIVI_COVERAGE_INHERITED=from-file\nAIVI_COVERAGE_FILE=file-only\n');

  const ctx = await context();
  assert.equal(home(), directory);
  assert.equal(configPath(), join(directory, 'config.json'));
  assert.equal(ctx.loaded.path, configPath());
  assert.deepEqual(ctx.registry.entries, []);
  assert.deepEqual(new Set(ctx.protectedEnv), new Set(['AIVI_COVERAGE_INHERITED', 'AIVI_COVERAGE_FILE']));
  assert.equal(process.env.AIVI_COVERAGE_INHERITED, 'from-process');
  assert.equal(process.env.AIVI_COVERAGE_FILE, 'file-only');
  assert.equal(hostUrl(ctx.loaded), 'http://127.0.0.1:4100');

  const close = t.mock.method(Store.prototype, 'close');
  const person = await withStore(ctx.loaded, store => store.createPerson({ name: 'Ada' }));
  assert.equal(close.mock.callCount(), 1);
  const failure = new Error('callback failed');
  await assert.rejects(
    withStore(ctx.loaded, async () => {
      throw failure;
    }),
    failure,
  );
  assert.equal(close.mock.callCount(), 2, 'a rejected callback still closes SQLite');
  assert.deepEqual(await withStore(ctx.loaded, store => store.people()), [person]);
  assert.equal(close.mock.callCount(), 3);

  await rm(configPath());
  await assert.rejects(context(), /No config.json in/);
  delete process.env.AIVI_HOME;
  assert.equal(home(), resolve(homedir(), '.aivi'));
  assert.deepEqual(collect('two', collect('one', [])), ['one', 'two']);
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Store } from '@aivi/host';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

const run = (args: string[], env: NodeJS.ProcessEnv) =>
  spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env });

const scratch = async () => {
  const home = await mkdtemp(join(tmpdir(), 'aivi-create-'));
  const xdg = await mkdtemp(join(tmpdir(), 'aivi-config-'));
  return {
    home,
    xdg,
    env: { ...process.env, AIVI_HOME: home, XDG_CONFIG_HOME: xdg },
    cleanup: () => Promise.all([rm(home, { recursive: true, force: true }), rm(xdg, { recursive: true, force: true })]),
  };
};

test('server create initializes the home, mints the operator, and signs this machine in', async t => {
  const { home, xdg, env, cleanup } = await scratch();
  t.after(cleanup);
  const done = run(['server', 'create', '--use', 'this-machine', '--name', 'Nemo'], env);
  assert.equal(done.status, 0, done.stderr);
  const out = JSON.parse(done.stdout);
  assert.match(out.person, /^person-[0-9a-f]{8}$/);
  assert.match(out.token, /^aivi-[0-9a-f]{32}$/);
  assert.equal(out.url, 'http://127.0.0.1:4100');
  assert.equal(out.home, home);
  assert.match(out.next, /aivi setup/);
  assert.deepEqual(JSON.parse(await readFile(join(home, 'aivi.json'), 'utf8')), { version: 1 });
  const clientPath = join(xdg, 'aivi.json');
  const client = JSON.parse(await readFile(clientPath, 'utf8'));
  assert.deepEqual(client, { configVersion: 1, url: out.url, home, person: { token: out.token } });
  assert.equal((await stat(clientPath)).mode & 0o777, 0o600, 'the client config is 0600');
  const store = new Store(join(home, 'state', 'aivi.sqlite'));
  t.after(() => store.close());
  const [person] = store.people();
  assert.equal(person!.name, 'Nemo');
  assert.deepEqual(store.personForToken(out.token)!.person.id, person!.id);
  // A second create refuses: the home already has people, the token is never minted twice.
  const again = run(['server', 'create', '--use', 'this-machine'], env);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already has people/);
});

test('server create for another machine prints the token and writes no client config', async t => {
  const { home, xdg, env, cleanup } = await scratch();
  t.after(cleanup);
  const done = run(['server', 'create', '--use', 'another', '--name', 'Nemo'], env);
  assert.equal(done.status, 0, done.stderr);
  const out = JSON.parse(done.stdout);
  assert.match(out.next, /laptop/);
  assert.equal(out.clientConfig, undefined);
  assert.equal(existsSync(join(xdg, 'aivi.json')), false, 'nothing signed in here');
  assert.deepEqual(JSON.parse(await readFile(join(home, 'aivi.json'), 'utf8')), { version: 1 });
});

test('server create without a flag needs an interactive terminal or --use; --use is validated', async t => {
  const a = await scratch();
  t.after(a.cleanup);
  const guarded = run(['server', 'create'], a.env);
  assert.equal(guarded.status, 1);
  assert.match(guarded.stderr, /interactive terminal/);
  const bad = run(['server', 'create', '--use', 'somewhere'], a.env);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Unknown --use somewhere/);
});

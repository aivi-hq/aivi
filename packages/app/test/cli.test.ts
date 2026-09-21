import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { configSchema } from '@aivi/core';
import { createHostServer, Store } from '@aivi/host';

const cli = fileURLToPath(new URL('../src/cli.ts', import.meta.url));

/** Async spawn: the in-test host keeps serving while the CLI child runs. */
const run = (args: string[], env: NodeJS.ProcessEnv) =>
  new Promise<{ status: number; stdout: string; stderr: string }>(resolve => {
    const child = spawn(process.execPath, [cli, ...args], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => (stdout += chunk));
    child.stderr.on('data', chunk => (stderr += chunk));
    child.on('exit', code => resolve({ status: code ?? -1, stdout, stderr }));
  });

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
  const done = await run(['server', 'create', '--use', 'this-machine', '--name', 'Nemo'], env);
  assert.equal(done.status, 0, done.stderr);
  const out = JSON.parse(done.stdout);
  assert.match(out.person, /^person-[0-9a-f]{8}$/);
  assert.match(out.token, /^aivi-[0-9a-f]{32}$/);
  assert.equal(out.url, 'http://127.0.0.1:4100');
  assert.equal(out.home, home);
  assert.match(out.next, /aivi setup/);
  assert.deepEqual(JSON.parse(await readFile(join(home, 'config.json'), 'utf8')), { version: 1 });
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
  const again = await run(['server', 'create', '--use', 'this-machine'], env);
  assert.equal(again.status, 1);
  assert.match(again.stderr, /already has people/);
});

test('server create for another machine prints the token and writes no client config', async t => {
  const { home, xdg, env, cleanup } = await scratch();
  t.after(cleanup);
  const done = await run(['server', 'create', '--use', 'another', '--name', 'Nemo'], env);
  assert.equal(done.status, 0, done.stderr);
  const out = JSON.parse(done.stdout);
  assert.match(out.next, /laptop/);
  assert.equal(out.clientConfig, undefined);
  assert.equal(existsSync(join(xdg, 'aivi.json')), false, 'nothing signed in here');
  assert.deepEqual(JSON.parse(await readFile(join(home, 'config.json'), 'utf8')), { version: 1 });
});

test('server create without a flag needs an interactive terminal or --use; --use is validated', async t => {
  const a = await scratch();
  t.after(a.cleanup);
  const guarded = await run(['server', 'create'], a.env);
  assert.equal(guarded.status, 1);
  assert.match(guarded.stderr, /interactive terminal/);
  const bad = await run(['server', 'create', '--use', 'somewhere'], a.env);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /Unknown --use somewhere/);
});

test('people commands talk HTTP to the running host', async t => {
  const store = new Store(':memory:');
  const { home, env, cleanup } = await scratch();
  const server = createHostServer({
    store,
    loaded: { path: '/config.json', config: configSchema.parse({ version: 1 }), sources: [], projects: [] },
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    await cleanup();
  });
  const port = (server.address() as { port: number }).port;
  await writeFile(join(home, 'config.json'), JSON.stringify({ version: 1, host: { port } }));
  const created = await run(['people', 'create', 'Nemo', '--email', 'nemo@example.com'], env);
  assert.equal(created.status, 0, created.stderr);
  const person = JSON.parse(created.stdout);
  assert.match(person.id, /^person-[0-9a-f]{8}$/);
  const listed = await run(['people', 'list'], env);
  assert.deepEqual(JSON.parse(listed.stdout), [person]);
  const minted = await run(['people', 'token', person.id, '--label', 'laptop'], env);
  assert.equal(minted.status, 0, minted.stderr);
  const token = JSON.parse(minted.stdout);
  assert.match(token.token, /^aivi-[0-9a-f]{32}$/);
  assert.deepEqual(store.personForToken(token.token)!.person.id, person.id);
  const missing = await run(['people', 'token', 'person-none'], env);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /HTTP 404/);
});

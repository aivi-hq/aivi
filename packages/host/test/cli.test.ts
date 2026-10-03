import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { configSchema } from '@aivi/core';
import { createApp, Store, serveApp } from '@aivi/host';

// The host parses no argv of its own (it boots via server.ts), so the command
// surface is driven the way the @aivi/cli bin collects it: registerCommands on
// a bare tree, mounted by the shared driver. NODE_OPTIONS carries the
// development condition, so this drives the sources.
const surface = fileURLToPath(new URL('./command-surface.mjs', import.meta.url));

/** Async spawn: the in-test host keeps serving while the CLI child runs. */
const run = (args: string[], env: NodeJS.ProcessEnv) =>
  new Promise<{ status: number; stdout: string; stderr: string }>(resolve => {
    const child = spawn(process.execPath, [surface, ...args], { env });
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

/** The enablement fact: packages in the `aivi-plugins` list get their commands
 *  mounted and their blocks validated; a home without this file has no plugins. */
const listPlugins = async (home: string, names: unknown[]) => {
  await mkdir(join(home, 'app'), { recursive: true });
  await writeFile(
    join(home, 'app', 'package.json'),
    JSON.stringify({ name: 'aivi-server', private: true, dependencies: {}, 'aivi-plugins': names }),
  );
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
  assert.match(out.next, /other machine/);
  assert.match(out.next, /Connect to a host/);
  assert.equal(out.clientConfig, undefined);
  assert.equal(existsSync(join(xdg, 'aivi.json')), false, 'nothing signed in here');
  assert.deepEqual(JSON.parse(await readFile(join(home, 'config.json'), 'utf8')), { version: 1 });
});

test('server create --public stores the reach address and prints it, probing nothing', async t => {
  const { home, env, cleanup } = await scratch();
  t.after(cleanup);
  const base = 'https://tunnel.example.test';
  const done = await run(['server', 'create', '--use', 'another', '--name', 'Nemo', '--public', base], env);
  assert.equal(done.status, 0, done.stderr);
  const out = JSON.parse(done.stdout);
  assert.equal(out.url, base, 'the printed url is the declared reach address, not the bind guess');
  assert.equal(out.urlNote, undefined, 'a declared address needs no caveat');
  assert.deepEqual(JSON.parse(await readFile(join(home, 'config.json'), 'utf8')).host, { public: base });
  const bad = await run(['server', 'create', '--use', 'another', '--public', 'https://a.test/'], {
    ...env,
    AIVI_HOME: home,
  });
  assert.notEqual(bad.status, 0, 'a trailing slash is refused before anything is written');
  assert.deepEqual(
    JSON.parse(await readFile(join(home, 'config.json'), 'utf8')).host,
    { public: base },
    'config stands',
  );
});

test('server create --lan-bind listens on the network address and says so', async t => {
  const { home, env, cleanup } = await scratch();
  t.after(cleanup);
  const done = await run(['server', 'create', '--use', 'another', '--name', 'Nemo', '--lan-bind', '192.0.2.7'], env);
  assert.equal(done.status, 0, done.stderr);
  const out = JSON.parse(done.stdout);
  assert.equal(out.url, 'http://192.0.2.7:4100', 'the printed url is the LAN address, not loopback');
  assert.match(out.urlNote, /network only/, 'the caveat rides with the guess');
  assert.deepEqual(JSON.parse(await readFile(join(home, 'config.json'), 'utf8')).host, { bind: '192.0.2.7' });
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
  const { home, xdg, env, cleanup } = await scratch();
  const operator = store.createPerson({ name: 'Ada', roles: ['operator'] });
  const { secret } = store.mintToken(operator.id, 'laptop');
  writeFileSync(join(xdg, 'aivi.json'), JSON.stringify({ configVersion: 1, home, person: { token: secret } }));
  const server = serveApp(
    createApp({
      store,
      loaded: { path: '/config.json', config: configSchema.parse({ version: 1 }), sources: [], projects: [] },
    }),
  );
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
  assert.deepEqual(JSON.parse(listed.stdout), [operator, person]);
  const minted = await run(['people', 'token', person.id, '--label', 'laptop'], env);
  assert.equal(minted.status, 0, minted.stderr);
  const token = JSON.parse(minted.stdout);
  assert.match(token.token, /^aivi-[0-9a-f]{32}$/);
  assert.deepEqual(store.personForToken(token.token)!.person.id, person.id);
  const missing = await run(['people', 'token', 'person-none'], env);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /HTTP 404/);
});

// The refuse-relay set answers at invocation, from the machine fact the exec
// door stamps into the child (AIVI_EXEC_SESSION), never by hiding.
test('serve over an exec session answers the guard and never boots a second host', async t => {
  const { env, cleanup } = await scratch();
  t.after(cleanup);
  const done = await run(['serve'], { ...env, AIVI_EXEC_SESSION: '1' });
  assert.equal(done.status, 1);
  assert.match(done.stderr, /serve is not a command over the channel/);
});

test('serve says so when a host already answers the configured endpoint', async t => {
  const store = new Store(':memory:');
  const { home, env, cleanup } = await scratch();
  const server = serveApp(
    createApp({
      store,
      loaded: { path: '/config.json', config: configSchema.parse({ version: 1 }), sources: [], projects: [] },
    }),
  );
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
    store.close();
    await cleanup();
  });
  const port = (server.address() as { port: number }).port;
  await writeFile(join(home, 'config.json'), JSON.stringify({ version: 1, host: { port } }));
  // One probe at invocation finds the answering host and stops; had serve
  // booted instead, this child would never return.
  const done = await run(['serve'], env);
  assert.equal(done.status, 0, done.stderr);
  assert.deepEqual(JSON.parse(done.stdout), { alreadyRunning: true, url: `http://127.0.0.1:${port}` });
});

test('plugin setup needs a terminal; scripts are told what to do instead', async t => {
  const { home, env, cleanup } = await scratch();
  t.after(cleanup);
  await writeFile(join(home, 'config.json'), JSON.stringify({ version: 1 }));

  // An installed package with a ./setup entry still refuses to run without a TTY.
  const guarded = await run(['plugin', 'setup', '@aivi/channel-discord'], env);
  assert.equal(guarded.status, 1);
  assert.match(guarded.stderr, /interactive terminal/);

  // A package that is not installed says so in install terms.
  const missing = await run(['plugin', 'setup', '@acme/nowhere'], env);
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /aivi add @acme\/nowhere/);

  // An installed package without a ./setup export has nothing to say at install time.
  const noSetup = await run(['plugin', 'setup', '@aivi/core'], env);
  assert.equal(noSetup.status, 1);
  assert.match(noSetup.stderr, /no setup command/);

  // And the command wants its spec.
  const bare = await run(['plugin', 'setup'], env);
  assert.equal(bare.status, 1);
  assert.match(bare.stderr, /needs the installed package/);
});

test('slack manifest dumps the whole app manifest as JSON, prefix from the flag, the config or a prompt', async t => {
  const { home, env, cleanup } = await scratch();
  t.after(cleanup);
  await writeFile(join(home, 'config.json'), JSON.stringify({ version: 1 }));
  await listPlugins(home, ['@aivi/channel-slack']);

  // Without a configured module and without --prefix, a script is told what to pass.
  const guarded = await run(['slack', 'manifest'], env);
  assert.equal(guarded.status, 1);
  assert.match(guarded.stderr, /--prefix/);

  // --prefix wins, and the dump is the paste-ready whole manifest.
  const done = await run(['slack', 'manifest', '--prefix', 'aivi'], env);
  assert.equal(done.status, 0, done.stderr);
  const manifest = JSON.parse(done.stdout) as {
    display_information: { name: string };
    features: { bot_user: { display_name: string }; slash_commands: { command: string }[] };
    settings: { socket_mode_enabled: boolean };
  };
  assert.equal(manifest.display_information.name, 'aivi', 'the persona name from config.json identity');
  assert.equal(manifest.features.bot_user.display_name, 'aivi');
  assert.equal(manifest.settings.socket_mode_enabled, true);
  assert.equal(manifest.features.slash_commands[0]!.command, '/aivi-new');

  // A configured module's prefix is the default; --prefix overrides it.
  await writeFile(
    join(home, 'config.json'),
    JSON.stringify({
      version: 1,
      identity: { name: 'Clawd' },
      plugins: { 'channel-slack': { commandPrefix: 'spider', access: { channels: [] } } },
    }),
  );
  const configured = await run(['slack', 'manifest'], env);
  const withConfig = JSON.parse(configured.stdout) as {
    display_information: { name: string };
    features: { slash_commands: { command: string }[] };
  };
  assert.equal(withConfig.features.slash_commands[0]!.command, '/spider-new', 'the prefix the module runs with');
  assert.equal(withConfig.display_information.name, 'Clawd');
  const overridden = await run(['slack', 'manifest', '--prefix', 'aivi'], env);
  assert.equal(
    (JSON.parse(overridden.stdout) as { features: { slash_commands: { command: string }[] } }).features
      .slash_commands[0]!.command,
    '/aivi-new',
  );
});

test('the plugin list is the mount table: no list no commands, a listed package mounts, a broken list is a note', async t => {
  const { home, env, cleanup } = await scratch();
  t.after(cleanup);
  await writeFile(join(home, 'config.json'), JSON.stringify({ version: 1 }));

  // A fresh home has no app/package.json at all: zero plugins, help intact.
  const bare = await run(['--help'], env);
  assert.equal(bare.status, 0, bare.stderr);
  assert.ok(!bare.stdout.includes('slack'), 'nothing listed, nothing mounted');

  // Listing the package mounts its commands, and the composed schema now
  // knows its block.
  await listPlugins(home, ['@aivi/channel-slack']);
  const listed = await run(['--help'], env);
  assert.equal(listed.status, 0, listed.stderr);
  assert.match(listed.stdout, /slack/, 'the listed plugin joined the help');

  // A package npm does not hold breaks the list, not the help: the built-ins
  // stay and the note names the trouble.
  await listPlugins(home, ['@aivi/channel-slack', '@acme/not-here']);
  const broken = await run(['--help'], env);
  assert.equal(broken.status, 0, broken.stderr);
  assert.match(broken.stderr, /@acme\/not-here/);
  assert.match(broken.stdout, /serve/, 'the built-in commands are still there');

  // A disabled tuple still mounts its commands: standing down is serve's
  // business, the operator still needs the plugin's commands.
  await listPlugins(home, [['@aivi/channel-slack', false]]);
  const disabled = await run(['--help'], env);
  assert.equal(disabled.status, 0, disabled.stderr);
  assert.match(disabled.stdout, /slack/, 'a plugin on standby still speaks in the CLI');
});

test('host clear-logs forgets only the rows older than the duration', async t => {
  const { home, env, cleanup } = await scratch();
  t.after(cleanup);
  assert.equal((await run(['server', 'create', '--use', 'another', '--name', 'Nemo'], env)).status, 0);
  const store = new Store(join(home, 'state', 'aivi.sqlite'));
  const day = 86_400_000;
  const now = Date.now();
  store.logRequest({
    at: now - 40 * day,
    method: 'POST',
    path: '/linear/webhooks/app/a',
    status: 200,
    body: null,
    truncated: false,
    headers: {},
  });
  store.logRequest({ at: now, method: 'GET', path: '/health', status: 200, body: null, truncated: false, headers: {} });
  store.close();
  const done = await run(['host', 'clear-logs', '--older-than', '30d'], env);
  assert.equal(done.status, 0, done.stderr);
  assert.deepEqual(JSON.parse(done.stdout), { removed: 1 });
  const left = new Store(join(home, 'state', 'aivi.sqlite'));
  assert.deepEqual(
    left.requests().map(r => r.path),
    ['/health'],
    'the fresh row stays',
  );
  left.close();
});

test('host clear-logs insists on a duration it can read', async t => {
  const { env, cleanup } = await scratch();
  t.after(cleanup);
  assert.equal((await run(['server', 'create', '--use', 'another', '--name', 'Nemo'], env)).status, 0);
  assert.notEqual((await run(['host', 'clear-logs'], env)).status, 0, 'no --older-than is not success');
  const bogus = await run(['host', 'clear-logs', '--older-than', 'tomorrow'], env);
  assert.equal(bogus.status, 1);
  assert.match(bogus.stderr, /Not a duration/);
});

test('the prompts set rides with the home and answers list, install and show', async t => {
  const { home, env, cleanup } = await scratch();
  t.after(cleanup);
  const done = await run(['server', 'create', '--use', 'this-machine', '--name', 'Nemo'], env);
  assert.equal(done.status, 0, done.stderr);

  // The copies came with the home: `aivi prompts` sees them all as files.
  const listed = await run(['prompts'], env);
  assert.equal(listed.status, 0, listed.stderr);
  const rows = JSON.parse(listed.stdout) as { name: string; source: string; path: string }[];
  assert.deepEqual(
    rows.map(r => r.name),
    ['worker-contract', 'nudge', 'feedback-loop', 'review-posture', 'pr-body', 'escalation', 'job-result'],
  );
  assert.ok(rows.every(r => r.source === 'file' && r.path === join(home, 'prompts', `${r.name}.md`)));
  const nudge = await readFile(join(home, 'prompts', 'nudge.md'), 'utf8');
  assert.match(nudge, /^<!-- aivi: this prompt is yours to edit/, 'the copy opens with the warning header');

  // An edit is the operator's word, and install never overwrites it.
  await writeFile(join(home, 'prompts', 'nudge.md'), 'Second chances are free.\n');
  const installed = await run(['prompts', 'install'], env);
  assert.equal(installed.status, 0, installed.stderr);
  assert.deepEqual(JSON.parse(installed.stdout).written, [], 'an existing file is nobody’s to overwrite');
  const shown = await run(['prompts', 'show', 'nudge'], env);
  assert.equal(shown.status, 0, shown.stderr);
  assert.deepEqual(JSON.parse(shown.stdout), {
    name: 'nudge',
    source: 'file',
    text: 'Second chances are free.',
  });

  // Delete restores the built-in: the file is gone, the words return.
  await rm(join(home, 'prompts', 'nudge.md'));
  const restored = await run(['prompts', 'show', 'nudge'], env);
  assert.match(JSON.parse(restored.stdout).text, /Your turn ended without reporting/);
  assert.equal(JSON.parse(restored.stdout).source, 'built-in');

  const unknown = await run(['prompts', 'show', 'dayjob'], env);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown prompt: dayjob/);
});

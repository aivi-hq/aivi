import assert from 'node:assert/strict';
import childProcess, { type SpawnSyncReturns } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import os from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createSetupIo } from '../src/setup.ts';
import { aiviVersion } from '../src/version.ts';
import { cancelSetup, hostUrl, modelDefaults, setupFixture, setupPrompts, TOKEN } from './setup-fixture.ts';

function processResult(status: number | null, stdout = ''): SpawnSyncReturns<string> {
  return { pid: 0, output: [null, stdout, ''], stdout, stderr: '', status, signal: status === null ? 'SIGTERM' : null };
}

function setupProcesses(t: TestContext) {
  const spawn = t.mock.method(
    childProcess,
    'spawnSync',
    (command: string, args: readonly string[]): SpawnSyncReturns<string> => {
      throw new Error(`Unexpected subprocess: ${command} ${args.join(' ')}`);
    },
  );
  syncBuiltinESMExports();
  t.after(() => {
    spawn.mock.restore();
    syncBuiltinESMExports();
  });
  return spawn;
}

test('setup installs exact package specs in the app directory and preserves process failures', t => {
  const spawn = setupProcesses(t);
  const io = createSetupIo();
  spawn.mock.mockImplementation(() => processResult(0));

  io.install(['@aivi/host@0.2.0'], '/aivi/app');

  assert.deepEqual(spawn.mock.calls[0]!.arguments, [
    'npm',
    ['install', '--save-exact', '--no-fund', '@aivi/host@0.2.0'],
    { cwd: '/aivi/app', stdio: 'inherit' },
  ]);
  for (const status of [2, null]) {
    spawn.mock.mockImplementation(() => processResult(status));
    assert.throws(
      () => io.install(['@aivi/host'], '/aivi/app'),
      new RegExp(`npm install failed \\(exit ${status ?? 'signal'}\\)`),
    );
  }
  const failure = new Error('npm could not start');
  spawn.mock.mockImplementation(() => ({ ...processResult(null), error: failure }));
  assert.throws(
    () => io.install(['@aivi/host'], '/aivi/app'),
    error => error === failure,
  );
});

test('npm metadata is read as JSON and a refused or malformed answer is not a version', async t => {
  const spawn = setupProcesses(t);
  const io = createSetupIo();
  spawn.mock.mockImplementation(() => processResult(0, ' "9.9.9"\n'));

  assert.equal(await io.npmView('@aivi/opencode', 'version'), '9.9.9');
  assert.deepEqual(spawn.mock.calls[0]!.arguments, [
    'npm',
    ['view', '@aivi/opencode', 'version', '--json'],
    { encoding: 'utf8' },
  ]);
  spawn.mock.mockImplementation(() => processResult(1));
  await assert.rejects(io.npmView('@aivi/opencode', 'version'), /npm view @aivi\/opencode version failed/);
  spawn.mock.mockImplementation(() => processResult(0, 'not JSON'));
  await assert.rejects(io.npmView('@aivi/opencode', 'version'), SyntaxError);
});

test('OpenCode availability is a quiet version probe and plugin additions surface exits and launch errors', t => {
  const spawn = setupProcesses(t);
  const log = t.mock.method(console, 'log', () => {});
  const io = createSetupIo();
  spawn.mock.mockImplementation(() => processResult(0));

  assert.equal(io.opencodeOnPath(), true);
  assert.deepEqual(spawn.mock.calls[0]!.arguments, ['opencode', ['--version'], { stdio: 'ignore' }]);
  io.pluginAdd('@aivi/opencode');
  assert.deepEqual(spawn.mock.calls[1]!.arguments, [
    'opencode',
    ['plugin', 'add', '@aivi/opencode'],
    { stdio: 'inherit' },
  ]);
  assert.match(log.mock.calls[0]!.arguments[0], /Adding the @aivi\/opencode plugin/);

  for (const status of [1, null]) {
    spawn.mock.mockImplementation(() => processResult(status));
    assert.equal(io.opencodeOnPath(), false);
    assert.throws(() => io.pluginAdd('@aivi/opencode'), new RegExp(`failed \\(exit ${status ?? 'signal'}\\)`));
  }
  const failure = new Error('OpenCode could not start');
  spawn.mock.mockImplementation(() => ({ ...processResult(null), error: failure }));
  assert.throws(
    () => io.pluginAdd('@aivi/opencode'),
    error => error === failure,
  );
});

test('health probes use a bounded signal and treat HTTP or transport failures as unhealthy', async t => {
  const io = createSetupIo();
  const signal = new AbortController().signal;
  const timeout = t.mock.method(AbortSignal, 'timeout', () => signal);
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('ok'));

  assert.equal(await io.health(hostUrl), true);
  assert.deepEqual(fetch.mock.calls[0]!.arguments, [`${hostUrl}/health`, { signal }]);
  assert.deepEqual(timeout.mock.calls[0]!.arguments, [2000]);
  fetch.mock.mockImplementation(async () => new Response('unhealthy', { status: 503 }));
  assert.equal(await io.health(hostUrl), false);
  fetch.mock.mockImplementation(async () => {
    throw new Error('offline');
  });
  assert.equal(await io.health(hostUrl), false);
});

test('whoami authenticates and identifies the client, then preserves distinct authorization and server failures', async t => {
  const io = createSetupIo();
  const who = { person: { id: 'verified-id', name: 'Ada' }, roles: ['operator'] };
  const signal = new AbortController().signal;
  const timeout = t.mock.method(AbortSignal, 'timeout', () => signal);
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(who));

  assert.deepEqual(await io.whoami(hostUrl, TOKEN), who);
  assert.deepEqual(fetch.mock.calls[0]!.arguments, [
    `${hostUrl}/whoami`,
    { headers: { 'x-aivi-client': aiviVersion, authorization: `Bearer ${TOKEN}` }, signal },
  ]);
  assert.deepEqual(timeout.mock.calls[0]!.arguments, [5000]);
  fetch.mock.mockImplementation(async () => new Response('', { status: 401 }));
  await assert.rejects(io.whoami(hostUrl, TOKEN), /token does not name a person.*aivi people token/);
  fetch.mock.mockImplementation(async () => new Response('', { status: 503 }));
  await assert.rejects(io.whoami(hostUrl, TOKEN), /whoami answered 503/);
  fetch.mock.mockImplementation(async () => new Response('not JSON'));
  await assert.rejects(io.whoami(hostUrl, TOKEN), SyntaxError);
  const failure = new Error('offline');
  fetch.mock.mockImplementation(async () => {
    throw failure;
  });
  await assert.rejects(io.whoami(hostUrl, TOKEN), error => error === failure);
});

test('installed-server adapters import only their requested modules with the selected home', async t => {
  const h = setupFixture(t);
  const schemaPath = h.installedModule(
    'dist/cli/schema-cache.js',
    `
export const calls = [];
export async function writeEditorSchema(home) {
  calls.push({ home, env: process.env.AIVI_HOME });
  return home + '/state/cache/schema.json';
}
`,
  );
  const identityPath = h.installedModule(
    'dist/cli/identity.js',
    `
export const calls = [];
export async function serverCreate(options) {
  calls.push({ options, env: process.env.AIVI_HOME });
  return ${JSON.stringify(h.identity)};
}
`,
  );
  const knowledgePath = h.installedModule(
    'dist/cli/commands/knowledge.js',
    `
export const QMD_BUILTIN_MODELS = ${JSON.stringify(modelDefaults)};
export async function warmHome() { throw new Error('must not fetch models during module loading'); }
`,
  );
  const io = createSetupIo();

  await io.rebuildSchema(h.home, h.appDir);
  const identity = await io.createIdentity(
    { use: 'another', name: 'Ada', public: 'https://aivi.example', lanBind: '10.0.0.3' },
    h.home,
    h.appDir,
  );
  const knowledge = await io.loadKnowledge(h.home, h.appDir);

  const schemaModule = await import(pathToFileURL(schemaPath).href);
  assert.deepEqual(schemaModule.calls, [{ home: h.home, env: h.home }]);
  const identityModule = await import(pathToFileURL(identityPath).href);
  assert.deepEqual(identityModule.calls, [
    {
      options: {
        home: h.home,
        configPath: join(h.home, 'config.json'),
        use: 'another',
        name: 'Ada',
        public: 'https://aivi.example',
        lanBind: '10.0.0.3',
      },
      env: h.home,
    },
  ]);
  assert.deepEqual(identity, h.identity);
  const knowledgeModule = await import(pathToFileURL(knowledgePath).href);
  assert.deepEqual(knowledge.QMD_BUILTIN_MODELS, modelDefaults);
  assert.equal(knowledge.warmHome, knowledgeModule.warmHome);
});

test('the basic setup questions return the selected branch and machine, trimmed name and confirmation answers', async t => {
  const h = setupPrompts(t, ['create', 'another', '  Ada  ', true, false, '   ']);

  assert.equal(await h.io.ask.branch(), 'create');
  assert.equal(await h.io.ask.machine(), 'another');
  assert.equal(await h.io.ask.name(), 'Ada');
  assert.equal(await h.io.ask.background(), true);
  assert.equal(await h.io.ask.fetchModels(), false);
  assert.equal(await h.io.ask.name(), 'Operator');
  assert.deepEqual(
    h.questions[0]!.options?.map(option => option.value),
    ['connect', 'create'],
  );
  assert.deepEqual(
    h.questions[1]!.options?.map(option => option.value),
    ['this-machine', 'another'],
  );
  assert.equal(h.questions[3]!.initialValue, true);
  assert.equal(h.questions[4]!.initialValue, true);
});

test('host and bearer questions trim answers and reject invalid or empty input', async t => {
  const h = setupPrompts(t, ['  https://aivi.example  ', `  ${TOKEN}  `]);

  assert.equal(await h.io.ask.url(), 'https://aivi.example');
  assert.equal(await h.io.ask.token(), TOKEN);
  const url = h.questions[0]!.validate;
  const token = h.questions[1]!.validate;
  assert.ok(url);
  assert.ok(token);
  for (const input of [undefined, '', 'aivi.example', 'ftp://aivi.example', 'http://has space']) assert.ok(url(input));
  assert.equal(url(' http://aivi.example:4100 '), undefined);
  for (const input of [undefined, '', '   ']) assert.ok(token(input));
  assert.equal(token(` ${TOKEN} `), undefined);
});

test('reach accepts local-only or a trimmed public URL and validates the public address before identity', async t => {
  const h = setupPrompts(t, ['none', 'url', ' https://aivi.example ']);

  assert.deepEqual(await h.io.ask.reach(), { kind: 'none' });
  assert.deepEqual(await h.io.ask.reach(), { kind: 'url', url: 'https://aivi.example' });
  const validate = h.questions[2]!.validate;
  assert.ok(validate);
  for (const value of [undefined, '', 'aivi.example', 'http://has space', 'https://aivi.example/'])
    assert.ok(validate(value));
  assert.equal(validate(' https://aivi.example '), undefined);
});

test('LAN reach offers only unique external IPv4 addresses and returns the chosen bind', async t => {
  const h = setupPrompts(t, ['lan', '100.64.0.2']);
  const address = (value: string, internal = false): os.NetworkInterfaceInfo => ({
    address: value,
    family: 'IPv4',
    internal,
    netmask: '255.255.255.0',
    mac: '00:00:00:00:00:00',
    cidr: `${value}/24`,
  });
  const interfaces = t.mock.method(os, 'networkInterfaces', () => ({
    en0: [address('10.0.0.3'), address('127.0.0.1', true), { ...address('::1'), family: 'IPv6' as const, scopeid: 0 }],
    tailnet: [address('100.64.0.2'), address('10.0.0.3')],
    empty: undefined,
  }));
  syncBuiltinESMExports();
  t.after(() => {
    interfaces.mock.restore();
    syncBuiltinESMExports();
  });

  assert.deepEqual(await h.io.ask.reach(), { kind: 'lan', bind: '100.64.0.2' });
  assert.deepEqual(h.questions[1]!.options, [
    { value: '10.0.0.3', label: 'en0 — 10.0.0.3' },
    { value: '100.64.0.2', label: 'tailnet — 100.64.0.2' },
  ]);
  interfaces.mock.mockImplementation(() => ({}));
  const missing = setupPrompts(t, ['lan']);
  await assert.rejects(missing.io.ask.reach(), /no LAN or tailnet address was found/);
  assert.equal(missing.ask.mock.callCount(), 1);
});

test('semantic model questions keep empty defaults and collect only named roles', async t => {
  const h = setupPrompts(t, ['  ', ' rerank-custom ', 'generate-custom']);

  assert.deepEqual(await h.io.ask.models(modelDefaults), { rerank: 'rerank-custom', generate: 'generate-custom' });
  assert.deepEqual(
    h.questions.map(question => question.placeholder),
    Object.values(modelDefaults),
  );
});

test('cancelling a semantic role never asks about later roles', async t => {
  const h = setupPrompts(t, ['embed-custom', cancelSetup]);

  await assert.rejects(h.io.ask.models(modelDefaults), /an answer was cancelled/);

  assert.equal(h.ask.mock.callCount(), 2);
});

test('noninteractive semantic and ordinary prompts expose the script instructions without asking anything', async t => {
  const h = setupPrompts(t, [], false);

  await assert.rejects(h.io.ask.models(modelDefaults), /interactive terminal.*--use .*--connect/);
  await assert.rejects(h.io.ask.url(), /interactive terminal.*--use .*--connect/);

  assert.equal(h.ask.mock.callCount(), 0);
});

test('capacity accepts no limit or a whole bounded number and rejects fractional, negative or excessive input', async t => {
  const h = setupPrompts(t, ['   ', ' 3 ']);

  assert.equal(await h.io.ask.capacity(), undefined);
  assert.equal(await h.io.ask.capacity(), 3);
  const validate = h.questions[0]!.validate;
  assert.ok(validate);
  for (const input of [undefined, '', ' ', '1', '64', ' 3 ']) assert.equal(validate(input), undefined);
  for (const input of ['0', '-1', '1.5', '65', 'many']) assert.ok(validate(input));
});

test('setup writers forward normal, warning and cancellation messages to the selected output adapters', t => {
  const h = setupPrompts(t, []);
  const log = t.mock.method(console, 'log', () => {});
  const warn = t.mock.method(console, 'warn', () => {});

  h.io.log('installed');
  h.io.warn('offline');
  h.io.cancel('cancelled');

  assert.deepEqual(log.mock.calls[0]!.arguments, ['installed']);
  assert.deepEqual(warn.mock.calls[0]!.arguments, ['offline']);
  assert.deepEqual(h.cancel.mock.calls[0]!.arguments, ['cancelled']);
});

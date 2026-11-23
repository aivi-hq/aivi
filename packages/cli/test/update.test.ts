/** `aivi update` as a unit: the address its health probe reaches, the bounded wait for health, and the refusals and
 *  fallbacks of the update itself. The install, the editor schema, the service and the managed Node are mocks; the
 *  home is a scratch directory and the client config is pointed at it. */
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, mock, type TestContext, test } from 'node:test';
import { loadClientConfig } from '../src/client-config.ts';
import type { UpdateIo } from '../src/update.ts';
import { setupClock } from './setup-fixture.ts';

const ensureNode = mock.fn(async (_home: string, _range: string) => '/managed/node');
const realRuntime = await import('../src/runtime.ts');
mock.module('../src/runtime.ts', { exports: { ...realRuntime, ensureNode } });
const { healthUrl, updateServer, waitHealthy } = await import('../src/update.ts');

let directory: string;
let savedClientConfig: string | undefined;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'aivi-update-test-'));
  savedClientConfig = process.env.AIVI_CONFIG;
  process.env.AIVI_CONFIG = join(directory, 'client.json');
  ensureNode.mock.resetCalls();
});

afterEach(() => {
  if (savedClientConfig === undefined) delete process.env.AIVI_CONFIG;
  else process.env.AIVI_CONFIG = savedClientConfig;
  rmSync(directory, { recursive: true, force: true });
});

const home = () => join(directory, 'home');

/** A home whose server is installed at 0.1.0, with the given app manifest and config.json. */
function installedServer(
  manifest: object = { dependencies: { '@aivi/host': '0.1.0' } },
  config: object = { version: 1 },
) {
  const appDir = join(home(), 'app');
  mkdirSync(join(appDir, 'node_modules', '@aivi', 'host'), { recursive: true });
  writeFileSync(join(appDir, 'package.json'), JSON.stringify(manifest));
  writeFileSync(join(appDir, 'node_modules', '@aivi', 'host', 'package.json'), JSON.stringify({ version: '0.1.0' }));
  writeFileSync(join(home(), 'config.json'), JSON.stringify(config));
  return { home: home(), appDir, nodePath: process.execPath };
}

/** The I/O of an update that finds 0.2.0 on npm and does everything quietly; `over` replaces what a test is about. */
function fakeIo(over: Partial<UpdateIo> = {}): UpdateIo {
  return {
    npmView: async (_spec, field) => (field === 'engines.node' ? '>=26 <27' : '0.2.0'),
    install: () => ({ status: 0, stderr: '' }),
    rebuildSchema: async () => {},
    log: () => {},
    healthProbe: async () => false,
    service: { installed: () => false, restart: () => {} },
    ...over,
  };
}

/** Every `node -v` this process spawns answers `stdout`; `syncBuiltinESMExports` makes the named import see it. */
function nodeAnswers(t: TestContext, stdout: string) {
  const spawn = t.mock.method(childProcess, 'spawnSync', () => ({ status: 0, stdout, stderr: '' }));
  syncBuiltinESMExports();
  t.after(() => {
    spawn.mock.restore();
    syncBuiltinESMExports();
  });
  return spawn;
}

test('the health probe reaches the address the server binds, and a wildcard bind means loopback', async () => {
  const addresses: [string, string | object | undefined, string][] = [
    ['no config.json at all', undefined, 'http://127.0.0.1:4100'],
    ['a config.json that does not parse', 'not json', 'http://127.0.0.1:4100'],
    ['a port alone', { host: { port: 4200 } }, 'http://127.0.0.1:4200'],
    ['the IPv4 wildcard', { host: { bind: '0.0.0.0' } }, 'http://127.0.0.1:4100'],
    ['the IPv6 wildcard', { host: { bind: '::' } }, 'http://127.0.0.1:4100'],
    ['the bracketed IPv6 wildcard', { host: { bind: '[::]' } }, 'http://127.0.0.1:4100'],
    ['an IPv6 address', { host: { bind: '::1' } }, 'http://[::1]:4100'],
    ['a bracketed IPv6 address', { host: { bind: '[::1]' } }, 'http://[::1]:4100'],
    ['a host name', { host: { bind: 'aivi.local', port: 80 } }, 'http://aivi.local:80'],
  ];
  mkdirSync(home(), { recursive: true });
  for (const [what, config, url] of addresses) {
    rmSync(join(home(), 'config.json'), { force: true });
    if (config !== undefined)
      writeFileSync(join(home(), 'config.json'), typeof config === 'string' ? config : JSON.stringify(config));
    assert.equal(await healthUrl(home()), url, what);
  }
});

test('waiting for health returns at once when the first probe answers', async () => {
  const probes: string[] = [];
  await waitHealthy(
    {
      healthProbe: async url => {
        probes.push(url);
        return true;
      },
    },
    'http://127.0.0.1:4100',
    'never said',
  );
  assert.deepEqual(probes, ['http://127.0.0.1:4100']);
});

test('waiting for health tries again after half a second', async t => {
  const waiting = setupClock(t);
  const answers = [false, true];
  const waited = waitHealthy(
    { healthProbe: async () => answers.shift() === true },
    'http://127.0.0.1:4100',
    'never said',
  );

  assert.equal(await waiting, 500);
  t.mock.timers.tick(500);
  await waited;
  assert.deepEqual(answers, [], 'the second probe was the one that answered');
});

test('waiting for health gives up after thirty seconds with the words the caller chose', async t => {
  const waiting = setupClock(t);
  const waited = assert.rejects(
    waitHealthy({ healthProbe: async () => false }, 'http://127.0.0.1:4100', 'It did not come back.'),
    /^Error: It did not come back\.$/,
  );

  await waiting;
  t.mock.timers.tick(30_001);
  await waited;
});

test('update without a config.json says to run setup', async () => {
  const server = installedServer();
  rmSync(join(server.home, 'config.json'));
  await assert.rejects(updateServer(server, fakeIo()), /No config\.json in .*aivi setup/);
});

test('update refuses a channel it does not know, before it asks npm anything', async () => {
  const asked: string[] = [];
  const server = installedServer(undefined, { update: { channel: 'beta' } });
  await assert.rejects(
    updateServer(
      server,
      fakeIo({
        npmView: async spec => {
          asked.push(spec);
          return '0.2.0';
        },
      }),
    ),
    /Unknown update channel: beta/,
  );
  assert.deepEqual(asked, []);
});

test('update refuses a home that has no server in its manifest', async () => {
  for (const manifest of [{}, { dependencies: { '@aivi/channel-discord': '0.1.0' } }]) {
    const server = installedServer(manifest);
    await assert.rejects(updateServer(server, fakeIo()), /No aivi server installed at .*aivi setup/);
  }
});

test('a target that needs a newer Node provisions the managed one first, and the client config records it', async () => {
  const logs: string[] = [];
  const installs: string[][] = [];
  await updateServer(
    installedServer(),
    fakeIo({
      npmView: async (_spec, field) => (field === 'engines.node' ? '>=27 <28' : '0.2.0'),
      install: specs => {
        installs.push(specs);
        return { status: 0, stderr: '' };
      },
      log: message => logs.push(message),
    }),
  );

  assert.deepEqual(ensureNode.mock.calls[0]!.arguments, [home(), '>=27 <28']);
  assert.equal(loadClientConfig()?.nodePath, '/managed/node');
  assert.ok(logs.includes('The target needs Node >=27 <28; provisioning the managed runtime.'));
  assert.deepEqual(installs, [['@aivi/host@0.2.0']], 'and then the update goes on');
});

test('a Node other than the running one is asked for its own version', async t => {
  const answers: [string, number][] = [
    ['v26.0.0\n', 1],
    ['', 1],
    ['v26.13.1\n', 0],
  ];
  for (const [stdout, provisioned] of answers) {
    ensureNode.mock.resetCalls();
    const spawn = nodeAnswers(t, stdout);
    const server = { ...installedServer(), nodePath: '/opt/node/bin/node' };
    await updateServer(
      server,
      fakeIo({ npmView: async (_spec, field) => (field === 'engines.node' ? '>=26.12.0 <27' : '0.2.0') }),
    );
    assert.deepEqual(spawn.mock.calls[0]!.arguments, ['/opt/node/bin/node', ['-v'], { encoding: 'utf8' }]);
    assert.equal(ensureNode.mock.callCount(), provisioned, `a Node that said ${JSON.stringify(stdout)}`);
    spawn.mock.restore();
  }
});

test('a target whose engines cannot be read is updated without provisioning anything', async () => {
  const installs: string[][] = [];
  await updateServer(
    installedServer(),
    fakeIo({
      npmView: async (_spec, field) => {
        if (field === 'engines.node') throw new Error('offline');
        return '0.2.0';
      },
      install: specs => {
        installs.push(specs);
        return { status: 0, stderr: '' };
      },
    }),
  );

  assert.equal(ensureNode.mock.callCount(), 0);
  assert.deepEqual(installs, [['@aivi/host@0.2.0']]);
});

test('an editor schema that cannot rebuild is said, and the update still finishes', async () => {
  const failures: [() => Promise<void>, string][] = [
    [
      async () => {
        throw new Error('config.json did not load');
      },
      'config.json did not load',
    ],
    [() => Promise.reject('disk full'), 'disk full'],
  ];
  for (const [rebuildSchema, reason] of failures) {
    const logs: string[] = [];
    await updateServer(installedServer(), fakeIo({ rebuildSchema, log: message => logs.push(message) }));

    assert.ok(
      logs.includes(
        `the editor schema was not rebuilt (${reason}); \`aivi add\` or a later \`aivi update\` rebuilds it once config.json loads again.`,
      ),
    );
    assert.ok(logs.includes('Updated @aivi/host: 0.1.0 → 0.2.0.'));
    assert.ok(logs.includes('Done. Start the server with `aivi serve`.'));
  }
});

test('an install that npm refuses without a plugin to blame is the update’s failure', async () => {
  const conflict = (name: string) => `npm error While resolving: ${name}@0.2.0\nnpm error peer @aivi/host@"^0.2.0"`;
  const refusals: [string, string][] = [
    ['an error that names no plugin', 'npm error ENOTFOUND registry.npmjs.org'],
    ['the server itself', conflict('@aivi/host')],
    ['a plugin that stayed in conflict after it was set aside', conflict('@aivi/channel-discord')],
  ];
  for (const [what, stderr] of refusals) {
    const server = installedServer({ dependencies: { '@aivi/host': '0.1.0', '@aivi/channel-discord': '0.1.0' } });
    await assert.rejects(
      updateServer(server, fakeIo({ install: () => ({ status: 1, stderr }) })),
      /npm install failed:/,
      what,
    );
  }
});

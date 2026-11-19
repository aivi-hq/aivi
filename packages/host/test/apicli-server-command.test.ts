/** The server commands as a unit: what `serve` decides from the probe of the
 *  configured endpoint, and what status, config and OpenCode checks ask of
 *  the home and print. The home's context, the boot, the schema writer and the
 *  OpenCode connection are module mocks; nothing here boots a host or dials
 *  a service. */
import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import type { LoadedConfig } from '@aivi/core';
import { loadedWith, parse } from './apicli-fixture.ts';

const world = { loaded: loadedWith() };
const print = mock.fn();
const withStore = mock.fn(async (_loaded: LoadedConfig, fn: (store: string) => unknown) => fn('the store'));
const startServer = mock.fn(async () => {});
const writeEditorSchema = mock.fn(async (_home: string) => '/aivi-home/state/cache/schema.json');
const info = mock.fn(async (_options: { signal: AbortSignal }) => ({ version: '2.2.7' }));
const connectOpenCode = mock.fn(async (_config: unknown) => ({ server: { info } }));
const status = mock.fn((_store: unknown, _loaded: LoadedConfig) => 'the status');

mock.module('../src/cli/context.ts', {
  exports: {
    context: async () => ({ loaded: world.loaded }),
    home: () => '/aivi-home',
    hostUrl: () => 'http://host.test',
    print,
    withStore,
  },
});
mock.module('../src/server.ts', { exports: { startServer } });
mock.module('../src/cli/schema-cache.ts', { exports: { writeEditorSchema } });
const host = await import('@aivi/host');
mock.module('@aivi/host', { exports: { ...host, connectOpenCode, status } });

const { registerServer } = await import('../src/cli/commands/server.ts');

beforeEach(() => {
  for (const spy of [print, withStore, startServer, writeEditorSchema, info, connectOpenCode, status])
    spy.mock.resetCalls();
  world.loaded = loadedWith();
});

const printed = () => print.mock.calls.map(call => call.arguments);

test('serve over an exec session refuses before it probes or boots anything', async t => {
  const probe = t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('nothing may be probed');
  });
  await assert.rejects(
    parse(program => registerServer(program, { remote: true }), 'serve'),
    /the server is the thing being driven; serve is not a command over the channel/,
  );
  assert.equal(probe.mock.callCount() + startServer.mock.callCount(), 0);
});

test('serve boots the host only when nothing answers the configured endpoint', async t => {
  const probe = t.mock.method(globalThis, 'fetch', async () => Response.json({ ok: true }));
  await parse(program => registerServer(program, {}), 'serve');
  assert.equal(startServer.mock.callCount(), 0, 'a host that answers is the wanted state: never a second beside it');
  assert.deepEqual(printed(), [
    [{ alreadyRunning: true, url: 'http://host.test' }, 'server already running at http://host.test'],
  ]);
  const [url, init] = probe.mock.calls[0]!.arguments;
  assert.equal(url, 'http://host.test/health');
  assert.ok(init?.signal instanceof AbortSignal, 'the probe is bounded');

  for (const answer of [() => new Response(null, { status: 503 }), () => Promise.reject(new Error('refused'))]) {
    probe.mock.mockImplementation(async () => answer());
    startServer.mock.resetCalls();
    await parse(program => registerServer(program, {}), 'serve');
    assert.equal(startServer.mock.callCount(), 1, 'a failing or refused probe means nothing is up');
  }
  assert.equal(print.mock.callCount(), 1, 'booting prints nothing of its own');
});

test('status prints the host status over the store the home opens', async () => {
  await parse(program => registerServer(program, {}), 'status');
  assert.deepEqual(withStore.mock.calls[0]!.arguments[0], world.loaded);
  assert.deepEqual(status.mock.calls[0]!.arguments, ['the store', world.loaded]);
  assert.deepEqual(printed(), [['the status']]);
});

test('config check says the home is valid and names its projects, sources and host', async () => {
  world.loaded = loadedWith(
    { host: { port: 4200 } },
    {
      projects: [{ id: 'app', directory: '/aivi-home/projects/app' }],
      sources: [{ id: 'company', path: '/company', kind: 'doc', scope: 'core' }],
    },
  );
  await parse(program => registerServer(program, {}), 'config', 'check');
  assert.deepEqual(printed(), [
    [
      {
        valid: true,
        projects: [{ id: 'app', directory: '/aivi-home/projects/app' }],
        sources: 1,
        host: world.loaded.config.host,
      },
    ],
  ]);
});

test('config schema rebuilds the editor schema of the home and says where it is', async () => {
  await parse(program => registerServer(program, {}), 'config', 'schema');
  assert.deepEqual(writeEditorSchema.mock.calls[0]!.arguments, ['/aivi-home']);
  assert.deepEqual(printed(), [
    [{ file: '/aivi-home/state/cache/schema.json' }, 'Editor schema rebuilt: /aivi-home/state/cache/schema.json'],
  ]);
});

test('opencode check asks the service the home would use for its info within ten seconds', async () => {
  await parse(program => registerServer(program, {}), 'opencode', 'check');
  assert.deepEqual(connectOpenCode.mock.calls[0]!.arguments, [world.loaded.config.opencode]);
  assert.ok(info.mock.calls[0]!.arguments[0].signal instanceof AbortSignal);
  assert.deepEqual(printed(), [[{ version: '2.2.7' }]]);
});

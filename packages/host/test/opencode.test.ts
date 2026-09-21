import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { DiscoverOptions, EnsureOptions } from '@opencode/client/service';
import { connectOpenCode, discoverTolerant, restartOpenCode } from '../src/opencode.ts';

const endpoint = { url: 'http://127.0.0.1:1', auth: { type: 'basic' as const, username: 'opencode', password: 'p' } };
const never = async (): Promise<never> => {
  throw new Error('must not be called');
};

test('a missing service is started through the SDK; "discover" never starts one', async () => {
  const calls: unknown[] = [];
  const started: string[] = [];
  const client = await connectOpenCode(
    { lifecycle: 'ensure' },
    {},
    {
      discover: async () => undefined,
      ensure: async options => {
        calls.push(options);
        options?.onStart?.('missing');
        return endpoint;
      },
      onStart: reason => started.push(reason),
    },
  );
  assert.ok(client.session, 'a client for the started service');
  assert.equal((calls[0] as { env?: unknown }).env, undefined, 'the service starts with no injected env');
  assert.deepEqual(started, ['missing']);

  await assert.rejects(
    connectOpenCode({ lifecycle: 'discover' }, {}, { discover: async () => undefined, ensure: never }),
    /No running OpenCode v2 service found/,
  );
  // A running service is used as is by every lifecycle.
  const untouched = await connectOpenCode({ lifecycle: 'own' }, {}, { discover: async () => endpoint, ensure: never });
  assert.ok(untouched.session);
});

test('"own" replaces a running service at startup with pty handoff; other lifecycles and url leave it alone', async () => {
  const events: string[] = [];
  const hooks = {
    discover: async () => endpoint,
    stop: async (options?: { pty?: string }) => {
      events.push(`stop:${options?.pty}`);
    },
    ensure: async (options?: { env?: Record<string, string> }) => {
      events.push(`ensure:${options?.env === undefined ? '-' : 'env'}`);
      return endpoint;
    },
    onStart: (reason: string) => events.push(`start:${reason}`),
  };
  assert.equal(await restartOpenCode({ lifecycle: 'own' }, hooks), true);
  assert.deepEqual(events, ['start:restart', 'stop:handoff', 'ensure:-']);
  events.length = 0;
  assert.equal(await restartOpenCode({ lifecycle: 'own' }, { ...hooks, discover: async () => undefined }), false);
  assert.equal(await restartOpenCode({ lifecycle: 'ensure' }, hooks), false);
  assert.equal(await restartOpenCode({ lifecycle: 'discover' }, hooks), false);
  assert.equal(await restartOpenCode({ url: 'http://elsewhere:1', lifecycle: 'own' }, hooks), false);
  assert.deepEqual(events, [], 'nothing stopped or started');
});

test('tolerant discovery accepts any listening server and reports its version', async t => {
  let probes = 0;
  const server = createServer((request, response) => {
    probes += 1;
    // A server that no longer speaks the paths the SDK probes: both 404.
    if (request.url === '/api/info')
      return void response.writeHead(200, { 'content-type': 'application/json' }).end('{"version":"9.9.9","pid":1}');
    response.writeHead(404).end();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const directory = await mkdtemp(join(tmpdir(), 'aivi-discover-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'service.json');
  await writeFile(file, JSON.stringify({ url, version: '2.0.10', pid: 1, password: 'p' }));

  const found = await discoverTolerant({ file });
  assert.ok(found, 'a server that answers HTTP is alive, whatever its version');
  assert.equal(found.url, url);
  assert.equal(found.version, '9.9.9', 'the server version comes from the probe');
  assert.ok(found.auth, 'the registration credentials ride along');

  // An empty registration and a dead endpoint are simply "not running".
  await writeFile(file, '{}');
  assert.equal(await discoverTolerant({ file }), undefined);
  await writeFile(file, JSON.stringify({ url: 'http://127.0.0.1:1', pid: 1 }));
  assert.equal(await discoverTolerant({ file }), undefined, 'nothing listening: not running');
  assert.ok(probes >= 1);
});

test('the SDK is handed a version predicate that logs once and accepts every version', async _t => {
  const infos: unknown[] = [];
  const log = {
    info: (event: string, fields: unknown) => infos.push([event, fields]),
    warn: () => {},
    child: () => log,
  };
  const seen: (boolean | undefined)[] = [];
  const probe = (options: DiscoverOptions | EnsureOptions | undefined, version: string) =>
    typeof options?.version === 'function' ? options.version(version) : undefined;
  const hooks = {
    discover: async (options?: DiscoverOptions) => {
      seen.push(probe(options, '2.0.6'));
      return undefined; // nothing running: the SDK must start one
    },
    ensure: async (options?: EnsureOptions) => {
      seen.push(probe(options, '2.0.10'));
      seen.push(probe(options, '2.0.10'));
      return endpoint;
    },
  };
  await connectOpenCode({ lifecycle: 'ensure' }, {}, hooks, log as never);
  assert.deepEqual(seen, [true, true, true], 'every version is accepted, whatever it is');
  const versions = infos.filter(entry => (entry as [string])[0] === 'opencode.version');
  assert.deepEqual(
    versions.map(entry => (entry as [string, { server: string }])[1].server),
    ['2.0.6', '2.0.10'],
    'each server version logged once; the repeat is silent',
  );
});

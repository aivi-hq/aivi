/** How aivi finds, reaches and restarts OpenCode, with the machine behind it
 *  replaced: the service file sits in a temp directory the environment points
 *  at, the network answers from a script, and nothing here can start or stop
 *  a real service. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os, { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { connectOpenCode, discoverTolerant, restartOpenCode } from '../src/opencode.ts';
import { recorder } from './support.ts';

const URL_FILED = 'http://127.0.0.1:7777';
const basic = `Basic ${Buffer.from('opencode:pw').toString('base64')}`;

/** A temp directory standing for the machine's state directory; `XDG_STATE_HOME` points at it until the test ends. */
async function stateDirectory(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'aivi-opencode-'));
  const previous = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = root;
  t.after(async () => {
    if (previous === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = previous;
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(join(root, 'opencode'), { recursive: true });
  return { root, file: join(root, 'opencode', 'service.json') };
}

/** The network: every `fetch` is recorded with the credentials it carried and answered by `answer`. */
function network(t: TestContext, answer: (url: string) => Response) {
  const calls: { url: string; authorization: string | null }[] = [];
  t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, authorization: new Headers(init?.headers).get('authorization') });
    return answer(url);
  });
  return calls;
}

const session = () => Response.json({ data: { id: 'ses_1', agent: 'assistant', location: { directory: '/team' } } });
const refused = () => {
  throw new Error('connect ECONNREFUSED');
};

test('discovery reads the registration under the state directory and falls back to the next probe path', async t => {
  const state = await stateDirectory(t);
  await writeFile(state.file, JSON.stringify({ url: URL_FILED, password: 'pw', version: '2.0.10' }));
  const calls = network(t, url => (url.endsWith('/api/info') ? refused() : Response.json({ version: '9.9.9' })));
  assert.deepEqual(await discoverTolerant(), {
    url: URL_FILED,
    auth: { type: 'basic', username: 'opencode', password: 'pw' },
    version: '9.9.9',
  });
  assert.deepEqual(calls, [
    { url: `${URL_FILED}/api/info`, authorization: basic },
    { url: `${URL_FILED}/api/status`, authorization: basic },
  ]);
});

test('without XDG_STATE_HOME the registration is looked for under the home directory', async t => {
  const home = await mkdtemp(join(tmpdir(), 'aivi-opencode-home-'));
  const previous = process.env.XDG_STATE_HOME;
  delete process.env.XDG_STATE_HOME;
  const homedir = t.mock.method(os, 'homedir', () => home);
  syncBuiltinESMExports();
  t.after(async () => {
    homedir.mock.restore();
    syncBuiltinESMExports();
    if (previous !== undefined) process.env.XDG_STATE_HOME = previous;
    await rm(home, { recursive: true, force: true });
  });
  await mkdir(join(home, '.local', 'state', 'opencode'), { recursive: true });
  await writeFile(join(home, '.local', 'state', 'opencode', 'service.json'), JSON.stringify({ url: URL_FILED }));
  network(t, () => Response.json({}));
  assert.deepEqual(await discoverTolerant(), { url: URL_FILED });
});

test('a registration that is missing or cannot be read means nothing is running, and nobody is asked', async t => {
  const state = await stateDirectory(t);
  const calls = network(t, () => Response.json({}));
  assert.equal(await discoverTolerant(), undefined, 'no file');
  await writeFile(state.file, '{ not json');
  assert.equal(await discoverTolerant(), undefined, 'a file that is not JSON');
  assert.deepEqual(calls, []);
});

const registered = { url: URL_FILED, password: 'pw', version: '2.0.10' };
const filed = { url: URL_FILED, auth: { type: 'basic', username: 'opencode', password: 'pw' } };
const probes: [string, Record<string, string>, () => Response, unknown][] = [
  [
    'the version the server reports',
    registered,
    () => Response.json({ version: '9.9.9' }),
    { ...filed, version: '9.9.9' },
  ],
  [
    'the registered version when the server says none',
    registered,
    () => new Response(null, { status: 401 }),
    { ...filed, version: '2.0.10' },
  ],
  [
    'the registered version when the server reports no text',
    registered,
    () => Response.json({ version: 9 }),
    { ...filed, version: '2.0.10' },
  ],
  [
    'no credentials and no version when none were filed or reported',
    { url: URL_FILED },
    () => Response.json({}),
    { url: URL_FILED },
  ],
];
for (const [name, registration, answer, expected] of probes)
  test(`a server that answers is alive, reported with ${name}`, async t => {
    const state = await stateDirectory(t);
    await writeFile(state.file, JSON.stringify(registration));
    network(t, answer);
    assert.deepEqual(await discoverTolerant({ file: state.file }), expected);
  });

test('a server that answers on neither probe path is not running', async t => {
  const state = await stateDirectory(t);
  await writeFile(state.file, JSON.stringify(registered));
  const calls = network(t, refused);
  assert.equal(await discoverTolerant({ file: state.file }), undefined);
  assert.deepEqual(
    calls.map(call => call.url),
    [`${URL_FILED}/api/info`, `${URL_FILED}/api/status`],
  );
});

test('the version of the server is logged when it changes, never twice in a row, never when it is unknown', async () => {
  const { log, said } = recorder();
  for (const version of ['7.1.0', '7.1.0', undefined, '7.2.0'])
    await connectOpenCode(
      { lifecycle: 'discover' },
      {},
      { discover: async () => ({ url: URL_FILED, ...(version ? { version } : {}) }) },
      log,
    );
  assert.deepEqual(
    said('info').map(line => [line.event, line.server]),
    [
      ['opencode.version', '7.1.0'],
      ['opencode.version', '7.2.0'],
    ],
  );
});

test('the default discovery connects to the service that is filed, with the credentials it filed', async t => {
  const state = await stateDirectory(t);
  await writeFile(state.file, JSON.stringify({ url: URL_FILED, password: 'pw' }));
  const calls = network(t, url => (url.includes('/api/session/') ? session() : Response.json({})));
  const client = await connectOpenCode({ lifecycle: 'discover' });
  await client.session.get({ sessionID: 'ses_1' });
  assert.deepEqual(calls.at(-1), { url: `${URL_FILED}/api/session/ses_1`, authorization: basic });
});

test('a service that filed no credentials is called without any', async t => {
  const calls = network(t, session);
  const client = await connectOpenCode({ lifecycle: 'discover' }, {}, { discover: async () => ({ url: URL_FILED }) });
  await client.session.get({ sessionID: 'ses_1' });
  assert.deepEqual(calls, [{ url: `${URL_FILED}/api/session/ses_1`, authorization: null }]);
});

test('with nothing filed, the default discovery finds nothing and the "discover" lifecycle starts nothing', async t => {
  await stateDirectory(t);
  const calls = network(t, () => Response.json({}));
  await assert.rejects(connectOpenCode({ lifecycle: 'discover' }), /No running OpenCode v2 service found/);
  assert.deepEqual(calls, []);
});

test('a restart does not repeat the start it just announced, and without a service to replace it does nothing', async t => {
  const endpoint = { url: URL_FILED };
  const events: string[] = [];
  const hooks = {
    discover: async () => endpoint,
    stop: async (options?: { pty?: string }) => {
      events.push(`stop:${options?.pty}`);
    },
    ensure: async (options?: { onStart?: (reason: 'missing') => void }) => {
      options?.onStart?.('missing');
      events.push('ensure');
      return endpoint;
    },
    onStart: (reason: string) => events.push(`announced:${reason}`),
  };
  assert.equal(await restartOpenCode({ lifecycle: 'own' }, hooks), true);
  assert.deepEqual(events, ['announced:restart', 'stop:handoff', 'ensure']);

  await stateDirectory(t);
  const calls = network(t, () => Response.json({}));
  assert.equal(await restartOpenCode({ lifecycle: 'own' }), false, 'nothing filed: nothing to replace');
  assert.deepEqual(calls, []);
});

test('a configured url is used as it is, with the credentials from the environment, and nothing is discovered', async t => {
  const calls = network(t, session);
  const never = async () => {
    throw new Error('discovery must not run');
  };
  const hooks = { discover: never, ensure: never };
  const config = { url: 'http://127.0.0.1:9', lifecycle: 'own' } as const;
  const bob = await connectOpenCode(config, { OPENCODE_USERNAME: 'bob', OPENCODE_PASSWORD: 'pw' }, hooks);
  await bob.session.get({ sessionID: 'ses_1' });
  const named = await connectOpenCode(config, { OPENCODE_PASSWORD: 'pw' }, hooks);
  await named.session.get({ sessionID: 'ses_1' });
  const open = await connectOpenCode(config, {}, hooks);
  await open.session.get({ sessionID: 'ses_1' });
  assert.deepEqual(
    calls.map(call => call.authorization),
    [`Basic ${Buffer.from('bob:pw').toString('base64')}`, basic, null],
    'the user defaults to "opencode"; no password, no credentials',
  );
});

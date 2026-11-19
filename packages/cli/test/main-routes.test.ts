/** `aivi` as a router: what each command is handed, how the verbs of `service` are dispatched, which commands mount
 *  the installed app, and how a failed mount reads in the help. The commands, the service and the app's mount are
 *  mocks; the home and the client record are scratch. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, mock, type TestContext, test } from 'node:test';
import { setEnv } from './process-fixture.ts';

const realAdd = await import('../src/add.ts');
const realLink = await import('../src/link.ts');
const realMount = await import('../src/mount.ts');
const realRemove = await import('../src/remove.ts');
const realService = await import('../src/service.ts');
const realSetup = await import('../src/setup.ts');
const realUpdate = await import('../src/update.ts');

const command = () => mock.fn(async (..._args: unknown[]) => {});
const add = command();
const remove = command();
const updateServer = command();
const link = command();
const setup = command();
const mountAppCommands = command();
const verb = () => mock.fn((..._args: unknown[]) => {});
const service = {
  serviceInstall: verb(),
  serviceUninstall: verb(),
  serviceStart: verb(),
  serviceStop: verb(),
  serviceRestart: verb(),
  serviceStatus: verb(),
  serviceLogs: verb(),
};
const everyMock = [add, remove, updateServer, link, setup, mountAppCommands, ...Object.values(service)];
mock.module('../src/add.ts', { exports: { ...realAdd, add } });
mock.module('../src/link.ts', { exports: { ...realLink, link } });
mock.module('../src/mount.ts', { exports: { ...realMount, mountAppCommands } });
mock.module('../src/remove.ts', { exports: { ...realRemove, remove } });
mock.module('../src/service.ts', { exports: { ...realService, ...service } });
mock.module('../src/setup.ts', { exports: { ...realSetup, setup } });
mock.module('../src/update.ts', { exports: { ...realUpdate, updateServer } });
const { main } = await import('../src/main.ts');

let directory: string;
let home: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'aivi-routes-test-'));
  home = join(directory, 'home');
  for (const fn of everyMock) fn.mock.resetCalls();
});
afterEach(() => {
  process.exitCode = undefined;
  rmSync(directory, { recursive: true, force: true });
});

/** This machine has a home, is not driven remotely, and keeps its client record in a scratch file; the file is returned. */
function machine(t: TestContext): string {
  const file = join(directory, 'client.json');
  setEnv(t, 'AIVI_CONFIG', file);
  setEnv(t, 'AIVI_HOME', home);
  setEnv(t, 'AIVI_EXEC_SESSION', undefined);
  return file;
}

/** commander writes to the real streams; this test reads them. */
async function run(argv: string[]): Promise<{ out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const real = { out: process.stdout.write.bind(process.stdout), err: process.stderr.write.bind(process.stderr) };
  process.stdout.write = ((chunk: string | Uint8Array): boolean => {
    out.push(String(chunk));
    return true;
  }) as never;
  process.stderr.write = ((chunk: string | Uint8Array): boolean => {
    err.push(String(chunk));
    return true;
  }) as never;
  try {
    await main(argv);
  } finally {
    process.stdout.write = real.out;
    process.stderr.write = real.err;
  }
  return { out: out.join(''), err: err.join('') };
}

test('add, remove and update are handed the home, the app dir and the Node this machine records', async t => {
  const file = machine(t);
  const machines: [string, Record<string, unknown> | undefined, { appDir: string; nodePath: string }][] = [
    ['no client record', undefined, { appDir: join(home, 'app'), nodePath: process.execPath }],
    [
      'a record that names an app dir and a Node',
      { configVersion: 1, appDir: '/custom/app', nodePath: '/managed/node' },
      { appDir: '/custom/app', nodePath: '/managed/node' },
    ],
  ];

  for (const [what, record, expected] of machines) {
    if (record === undefined) rmSync(file, { force: true });
    else writeFileSync(file, JSON.stringify(record));
    await main(['add', 'discord']);
    await main(['remove', 'discord']);
    await main(['update']);

    assert.deepEqual(add.mock.calls.at(-1)!.arguments, [['discord'], { home, ...expected }], what);
    assert.deepEqual(remove.mock.calls.at(-1)!.arguments, [['discord'], { home, ...expected }], what);
    assert.deepEqual(updateServer.mock.calls.at(-1)!.arguments, [{ home, ...expected }], what);
  }
});

test('link is handed its arguments and setup its arguments and the home it would create', async t => {
  machine(t);

  await main(['link', 'slack']);
  await main(['setup', '--use=another']);

  assert.deepEqual(link.mock.calls[0]!.arguments, [['slack']]);
  assert.deepEqual(setup.mock.calls[0]!.arguments, [['--use=another'], { home }]);
});

test('each verb of service reaches its own function, and any other word is said with the whole list', async t => {
  const file = machine(t);
  const nodePath = process.execPath;
  const verbs: [string, ReturnType<typeof verb>, unknown[]][] = [
    ['install', service.serviceInstall, [{ home, appDir: join(home, 'app'), nodePath }]],
    ['uninstall', service.serviceUninstall, []],
    ['start', service.serviceStart, []],
    ['stop', service.serviceStop, []],
    ['restart', service.serviceRestart, []],
    ['status', service.serviceStatus, []],
    ['logs', service.serviceLogs, [home]],
  ];

  for (const [name, called, args] of verbs) {
    await main(['service', name]);
    assert.deepEqual(called.mock.calls.at(-1)?.arguments, args, name);
  }
  const unknown = {
    message: 'Unknown service command. One of: install, uninstall, start, stop, restart, status, logs',
  };
  await assert.rejects(main(['service', 'frobnicate']), unknown);
  await assert.rejects(main(['service']), unknown);

  writeFileSync(file, JSON.stringify({ configVersion: 1, appDir: '/custom/app', nodePath: '/managed/node' }));
  await main(['service', 'install']);
  assert.deepEqual(service.serviceInstall.mock.calls.at(-1)?.arguments, [
    { home, appDir: '/custom/app', nodePath: '/managed/node' },
  ]);
});

test('server create points at setup, and any other server command is left to the installed app', async t => {
  machine(t);
  await assert.rejects(main(['server', 'create']), {
    message: '`server create` is now part of `aivi setup`. Run: aivi setup',
  });

  const { err } = await run(['server', 'list']);

  assert.equal(mountAppCommands.mock.callCount(), 1, 'the app is asked for the command');
  assert.match(err, /unknown command 'server'/, 'and with nothing mounted, the word is unknown');
});

test('only a request that is not a machine command mounts the installed app', async t => {
  machine(t);
  const requests: [string[], number][] = [
    [['add', 'discord'], 0],
    [['service', 'status'], 0],
    [['--version'], 0],
    [['status'], 1],
  ];

  for (const [argv, mounted] of requests) {
    mountAppCommands.mock.resetCalls();
    await run(argv);
    assert.equal(mountAppCommands.mock.callCount(), mounted, argv.join(' '));
  }
});

test('a help page whose app cannot be mounted says why, whether the reason is an Error or not', async t => {
  machine(t);
  const reasons: [() => Promise<void>, RegExp][] = [
    [
      async () => {
        throw new Error('No aivi server installed at the app dir.');
      },
      /App commands unavailable: No aivi server installed at the app dir\./,
    ],
    [() => Promise.reject('the app is gone'), /App commands unavailable: the app is gone/],
  ];

  for (const [reason, footer] of reasons) {
    mountAppCommands.mock.mockImplementationOnce(reason);
    const { out } = await run(['--help']);
    assert.match(out, footer);
  }
});

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { machineStatus } from '../src/home.ts';
import { main } from '../src/main.ts';

/** Point the client record at a scratch file (or nowhere) for one test, and
 *  say whether this process is the far end of an exec session. */
const machine = async (
  t: TestContext,
  config: Record<string, unknown> | undefined,
  options: { remote?: boolean } = {},
) => {
  const directory = await mkdtemp(join(tmpdir(), 'aivi-state-'));
  const file = join(directory, 'aivi.json');
  if (config !== undefined) await writeFile(file, JSON.stringify(config));
  const env = { config: process.env.AIVI_CONFIG, home: process.env.AIVI_HOME, session: process.env.AIVI_EXEC_SESSION };
  const exitCode = process.exitCode;
  process.env.AIVI_CONFIG = file;
  delete process.env.AIVI_HOME;
  if (options.remote === true) process.env.AIVI_EXEC_SESSION = '1';
  else delete process.env.AIVI_EXEC_SESSION;
  t.after(() => {
    if (env.config === undefined) delete process.env.AIVI_CONFIG;
    else process.env.AIVI_CONFIG = env.config;
    if (env.home !== undefined) process.env.AIVI_HOME = env.home;
    if (env.session !== undefined) process.env.AIVI_EXEC_SESSION = env.session;
    else delete process.env.AIVI_EXEC_SESSION;
    process.exitCode = exitCode;
    return rm(directory, { recursive: true, force: true });
  });
  return directory;
};

/** commander writes to the real streams; this test reads them. */
const run = async (argv: string[]): Promise<{ out: string; err: string }> => {
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
};

test('the machine facts: home, the client record, and the driven session', async t => {
  await machine(t, undefined); // no client record at all: nothing to configure
  assert.deepEqual(machineStatus(), {});

  const directory = await machine(t, { configVersion: 1 }); // a record that names no home
  assert.deepEqual(machineStatus(), { clientConfig: join(directory, 'aivi.json') });

  await machine(t, { configVersion: 1, home: '/somewhere' });
  assert.equal(machineStatus().home, '/somewhere');

  process.env.AIVI_HOME = '/scratch'; // the dev override leads, as it always has
  assert.equal(machineStatus().home, '/scratch');
  delete process.env.AIVI_HOME;

  const driven = await machine(t, { configVersion: 1 }, { remote: true }); // the exec door's child
  assert.deepEqual(machineStatus(), {
    clientConfig: join(driven, 'aivi.json'),
    remote: true,
  });
});

test('a machine without a home is shown what it can do there', async t => {
  await machine(t, undefined);
  const { out } = await run(['--help']);
  assert.match(out, /home: none/, 'the header states the machine fact');
  assert.match(out, /setup \[args\.\.\.\]/, 'setup is taught');
  assert.match(out, /upgrade/, 'upgrade is taught');
  assert.match(out, /uninstall \[options\]/, 'the exit ramp exists wherever the CLI is');
  assert.match(out, /No server here: `aivi setup`/, 'the footer says what to do');
  assert.doesNotMatch(out, /add \[args\.\.\.\]/, 'a machine without a home is not invited to add');
  assert.doesNotMatch(out, /service \[verb\]/, 'nor to service');
  assert.doesNotMatch(out, /link \[args\.\.\.\]/, 'nor to mint a link code');
  assert.doesNotMatch(out, /status/, 'no app commands are claimed');
});

test('a command a homeless machine does not have is honestly unknown', async t => {
  await machine(t, undefined);
  const { err } = await run(['add', 'slack']);
  assert.match(err, /unknown command 'add'/, 'no bolt-on answer: the command is not here');
});

test('a machine with a home sees the whole tree and its home in the header', async t => {
  await machine(t, { configVersion: 1, home: '/no/such/home' });
  const { out } = await run(['--help']);
  assert.ok(out.includes('home: /no/such/home'), 'the header names the home');
  assert.match(out, /add \[args\.\.\.\]/, 'a machine with a home sees the plugin commands');
  assert.match(out, /service \[verb\]/, 'and the service commands');
  assert.match(out, /uninstall \[options\]/, 'and the exit ramp');
  assert.match(out, /App commands unavailable: No aivi server installed at/, 'the footer names the real gap');
});

// The client-side set answers the channel itself (decision D23): a driven
// session runs these same commands and must refuse, never act on the server.
test('a driven session refuses the commands that act on the machine you type on', async t => {
  await machine(t, { configVersion: 1, home: '/no/such/home' }, { remote: true });
  for (const argv of [['setup'], ['upgrade']]) {
    await assert.rejects(() => run(argv), { message: 'this acts on the machine you type on' }, `${argv} answered`);
  }
});

test('a driven session refuses to uninstall the home it is driving', async t => {
  await machine(t, { configVersion: 1, home: '/no/such/home' }, { remote: true });
  await assert.rejects(() => run(['uninstall']), {
    message: 'uninstall deletes the home this session drives; run it on the machine itself',
  });
});

test('remote exec does not chain a second hop', async t => {
  await machine(t, { configVersion: 1 }, { remote: true });
  await assert.rejects(() => run(['-r', 'status']), {
    message: 'remote exec does not chain: this session is already driven remotely',
  });
});

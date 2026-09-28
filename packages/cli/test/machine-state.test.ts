import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { machineStatus } from '../src/home.ts';
import { main } from '../src/main.ts';

/** Point the client record at a scratch file (or nowhere) for one test. */
const machine = async (t: TestContext, config: Record<string, unknown> | undefined) => {
  const directory = await mkdtemp(join(tmpdir(), 'aivi-state-'));
  const file = join(directory, 'aivi.json');
  if (config !== undefined) await writeFile(file, JSON.stringify(config));
  const env = { config: process.env.AIVI_CONFIG, home: process.env.AIVI_HOME };
  const exitCode = process.exitCode;
  process.env.AIVI_CONFIG = file;
  delete process.env.AIVI_HOME;
  t.after(() => {
    if (env.config === undefined) delete process.env.AIVI_CONFIG;
    else process.env.AIVI_CONFIG = env.config;
    if (env.home !== undefined) process.env.AIVI_HOME = env.home;
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

test('the machine fact is the two sources: AIVI_HOME leads, the record follows, nothing else', async t => {
  await machine(t, undefined); // no client record at all
  assert.deepEqual(machineStatus(), {});
  await machine(t, { configVersion: 1 }); // a record that names no home
  assert.deepEqual(machineStatus(), {});
  await machine(t, { configVersion: 1, home: '/somewhere' });
  assert.deepEqual(machineStatus(), { home: '/somewhere' });
  process.env.AIVI_HOME = '/scratch'; // the dev override leads, as it always has
  assert.deepEqual(machineStatus(), { home: '/scratch' });
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

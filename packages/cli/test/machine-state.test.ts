import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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

test('a driven session help page says whose tree it is', async t => {
  await machine(t, { configVersion: 1, home: '/no/such/home' }, { remote: true });
  const { out } = await run(['--help']);
  assert.match(out, /aivi v\d+\.\d+\.\d+ \(remote\) —/, 'the title carries (remote)');
});

test('a local page carries no marker', async t => {
  await machine(t, { configVersion: 1, home: '/no/such/home' });
  const { out } = await run(['--help']);
  assert.doesNotMatch(out, /\(remote\)/, 'the word is only for driven sessions');
});

// `configure` — the second writer of the client record. Its membership is
// the record's *existence*, not its parseability, and it is a client-side
// command: it edits the file where it is typed, never through the channel.
test('a machine with a record gets configure; a machine with none does not know the word', async t => {
  await machine(t, { configVersion: 1, url: 'http://127.0.0.1:4100' });
  const { out } = await run(['--help']);
  assert.match(out, /configure \[options\]/, 'a laptop with a record but no home is taught configure');
});

test('a machine with no record gets setup, which creates the first one', async t => {
  await machine(t, undefined);
  const { out } = await run(['--help']);
  assert.doesNotMatch(out, /configure \[options\]/, 'nothing to edit is nothing to list');
  assert.match(out, /setup \[args\.\.\.\]/);
  const { err } = await run(['configure', '--url', 'http://127.0.0.1:4100']);
  assert.match(err, /unknown command 'configure'/, 'the command is not here, and the answer is honest');
});

test('configure edits the record and the signed-in person stays', async t => {
  const directory = await machine(t, {
    configVersion: 1,
    url: 'http://127.0.0.1:4100',
    person: { token: 'audit-evidence', name: 'Ada', roles: ['operator'] },
  });
  const { out } = await run(['configure', '--url', 'http://127.0.0.1:5111', '--home', directory]);
  const record = JSON.parse(await readFile(process.env.AIVI_CONFIG!, 'utf8')) as Record<string, any>;
  assert.equal(record.url, 'http://127.0.0.1:5111', 'the host moved');
  assert.equal(record.home, directory, 'the home landed as an absolute path');
  assert.equal(record.person.token, 'audit-evidence', 'audit history is not a laptop command to erase');
  assert.match(out, /host: {4}http:\/\/127\.0\.0\.1:5111/);
  assert.doesNotMatch(out, /audit-evidence/, 'the view says that someone signs in, never with what');
  assert.match(out, /person: {2}Ada/, 'the person is shown by name');
});

test('a broken record is exactly what configure is for', async t => {
  const directory = await machine(t, undefined);
  await writeFile(process.env.AIVI_CONFIG!, '{ oops — not even json');
  const { out } = await run(['configure', '--home', directory]);
  const record = JSON.parse(await readFile(process.env.AIVI_CONFIG!, 'utf8')) as Record<string, unknown>;
  assert.equal(record.configVersion, 1, 'the record the command writes loads again');
  assert.equal(record.home, directory);
  assert.match(out, /did not parse; writing it fresh/);
});

test('a person block survives the rescue only when its token survives', async t => {
  await machine(t, undefined);
  await writeFile(process.env.AIVI_CONFIG!, JSON.stringify({ configVersion: 1, url: 42, person: { name: 'Ada' } }));
  await run(['configure', '--url', 'http://127.0.0.1:4100']);
  const record = JSON.parse(await readFile(process.env.AIVI_CONFIG!, 'utf8')) as Record<string, unknown>;
  assert.equal(record.url, 'http://127.0.0.1:4100', 'the bad typed field gave way to the edit');
  assert.equal(record.person, undefined, 'a person without a token is nobody; the command never invents evidence');
});

test('a plain configure shows the record and writes nothing', async t => {
  const broken = '{ oops';
  await machine(t, undefined);
  await writeFile(process.env.AIVI_CONFIG!, broken);
  await assert.rejects(() => run(['configure']), {
    message: /does not load; .* writes it fresh around whatever survives/,
  });
  assert.equal(await readFile(process.env.AIVI_CONFIG!, 'utf8'), broken, 'showing a record is no reason to rewrite it');
});

test('configure answers honest failures and touches nothing on a bad edit', async t => {
  await machine(t, { configVersion: 1, url: 'http://127.0.0.1:4100' });
  const before = await readFile(process.env.AIVI_CONFIG!, 'utf8');
  await assert.rejects(() => run(['configure', '--url', 'not-a-url']), { message: 'not a URL: not-a-url' });
  await assert.rejects(() => run(['configure', '--home', '/no/such/home']), {
    message: 'no home directory at /no/such/home',
  });
  assert.equal(await readFile(process.env.AIVI_CONFIG!, 'utf8'), before, 'a refused edit wrote nothing');
});

test('a driven session refuses configure like the rest of the client-side set', async t => {
  await machine(t, { configVersion: 1, url: 'http://127.0.0.1:4100' }, { remote: true });
  await assert.rejects(() => run(['configure', '--url', 'http://127.0.0.1:9999']), {
    message: 'this acts on the machine you type on',
  });
});

test('the relay signs with the record, so a broken one fails it by name', async t => {
  await machine(t, undefined);
  await writeFile(process.env.AIVI_CONFIG!, 'not json at all');
  await assert.rejects(() => run(['-r', 'status']), {
    message: /the client record at .* does not load; `aivi configure` edits it, `aivi setup` signs in again/,
  });
});

test('a broken record does not block the exit ramp', async t => {
  const directory = await machine(t, undefined);
  await writeFile(process.env.AIVI_CONFIG!, 'not json at all');
  // A home uninstall will accept: refuseWrongHome wants a config.json there,
  // which is the promise of uninstall, not an obstacle for this test.
  await writeFile(join(directory, 'config.json'), JSON.stringify({ version: 1 }));
  process.env.AIVI_HOME = directory;
  const { out } = await run(['uninstall']);
  assert.match(out, /aivi\.json/, 'the listing names the record it would delete');
  assert.doesNotMatch(out, /not json/, 'the broken bytes are not the answer; the listing is');
});

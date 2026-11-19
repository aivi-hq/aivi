/** The identity step as a unit: what it asks, in which order, what it makes
 *  and returns for each answer, and how the client config it signs in with
 *  is written and read. The prompts, core's installers and config loader and
 *  the store are module mocks; the scratch home and the client-config file
 *  (named by a mocked `clientConfigPath`) are real files in a temp directory. */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, mock, type TestContext, test } from 'node:test';
import { keepExitCode, loadedWith, scratchDir, terminal } from './apicli-fixture.ts';

const cancelled = Symbol('cancelled');
const world = { clientConfig: '' };
const intro = mock.fn();
const outro = mock.fn();
const cancel = mock.fn();
const select = mock.fn(async (_options: unknown): Promise<unknown> => 'this-machine');
const text = mock.fn(async (_options: unknown): Promise<unknown> => 'Ada');
const installPrompts = mock.fn(async (_home: string) => ({ written: [], kept: [] }));
const installFace = mock.fn(async (_home: string) => ({ written: true, kept: false }));
const loadConfig = mock.fn(async (_configPath: string) => loadedWith({ stateDirectory: 'state' }));
const writeConfigBlock = mock.fn(async (..._args: unknown[]) => {});
const opened = mock.fn((_path: string) => {});
const createPerson = mock.fn((input: { name: string }) => ({ id: 'person-1', name: input.name }));
const mintToken = mock.fn((_person: string, _label: string) => ({ secret: 'aivi-secret' }));
const close = mock.fn();

class Store {
  constructor(path: string) {
    opened(path);
  }
  people() {
    return [];
  }
  createPerson = createPerson;
  mintToken = mintToken;
  close = close;
}

mock.module('@clack/prompts', {
  exports: { intro, outro, cancel, select, text, isCancel: (answer: unknown) => answer === cancelled },
});
const core = await import('@aivi/core');
mock.module('@aivi/core', {
  exports: {
    ...core,
    clientConfigPath: () => world.clientConfig,
    installFace,
    installPrompts,
    loadConfig,
    writeConfigBlock,
  },
});
const host = await import('@aivi/host');
mock.module('@aivi/host', { exports: { ...host, Store } });

const { readClientConfigToken, serverCreate } = await import('../src/cli/identity.ts');

beforeEach(() => {
  for (const spy of [
    intro,
    outro,
    cancel,
    select,
    text,
    installPrompts,
    installFace,
    loadConfig,
    opened,
    createPerson,
    mintToken,
    close,
  ])
    spy.mock.resetCalls();
  select.mock.mockImplementation(async () => 'this-machine');
  text.mock.mockImplementation(async () => 'Ada');
});

/** A scratch home and client-config path, a terminal attached or not, the exit code kept for the end. */
async function scratch(t: TestContext, attached = true) {
  const dir = await scratchDir(t, 'aivi-identity-');
  const home = join(dir, 'home');
  world.clientConfig = join(dir, 'client', 'config.json');
  terminal(t, attached);
  keepExitCode(t);
  const configPath = join(home, 'config.json');
  return { home, configPath, options: { home, configPath }, clientConfig: world.clientConfig };
}

test('with no flags it asks where and who before it makes anything, and says where to take the token', async t => {
  const { home, configPath, options, clientConfig } = await scratch(t);
  const asked: string[] = [];
  select.mock.mockImplementation(async () => {
    asked.push(existsSync(home) ? 'home exists' : 'no home yet');
    return 'another';
  });
  text.mock.mockImplementation(async () => ' Ada ');

  const result = await serverCreate(options);

  assert.deepEqual(asked, ['no home yet']);
  assert.deepEqual(intro.mock.calls[0]!.arguments, ['aivi setup — identity']);
  assert.deepEqual(
    (select.mock.calls[0]!.arguments[0] as { options: { value: string }[] }).options.map(option => option.value),
    ['this-machine', 'another'],
  );
  assert.deepEqual(text.mock.calls[0]!.arguments, [
    { message: 'Your name — aivi associates records with it', placeholder: 'Operator' },
  ]);
  assert.deepEqual(createPerson.mock.calls[0]!.arguments, [{ name: 'Ada', roles: ['operator'] }]);
  assert.deepEqual(mintToken.mock.calls[0]!.arguments, ['person-1', 'operator']);
  assert.deepEqual([installPrompts.mock.calls[0]!.arguments, installFace.mock.calls[0]!.arguments], [[home], [home]]);
  assert.equal(readFileSync(configPath, 'utf8'), '{\n  "version": 1\n}\n');
  assert.equal(close.mock.callCount(), 1);
  assert.deepEqual(outro.mock.calls[0]!.arguments, [`Home ready at ${home}; take the token to your laptop.`]);
  assert.equal(existsSync(clientConfig), false, 'nothing signs in on this machine');
  assert.deepEqual(result, {
    home,
    url: 'http://127.0.0.1:4100',
    person: 'person-1',
    name: 'Ada',
    token: 'aivi-secret',
    urlNote: `http://127.0.0.1:4100 answers on this machine only. Once a funnel or tunnel exists, store its URL as host.public in ${configPath} — webhook platforms need it.`,
    next: 'Install aivi on the other machine (`npm install -g @aivi/cli`), run `aivi setup` there, choose "Connect to a host", and paste this url and token.',
  });
});

test('for this machine a blank name is Operator, and the client config signs the new token in, private to its owner', async t => {
  const { home, options, clientConfig } = await scratch(t);
  text.mock.mockImplementation(async () => '   ');

  const result = await serverCreate(options);

  assert.deepEqual(createPerson.mock.calls[0]!.arguments, [{ name: 'Operator', roles: ['operator'] }]);
  assert.deepEqual(JSON.parse(readFileSync(clientConfig, 'utf8')), {
    configVersion: 1,
    url: 'http://127.0.0.1:4100',
    home,
    person: { token: 'aivi-secret' },
  });
  assert.equal(statSync(clientConfig).mode & 0o777, 0o600);
  assert.equal(result.clientConfig, clientConfig);
  assert.deepEqual(outro.mock.calls[0]!.arguments, [`Home ready at ${home}; client config written.`]);
});

test('a cancel at either question stops with nothing created and a failed exit', async t => {
  const { home, options } = await scratch(t);
  select.mock.mockImplementationOnce(async () => cancelled);
  assert.deepEqual(await serverCreate(options), {});
  assert.deepEqual(cancel.mock.calls[0]!.arguments, ['Setup stopped: no answer. Nothing was created.']);
  assert.equal(process.exitCode, 1);

  process.exitCode = undefined;
  text.mock.mockImplementationOnce(async () => cancelled);
  assert.deepEqual(await serverCreate(options), {});
  assert.deepEqual(cancel.mock.calls[1]!.arguments, ['Setup stopped: no name. Nothing was created.']);
  assert.equal(process.exitCode, 1);

  assert.equal(existsSync(home), false, 'the home was never made');
  assert.equal(createPerson.mock.callCount() + installPrompts.mock.callCount() + opened.mock.callCount(), 0);
  assert.equal(outro.mock.callCount(), 0);
});

test('a client config that already signs a person in is never overwritten; one that does not is extended', async t => {
  const { options, clientConfig } = await scratch(t, false);
  mkdirSync(join(clientConfig, '..'), { recursive: true });
  writeFileSync(clientConfig, JSON.stringify({ configVersion: 1, person: { token: 'aivi-mine' } }));
  await assert.rejects(
    serverCreate({ ...options, use: 'this-machine', name: 'Ada' }),
    new Error(`${clientConfig} already signs a person in; delete or edit it before signing in here`),
  );
  assert.equal(JSON.parse(readFileSync(clientConfig, 'utf8')).person.token, 'aivi-mine');

  writeFileSync(clientConfig, JSON.stringify({ configVersion: 1, install: 'npm' }));
  await serverCreate({ ...options, use: 'this-machine', name: 'Ada' });
  assert.deepEqual(JSON.parse(readFileSync(clientConfig, 'utf8')), {
    configVersion: 1,
    install: 'npm',
    url: 'http://127.0.0.1:4100',
    home: options.home,
    person: { token: 'aivi-secret' },
  });
  assert.equal(intro.mock.callCount(), 0, 'every answer was given as a flag: nothing is asked');
});

test('the operator token is read from the client config, and a machine that has none is simply anonymous', async t => {
  const { clientConfig } = await scratch(t);
  assert.equal(readClientConfigToken(), undefined, 'no file');
  mkdirSync(join(clientConfig, '..'), { recursive: true });
  writeFileSync(clientConfig, JSON.stringify({ configVersion: 1, url: 'http://host.test' }));
  assert.equal(readClientConfigToken(), undefined, 'no person signed in');
  writeFileSync(clientConfig, JSON.stringify({ configVersion: 1, person: { token: 'aivi-mine' } }));
  assert.equal(readClientConfigToken(), 'aivi-mine');
});

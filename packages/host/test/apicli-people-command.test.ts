/** The people commands as a unit: what each asks of the host as the operator
 *  who signed this machine in, what it prints, and when it offers a token.
 *  The home's context, the host client, the prompt and the client-config
 *  reader are module mocks; nothing here reaches a host or draws a prompt. */
import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import { loadedWith, parse, terminal } from './apicli-fixture.ts';

const cancelled = Symbol('cancelled');
const world = { loaded: loadedWith() };
const print = mock.fn();
const created = { id: 'person-1', name: 'Nemo' };
const createPerson = mock.fn(async (_input: unknown) => created);
const createPersonToken = mock.fn(async (_person: string, label: string) => ({
  token: { label },
  secret: 'aivi-secret',
}));
const people = mock.fn(async () => ['the people']);
const createHostClient = mock.fn((_url: string, _options: { token: string | undefined }) => ({
  createPerson,
  createPersonToken,
  people,
}));
const readClientConfigToken = mock.fn(() => 'operator-token');
const confirm = mock.fn(async (_options: unknown): Promise<boolean | symbol> => true);

mock.module('../src/cli/context.ts', {
  exports: { context: async () => ({ loaded: world.loaded }), hostUrl: () => 'http://host.test', print },
});
mock.module('@aivi/plugin/api', { exports: { createHostClient } });
mock.module('@clack/prompts', { exports: { confirm, isCancel: (answer: unknown) => answer === cancelled } });
mock.module('../src/cli/identity.ts', { exports: { readClientConfigToken } });

const { registerPeople } = await import('../src/cli/commands/people.ts');

beforeEach(() => {
  for (const spy of [print, createPerson, createPersonToken, people, createHostClient, readClientConfigToken, confirm])
    spy.mock.resetCalls();
  world.loaded = loadedWith();
});

const printed = () => print.mock.calls.map(call => call.arguments);

/** The line a minted token ends with: where to take it. */
const connectLine = (url: string) =>
  `Shown once. Take these to them — ${url} and this token. There: \`npm install -g @aivi/cli\`, run \`aivi setup\`, choose "Connect to a host", and paste both.`;

test('create makes the person as the signed-in operator and, with no terminal, offers nothing more', async t => {
  terminal(t, false);
  for (const [argv, input] of [
    [['Nemo'], { name: 'Nemo' }],
    [
      ['Nemo', '--email', 'nemo@example.com', '--role', 'operator'],
      { name: 'Nemo', email: 'nemo@example.com', roles: ['operator'] },
    ],
  ] as const) {
    createPerson.mock.resetCalls();
    await parse(registerPeople, 'people', 'create', ...argv);
    assert.deepEqual(createPerson.mock.calls[0]!.arguments, [input], argv.join(' '));
  }
  assert.deepEqual(createHostClient.mock.calls[0]!.arguments, ['http://host.test', { token: 'operator-token' }]);
  assert.deepEqual(printed(), [[created], [created]]);
  assert.equal(confirm.mock.callCount(), 0);
});

test('on a terminal create offers a token at once and mints it with the line that says where to take it', async t => {
  terminal(t, true);
  await parse(registerPeople, 'people', 'create', 'Nemo');
  assert.deepEqual(confirm.mock.calls[0]!.arguments, [{ message: 'Mint a token for Nemo now?', initialValue: true }]);
  assert.deepEqual(createPersonToken.mock.calls[0]!.arguments, ['person-1', 'cli']);
  assert.deepEqual(printed(), [
    [created],
    [
      {
        person: 'person-1',
        label: 'cli',
        token: 'aivi-secret',
        next: connectLine('url: http://127.0.0.1:4100 (host.public is unset, so that is the listen address)'),
      },
    ],
  ]);

  world.loaded = loadedWith({ host: { public: 'https://aivi.example.test' } });
  await parse(registerPeople, 'people', 'create', 'Nemo');
  assert.equal(
    (printed().at(-1)![0] as { next: string }).next,
    connectLine('url: https://aivi.example.test'),
    'a declared public address is stated as it is, with no caveat',
  );
});

test('a token that is declined or cancelled at the prompt is not minted', async t => {
  terminal(t, true);
  for (const answer of [false, cancelled]) {
    confirm.mock.mockImplementationOnce(async () => answer);
    await parse(registerPeople, 'people', 'create', 'Nemo');
  }
  assert.equal(confirm.mock.callCount(), 2);
  assert.equal(createPersonToken.mock.callCount(), 0);
  assert.deepEqual(printed(), [[created], [created]]);
});

test('list prints the people the host knows', async () => {
  await parse(registerPeople, 'people', 'list');
  assert.deepEqual(createHostClient.mock.calls[0]!.arguments, ['http://host.test', { token: 'operator-token' }]);
  assert.deepEqual(printed(), [[['the people']]]);
});

test('token mints a bearer for the named person, labelled cli unless told otherwise, and says where to take it', async () => {
  await parse(registerPeople, 'people', 'token', 'person-9');
  await parse(registerPeople, 'people', 'token', 'person-9', '--label', 'laptop');
  assert.deepEqual(
    createPersonToken.mock.calls.map(call => call.arguments),
    [
      ['person-9', 'cli'],
      ['person-9', 'laptop'],
    ],
  );
  const next = connectLine('url: http://127.0.0.1:4100 (host.public is unset, so that is the listen address)');
  assert.deepEqual(printed(), [
    [{ person: 'person-9', label: 'cli', token: 'aivi-secret', next }],
    [{ person: 'person-9', label: 'laptop', token: 'aivi-secret', next }],
  ]);
});

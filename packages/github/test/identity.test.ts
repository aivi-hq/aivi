/** The identity questions, once for both installers. Two failures this
 *  pins: a home that already holds the identity answers no question, and a
 *  typed `.pem` path is read from the directory the person typed it in, not
 *  from where npm moved the process. */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { GITHUB_APP_ID_ENV, GITHUB_PRIVATE_KEY_ENV } from '@aivi/github';
import { PluginSetupCancelled } from '@aivi/plugin';
import { appIdentity } from '../src/identity.ts';
import { privateKey } from './github-api.ts';

const cancelled = Symbol('cancelled');

/** The installer's two prompts, scripted; every note, question and written
 *  secret is on record. */
const installer = (answers: Record<string, string | symbol>) => {
  const asked: string[] = [];
  const notes: string[] = [];
  const secrets: [string, string][] = [];
  const validations: Array<(value: string | undefined) => string | undefined> = [];
  const prompts = {
    note: (body: string) => void notes.push(body),
    log: { message: async (line: string) => void asked.push(line) },
    text: async ({
      message,
      validate,
    }: {
      message: string;
      validate: (value: string | undefined) => string | undefined;
    }) => {
      asked.push(message);
      validations.push(validate);
      const answer = Object.entries(answers).find(([key]) => message.includes(key));
      if (!answer) throw new Error(`the installer asked "${message}"; the test scripted no answer`);
      return answer[1];
    },
    isCancel: (value: unknown) => value === cancelled,
  };
  const ctx = { prompts, writeSecret: async (name: string, value: string) => void secrets.push([name, value]) };
  return { ctx: ctx as never, asked, notes, secrets, validations };
};

const env = (t: TestContext, values: Record<string, string | undefined>) => {
  const had: Record<string, string | undefined> = {};
  const put = (name: string, value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  for (const [name, value] of Object.entries(values)) {
    had[name] = process.env[name];
    put(name, value);
  }
  t.after(() => {
    for (const [name, value] of Object.entries(had)) put(name, value);
  });
};

test('a home that holds the identity answers no question and writes no secret', async t => {
  env(t, { [GITHUB_APP_ID_ENV]: '7', [GITHUB_PRIVATE_KEY_ENV]: privateKey });
  const { ctx, asked, secrets } = installer({});
  const credentials = await appIdentity(ctx);
  assert.deepEqual(credentials, { appId: 7, privateKey }, 'the held bytes are the answer');
  assert.deepEqual(asked, ['The home already holds a GitHub app identity — the forge and the tracker are one app.']);
  assert.deepEqual(secrets, [], 'nothing is written twice');
});

test('a fresh home is guided once, and the typed .pem is read where it was typed', async t => {
  const typed = await mkdtemp(join(tmpdir(), 'aivi-typed-dir-'));
  t.after(() => rm(typed, { recursive: true, force: true }));
  await writeFile(join(typed, 'a.pem'), privateKey);
  env(t, { [GITHUB_APP_ID_ENV]: undefined, [GITHUB_PRIVATE_KEY_ENV]: undefined, INIT_CWD: typed });
  const { ctx, asked, notes, secrets, validations } = installer({ 'App ID': '5011508', '.pem': './a.pem' });
  const credentials = await appIdentity(ctx, {
    webhook: { url: 'https://example.ts.net/github/webhooks', events: 'Issue comment, Issues, and Projects v2 item' },
  });
  assert.deepEqual(credentials, { appId: 5011508, privateKey }, 'the file read from the typed directory is the key');
  assert.equal(asked.length, 2, 'two questions: the App ID and the .pem path');
  const guide = notes.join('\n');
  assert.match(guide, /Subscribe to events/, 'the guide names the section as GitHub spells it');
  assert.match(guide, /Contents: Read and write/, 'the permissions are the page’s own words');
  const firstQuestion = asked[0] ?? '';
  assert.ok(
    firstQuestion.includes('(step 5)'),
    `the question names the step the guide printed for it: ${firstQuestion}`,
  );
  assert.deepEqual(
    secrets.map(([name]) => name),
    [GITHUB_APP_ID_ENV, GITHUB_PRIVATE_KEY_ENV],
    'both secrets land in the home, once',
  );
  const [appId, keyPath] = validations;
  assert.equal(appId!(' 5011508 '), undefined);
  for (const value of [undefined, '', 'not a number', '1.5', '1'.repeat(21)])
    assert.equal(appId!(value), 'the numeric App ID, as on the app page');
  assert.equal(keyPath!('./a.pem'), undefined);
  for (const value of [undefined, '', '  ']) assert.equal(keyPath!(value), 'the path to the .pem GitHub gave you');
});

test('an unreadable or non-PEM key writes neither secret', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aivi-invalid-key-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  env(t, { [GITHUB_APP_ID_ENV]: undefined, [GITHUB_PRIVATE_KEY_ENV]: undefined, INIT_CWD: directory });
  await writeFile(join(directory, 'not-a-key.pem'), 'not a private key');
  for (const [path, error] of [
    ['./missing.pem', /private key could not be read:.*ENOENT/],
    ['./not-a-key.pem', /not a PEM private key/],
  ] as const) {
    const { ctx, asked, notes, secrets } = installer({ 'App ID': '7', '.pem': path });
    await assert.rejects(appIdentity(ctx), error);
    assert.deepEqual(secrets, []);
    assert.match(asked[0]!, /step 4/);
    assert.doesNotMatch(notes.join('\n'), /Webhook URL:/, 'the forge guide asks for no webhook');
  }
});

test('cancelling either identity question stops setup before any secret is written', async t => {
  env(t, { [GITHUB_APP_ID_ENV]: undefined, [GITHUB_PRIVATE_KEY_ENV]: undefined });
  for (const answers of [{ 'App ID': cancelled }, { 'App ID': '7', '.pem': cancelled }]) {
    const { ctx, secrets } = installer(answers);
    await assert.rejects(appIdentity(ctx), PluginSetupCancelled);
    assert.deepEqual(secrets, []);
  }
});

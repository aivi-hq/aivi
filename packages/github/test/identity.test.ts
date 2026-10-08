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
import { appIdentity } from '../src/identity.ts';
import { privateKey } from './github-api.ts';

/** The installer's two prompts, scripted; every note, question and written
 *  secret is on record. */
const installer = (answers: Record<string, string>) => {
  const asked: string[] = [];
  const notes: string[] = [];
  const secrets: [string, string][] = [];
  const prompts = {
    note: (body: string) => void notes.push(body),
    log: { message: async (line: string) => void asked.push(line) },
    text: async ({ message }: { message: string }) => {
      asked.push(message);
      const answer = Object.entries(answers).find(([key]) => message.includes(key));
      if (!answer) throw new Error(`the installer asked "${message}"; the test scripted no answer`);
      return answer[1];
    },
    isCancel: (value: unknown) => value === undefined,
  };
  const ctx = { prompts, writeSecret: async (name: string, value: string) => void secrets.push([name, value]) };
  return { ctx: ctx as never, asked, notes, secrets };
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
  const { ctx, asked, notes, secrets } = installer({ 'App ID': '5011508', '.pem': './a.pem' });
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
});

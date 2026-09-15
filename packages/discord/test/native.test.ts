import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { configSchema } from '@aivi/core';
import { discordConfigSchema } from '../src/config.ts';
import { createNativeChat } from '../src/native.ts';

test('native chat creates one fixed-agent session and reapplies only the source-directory allows before each prompt', async t => {
  const requests: { path: string; method: string; body: Record<string, any> }[] = [];
  let metadata: Record<string, unknown> = {};
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ path: req.url!, method: req.method!, body });
    if (req.url!.endsWith('/permission/rules') || req.url!.endsWith('/wait')) {
      res.writeHead(204);
      res.end();
      return;
    }
    res.setHeader('content-type', 'application/json');
    if (req.url!.endsWith('/permission') && req.method === 'GET') {
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    if (req.url!.endsWith('/prompt')) {
      metadata = body.metadata;
      res.end(JSON.stringify({ data: { id: body.id } }));
      return;
    }
    if (req.url!.endsWith('/context')) {
      res.end(
        JSON.stringify({
          data: [
            { type: 'user', id: 'user', text: 'Question', metadata, time: { created: 1 } },
            {
              type: 'assistant',
              id: 'answer',
              agent: 'librarian',
              finish: 'stop',
              time: { created: 2, completed: 3 },
              content: [{ type: 'text', text: 'Answer' }],
            },
            { type: 'idle', id: 'idle', outcome: 'succeeded', time: { created: 4 } },
          ],
        }),
      );
      return;
    }
    res.end(
      JSON.stringify({ data: { id: 'ses_discord_test', agent: 'librarian', location: { directory: '/librarian' } } }),
    );
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const config = discordConfigSchema.parse({
    version: 1,
    applicationId: '10000000000000001',
    directory: '/librarian',
    access: { dm: { users: ['10000000000000002'] } },
  });
  const loaded = {
    config: configSchema.parse({ version: 1, opencode: { url: `http://127.0.0.1:${address.port}` } }),
    path: '/config',
    projects: [],
    sources: [],
  };
  const { connectOpenCode } = await import('@aivi/host');
  const ask = await createNativeChat(config, loaded, () => connectOpenCode(loaded.config.opencode));
  let ready = 0;
  const turn = {
    id: 'one',
    channel: 'dm',
    user: 'human',
    name: 'Name',
    text: 'Question',
    session: 'ses_discord_test',
    ready: false,
    state: 'running' as const,
    result: null,
    error: null,
    kind: 'message' as const,
    agent: null,
    directory: null,
    seed: null,
  };
  assert.equal(
    await ask(turn, AbortSignal.timeout(3000), () => {
      ready++;
    }),
    'Answer',
  );
  assert.equal(
    await ask({ ...turn, id: 'two', ready: true }, AbortSignal.timeout(3000), () => {
      ready++;
    }),
    'Answer',
  );
  assert.equal(ready, 1);
  assert.equal(requests.filter(r => r.path === '/api/session' && r.method === 'POST').length, 1);
  const rules = requests.filter(r => r.path.endsWith('/permission/rules'));
  assert.equal(rules.length, 2);
  // The agent file is the boundary: aivi sends nothing but external_directory allows for sources.
  assert.ok(
    rules[0]!.body.permissions.every((p: { action: string; effect: string }) => p.action === 'external_directory'),
    'no deny-all and no tool allow-list; the agent file decides',
  );
  assert.deepEqual(requests.filter(r => r.path.endsWith('/prompt'))[1]!.body.metadata, {
    aivi: { origin: 'discord', channel: 'dm', user: 'human', discordMessage: 'two', message: 'msg_discord_two' },
  });
  assert.ok(
    requests.some(r => r.path.endsWith('/permission') && r.method === 'GET'),
    'pending permissions are checked',
  );

  // A script job's thread: the first turn carries the posted output as context, later ones do not.
  await ask({ ...turn, id: 'seeded', seed: 'exit 0\ncleaned 12 files' }, AbortSignal.timeout(3000), () => {});
  const seeded = requests.filter(r => r.path.endsWith('/prompt')).at(-1)!.body;
  assert.match(
    seeded.text,
    /^\[Earlier in this thread aivi posted this outcome of a scheduled job:\]\nexit 0\ncleaned 12 files\n\n\[Discord message from Name/,
  );
  await ask({ ...turn, id: 'unseeded', ready: true, seed: 'stale' }, AbortSignal.timeout(3000), () => {});
  assert.doesNotMatch(requests.filter(r => r.path.endsWith('/prompt')).at(-1)!.body.text, /Earlier in this thread/);

  // A job outcome re-entering the thread is marked as such, with the job id in its metadata.
  await ask({ ...turn, id: 'job:abc', kind: 'job', ready: true, text: '✅ done' }, AbortSignal.timeout(3000), () => {});
  const reentry = requests.filter(r => r.path.endsWith('/prompt')).at(-1)!.body;
  assert.match(reentry.text, /^\[aivi delivers the outcome of a scheduled job[^\]]*\]\n✅ done$/);
  assert.equal(reentry.id, 'msg_discord_job_abc');
  assert.deepEqual(reentry.metadata.aivi, {
    origin: 'job-result',
    channel: 'dm',
    job: 'abc',
    message: 'msg_discord_job_abc',
  });

  // A thread that adopted an agent job's session is checked against that job's agent and directory.
  await assert.rejects(
    ask(
      { ...turn, id: 'adopted', ready: true, agent: 'coder', directory: '/other' },
      AbortSignal.timeout(3000),
      () => {},
    ),
    /no longer runs agent coder in \/other/,
  );
});

test('an unreachable OpenCode is a turn that never started, not a blocked one', async () => {
  const { TurnNotStarted } = await import('@aivi/host');
  const config = discordConfigSchema.parse({
    version: 1,
    applicationId: '10000000000000001',
    directory: '/librarian',
    access: { dm: { users: ['10000000000000002'] } },
  });
  const loaded = { config: configSchema.parse({ version: 1 }), path: '/config', projects: [], sources: [] };
  const ask = await createNativeChat(config, loaded, async () => {
    throw new Error('No running OpenCode v2 service found');
  });
  const turn = {
    id: 'one',
    channel: 'dm',
    user: 'human',
    name: 'Name',
    text: 'Question',
    session: 'ses_discord_test',
    ready: false,
    state: 'running' as const,
    result: null,
    error: null,
    kind: 'message' as const,
    agent: null,
    directory: null,
    seed: null,
  };
  await assert.rejects(
    ask(turn, AbortSignal.timeout(3000), () => {}),
    (error: unknown) => error instanceof TurnNotStarted && /No running OpenCode/.test(error.message),
  );
});

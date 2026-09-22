import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { configSchema } from '@aivi/core';
import type { ChannelPlatform } from '../src/channel/contract.ts';
import { createTurnRunner, messageIdFor } from '../src/channel/turns.ts';
import { connectOpenCode } from '../src/opencode.ts';
import { TurnNotStarted } from '../src/session.ts';
import { Store } from '../src/store.ts';

const platform: ChannelPlatform = { id: 'discord', label: 'Discord', replyLimit: 1900 };
const config = { agent: 'librarian', directory: '/librarian' };
const quiet = { watch: () => () => {} };
const memory = () => new Store(':memory:');
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
  model: null,
  project: null,
  issue: null,
};

test('a turn runner creates one fixed-agent session and reapplies only the source-directory allows before each prompt', async t => {
  const requests: { path: string; method: string; body: Record<string, any> }[] = [];
  let metadata: Record<string, unknown> = {};
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ path: req.url!, method: req.method!, body });
    if (req.method === 'PATCH' || req.url!.endsWith('/wait') || req.url!.endsWith('/model')) {
      res.writeHead(204);
      res.end();
      return;
    }
    res.setHeader('content-type', 'application/json');
    if (req.url!.startsWith('/api/agent'))
      return void res.end(JSON.stringify({ data: [{ id: 'librarian', name: 'librarian' }] }));
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
  const loaded = {
    config: configSchema.parse({ version: 1, opencode: { url: `http://127.0.0.1:${address.port}` } }),
    path: '/config',
    projects: [],
    sources: [],
  };
  const store = memory();
  const ask = await createTurnRunner(
    platform,
    config,
    loaded,
    () => connectOpenCode(loaded.config.opencode),
    quiet,
    store,
  );
  let ready = 0;
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
  const rules = requests.filter(r => r.method === 'PATCH' && r.path.startsWith('/api/session/'));
  assert.equal(rules.length, 2);
  // The agent file is the boundary: aivi sends nothing but external_directory allows for sources.
  assert.ok(
    rules[0]!.body.permissions.every((p: { action: string; effect: string }) => p.action === 'external_directory'),
    'no deny-all and no tool allow-list; the agent file decides',
  );
  assert.deepEqual(requests.filter(r => r.path.endsWith('/prompt'))[1]!.body.metadata, {
    aivi: { origin: 'discord', channel: 'dm', user: 'human', sourceMessage: 'two', message: 'msg_discord_two' },
  });
  const created = requests.find(r => r.path === '/api/session' && r.method === 'POST')!.body;
  assert.equal(created.title, 'Discord dm');
  assert.deepEqual(created.metadata, { aivi: { origin: 'discord', channel: 'dm' } });
  assert.equal(created.id, 'ses_discord_test');
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

  // A run's outcome re-entering the thread is marked as such, with the run id in its metadata.
  await ask({ ...turn, id: 'run:abc', kind: 'job', ready: true, text: '✅ done' }, AbortSignal.timeout(3000), () => {});
  const reentry = requests.filter(r => r.path.endsWith('/prompt')).at(-1)!.body;
  assert.match(reentry.text, /^\[aivi delivers the outcome of a scheduled job[^\]]*\]\n✅ done$/);
  assert.equal(reentry.id, 'msg_discord_run_abc');
  assert.deepEqual(reentry.metadata.aivi, {
    origin: 'job-result',
    channel: 'dm',
    run: 'abc',
    message: 'msg_discord_run_abc',
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

  // A conversation's /model pin is applied to the session before the prompt; without one the agent file decides.
  assert.ok(!requests.some(r => r.path.endsWith('/model')), 'no pin and no agent-file model: nothing is switched');
  await ask(
    { ...turn, id: 'pinned', ready: true, model: { providerID: 'openai', modelID: 'gpt-5.2', variant: 'high' } },
    AbortSignal.timeout(3000),
    () => {},
  );
  const switched = requests.find(r => r.path.endsWith('/model'))!;
  assert.deepEqual(switched.body, { model: { providerID: 'openai', id: 'gpt-5.2', variant: 'high' } });
  assert.ok(requests.indexOf(switched) < requests.findIndex(r => r.body.id === 'msg_discord_pinned'));

  // Another platform: its own origin, label and speaker line; ids are sanitized so Slack's `C1:1726.5` fits.
  const slack: ChannelPlatform = {
    id: 'slack',
    label: 'Slack',
    replyLimit: 3900,
    describeSpeaker: t => `[Slack message from <@${t.user}>]`,
  };
  assert.equal(messageIdFor(slack, 'C1:1726000000.000100'), 'msg_slack_C1_1726000000_000100');
  const slackAsk = await createTurnRunner(
    slack,
    config,
    loaded,
    () => connectOpenCode(loaded.config.opencode),
    quiet,
    memory(),
  );
  await slackAsk(
    { ...turn, id: 'C1:1.5', ready: true, session: 'ses_slack_test' },
    AbortSignal.timeout(3000),
    () => {},
  );
  const slackPrompt = requests.filter(r => r.path.endsWith('/prompt')).at(-1)!.body;
  assert.equal(slackPrompt.id, 'msg_slack_C1_1_5');
  assert.equal(slackPrompt.text, '[Slack message from <@human>]\nQuestion');
  assert.equal(slackPrompt.metadata.aivi.origin, 'slack');
});

test('an unreachable OpenCode is a turn that never started, not a blocked one', async () => {
  const loaded = { config: configSchema.parse({ version: 1 }), path: '/config', projects: [], sources: [] };
  const ask = await createTurnRunner(
    platform,
    config,
    loaded,
    async () => {
      throw new Error('No running OpenCode v2 service found');
    },
    quiet,
    memory(),
  );
  await assert.rejects(
    ask(turn, AbortSignal.timeout(3000), () => {}),
    (error: unknown) => error instanceof TurnNotStarted && /No running OpenCode/.test(error.message),
  );
});

test('a source whose directory does not exist is skipped, not a module start that fails its retry loop', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'aivi-turns-')));
  await mkdir(join(root, 'docs'));
  const requests: { path: string; method: string; body: Record<string, any> }[] = [];
  let promptMetadata: Record<string, unknown> = {};
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ path: req.url!, method: req.method!, body });
    if (req.method === 'PATCH' || req.url!.endsWith('/wait') || req.url!.endsWith('/model')) {
      res.writeHead(204);
      res.end();
      return;
    }
    res.setHeader('content-type', 'application/json');
    if (req.url!.startsWith('/api/agent'))
      return void res.end(JSON.stringify({ data: [{ id: 'librarian', name: 'librarian' }] }));
    if (req.url!.endsWith('/permission') && req.method === 'GET') {
      res.end(JSON.stringify({ data: [] }));
      return;
    }
    if (req.url!.endsWith('/prompt')) {
      promptMetadata = body.metadata;
      res.end(JSON.stringify({ data: { id: body.id } }));
      return;
    }
    if (req.url!.endsWith('/context')) {
      res.end(
        JSON.stringify({
          data: [
            { type: 'user', id: 'user', text: 'Question', metadata: promptMetadata, time: { created: 1 } },
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
  const loaded = {
    config: configSchema.parse({ version: 1, opencode: { url: `http://127.0.0.1:${address.port}` } }),
    path: '/config',
    projects: [],
    // The company convention on a repository without a `docs/adr`: a vacuous allow, not an error.
    sources: [
      { id: 'docs', path: join(root, 'docs'), kind: 'doc' as const, scope: 'project' as const, projectId: 'peck' },
      {
        id: 'adr',
        path: join(root, 'docs', 'adr'),
        kind: 'decision' as const,
        scope: 'project' as const,
        projectId: 'peck',
      },
    ],
  };
  const ask = await createTurnRunner(
    platform,
    config,
    loaded,
    () => connectOpenCode(loaded.config.opencode),
    quiet,
    memory(),
  );
  assert.equal(await ask(turn, AbortSignal.timeout(3000), () => {}), 'Answer');
  const rules = requests.filter(r => r.method === 'PATCH' && r.path.startsWith('/api/session/'));
  assert.equal(rules.length, 1);
  assert.deepEqual(
    rules[0]!.body.permissions.map((p: { resource: string }) => p.resource),
    [`${join(root, 'docs')}/**`],
    'only the existing source is allowed; the missing directory is skipped',
  );
});

test('a linked channel account speaks as its aivi person, in the prompt and the metadata', async t => {
  const requests: { path: string; method: string; body: Record<string, any> }[] = [];
  let metadata: Record<string, unknown> = {};
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    requests.push({ path: req.url!, method: req.method!, body });
    if (req.method === 'PATCH' || req.url!.endsWith('/wait') || req.url!.endsWith('/model')) {
      res.writeHead(204);
      res.end();
      return;
    }
    res.setHeader('content-type', 'application/json');
    if (req.url!.startsWith('/api/agent'))
      return void res.end(JSON.stringify({ data: [{ id: 'librarian', name: 'librarian' }] }));
    if (req.url!.endsWith('/permission') && req.method === 'GET') return void res.end(JSON.stringify({ data: [] }));
    if (req.url!.endsWith('/prompt')) {
      metadata = body.metadata;
      return void res.end(JSON.stringify({ data: { id: body.id } }));
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
  const loaded = {
    config: configSchema.parse({ version: 1, opencode: { url: `http://127.0.0.1:${address.port}` } }),
    path: '/config',
    projects: [],
    sources: [],
  };
  const store = memory();
  const person = store.createPerson({ name: 'Ada', roles: [] });
  const { code } = store.mintLinkCode(person.id);
  const outcome = store.redeemLinkCode(code, 'discord', 'human');
  assert.equal(outcome.reason, 'bound');
  const ask = await createTurnRunner(
    platform,
    config,
    loaded,
    () => connectOpenCode(loaded.config.opencode),
    quiet,
    store,
  );
  await ask(turn, AbortSignal.timeout(3000), () => {});
  const prompt = requests.filter(r => r.path.endsWith('/prompt'))[0]!.body;
  assert.equal(
    prompt.text,
    '[Discord message from Ada (user human)]\nQuestion',
    'the aivi person name, not the platform handle',
  );
  assert.deepEqual(prompt.metadata.aivi, {
    origin: 'discord',
    channel: 'dm',
    user: 'human',
    sourceMessage: 'one',
    message: 'msg_discord_one',
    person: person.id,
  });
  const created = requests.find(r => r.path === '/api/session' && r.method === 'POST')!.body;
  assert.deepEqual(created.metadata, { aivi: { origin: 'discord', channel: 'dm', person: person.id } });
  // An unlinked user on the same store keeps the platform handle and no person stamp.
  await ask({ ...turn, id: 'two', ready: true, user: 'stranger' }, AbortSignal.timeout(3000), () => {});
  const stranger = requests.filter(r => r.path.endsWith('/prompt')).at(-1)!.body;
  assert.equal(stranger.text, '[Discord message from Name (user stranger)]\nQuestion');
  assert.equal(stranger.metadata.aivi.person, undefined);
});

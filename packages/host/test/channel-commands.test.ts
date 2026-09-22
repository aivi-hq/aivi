import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { configSchema, jobSchema } from '@aivi/core';
import {
  CHAT_COMMANDS,
  describeJobs,
  helpText,
  isChatCommand,
  redeemLink,
  steerTurn,
  stopTurn,
  usageHint,
} from '../src/channel/commands.ts';
import type { ChannelPlatform } from '../src/channel/contract.ts';
import { ChannelEngine, STOPPED_NOTICE, STOPPED_REASON } from '../src/channel/engine.ts';
import type { ModelChoice } from '../src/channel/model.ts';
import {
  describeModel,
  formatModel,
  listModels,
  matchModels,
  resolveModel,
  switchModel,
} from '../src/channel/model.ts';
import { ConversationStore } from '../src/channel/store.ts';
import { connectOpenCode } from '../src/opencode.ts';
import { Store } from '../src/store.ts';

const platform: ChannelPlatform = { id: 'discord', label: 'Discord', replyLimit: 1900 };
const scheduler = configSchema.parse({ version: 1 }).scheduler;
const limits = { resource: 'local-model', maxConcurrent: 1, turnTimeoutMs: 300_000 };
const binding = { agent: 'librarian', directory: '/home' };
const message = (id: string, channel = 'dm-a') => ({
  id,
  channel,
  user: 'u1',
  name: 'Speaker',
  text: `Question ${id}`,
});

const catalogue = [
  {
    id: 'github-copilot/gpt-5.2',
    providerID: 'github-copilot',
    modelID: 'gpt-5.2',
    name: 'GPT 5.2',
    enabled: true,
    variants: [{ id: 'high' }],
    limit: { context: 128_000, output: 16_000 },
  },
  {
    id: 'github-copilot/gemini-3.8-flash',
    providerID: 'github-copilot',
    modelID: 'gemini-3.8-flash',
    name: 'Gemini 3.8 Flash',
    enabled: true,
    variants: [],
    limit: { context: 1_000_000, output: 65_000 },
  },
  {
    id: 'anthropic/claude-sonnet-5',
    providerID: 'anthropic',
    modelID: 'claude-sonnet-5',
    name: 'Claude Sonnet 5',
    enabled: true,
    variants: [],
    limit: { context: 200_000, output: 64_000 },
  },
  {
    id: 'openai/o9',
    providerID: 'openai',
    modelID: 'o9',
    name: 'o9',
    enabled: false,
    variants: [],
    limit: { context: 1, output: 1 },
  },
];

/** The OpenCode routes the commands touch: catalogue, agents, transcript, interrupt, prompt. */
async function mockOpenCode(t: { after(fn: () => Promise<void>): void }) {
  const requests: { method: string; path: string; body: Record<string, any> }[] = [];
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const url = new URL(req.url!, 'http://x');
    requests.push({ method: req.method!, path: url.pathname, body: raw ? JSON.parse(raw) : {} });
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/api/model') return void res.end(JSON.stringify({ location: {}, data: catalogue }));
    if (url.pathname === '/api/model/default')
      return void res.end(JSON.stringify({ location: {}, data: catalogue[1] }));
    if (url.pathname === '/api/agent')
      return void res.end(
        JSON.stringify({
          data: [
            { id: 'librarian', name: 'librarian', model: { id: 'gemini-3.8-flash', providerID: 'github-copilot' } },
          ],
        }),
      );
    if (url.pathname.endsWith('/message'))
      return void res.end(
        JSON.stringify({
          data: [
            {
              type: 'assistant',
              id: 'a2',
              agent: 'librarian',
              model: { providerID: 'github-copilot', id: 'gpt-5.2', variant: 'high' },
              time: { created: 4 },
              content: [],
            },
          ],
          cursor: { next: null },
        }),
      );
    if (url.pathname.endsWith('/interrupt')) return void res.end('{"interrupted":true}');
    if (url.pathname.endsWith('/prompt')) return void res.end(JSON.stringify({ data: { id: 'steer-1' } }));
    res.writeHead(404);
    res.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const client = await connectOpenCode({ url: `http://127.0.0.1:${address.port}`, lifecycle: 'discover' }, {});
  return { client, requests, opencode: async () => client };
}

test('the command table feeds /help and the platform manifests: names, one usage hint, short descriptions', () => {
  assert.deepEqual(
    CHAT_COMMANDS.map(c => c.name),
    ['new', 'status', 'context', 'search', 'model', 'stop', 'steer', 'jobs', 'link', 'help'],
  );
  assert.ok(
    CHAT_COMMANDS.every(c => c.description.length < 100),
    'Discord caps descriptions at 100',
  );
  assert.ok(CHAT_COMMANDS.every(c => c.arguments.every(a => a.description.length < 100)));
  assert.equal(isChatCommand('steer'), true);
  assert.equal(isChatCommand('agent'), false);
  assert.equal(usageHint(CHAT_COMMANDS.find(c => c.name === 'search')!), 'QUERY [project]');
  assert.equal(usageHint(CHAT_COMMANDS.find(c => c.name === 'new')!), '');
  const help = helpText(name => `/aivi-${name}`);
  assert.equal(help.split('\n').length, CHAT_COMMANDS.length);
  assert.match(help, /^`\/aivi-new` — Start a fresh conversation\n/);
  assert.match(help, /`\/aivi-search QUERY \[project\]` — Search team knowledge/);
  assert.match(help, /`\/aivi-steer TEXT` — /);
});

test('/jobs lists the next five occurrences and the last ten runs from the host store', t => {
  const core = new Store(':memory:');
  t.after(() => core.close());
  const now = Date.parse('2026-09-15T12:00:00Z');
  assert.match(describeJobs(core, now), /No jobs are due\.[\s\S]*No runs have finished yet\./);
  core.syncJobs(
    [
      jobSchema.parse({
        id: 'digest',
        title: 'Morning digest',
        cron: '0 9 * * *',
        timezone: 'UTC',
        resource: 'local-model',
        task: { kind: 'invocation', name: 'system.check' },
      }),
    ],
    [],
    now,
  );
  for (let i = 0; i < 12; i++) {
    const run = core.enqueue({ kind: 'invocation', name: 'system.check' }, 'local-model', `k${i}`, now + i);
    const claimed = core.claim('host', 1, scheduler.resources, now + i)!;
    core.finish(claimed.id, 'host', i % 2 ? 'failed' : 'succeeded', {}, 'boom', now + 1000 + i);
    assert.equal(claimed.id, run.id);
  }
  const text = describeJobs(core, now);
  const lines = text.split('\n');
  assert.equal(lines[0], '**Next occurrences**');
  assert.match(lines[1]!, /^- `digest` — Morning digest · in 21h \(2026-09-16 09:00 UTC\)$/);
  assert.equal(lines[2], '');
  assert.equal(lines[3], '**Last runs**');
  assert.equal(lines.length - 4, 10, 'the last ten runs only');
  assert.match(lines[4]!, /^- ❌ `job-.*` failed · 2026-09-15 12:00 UTC$/);
  assert.match(lines[5]!, /^- ✅ `job-.*` succeeded · /);
});

test('the model catalogue: `provider/model@variant` spelling, prefix-first matching, exact or unique resolution', async t => {
  const { client, requests } = await mockOpenCode(t);
  const choices = await listModels(client, '/home');
  assert.deepEqual(choices.map(formatModel), [
    'github-copilot/gpt-5.2',
    'github-copilot/gpt-5.2@high',
    'github-copilot/gemini-3.8-flash',
    'anthropic/claude-sonnet-5',
  ]);
  assert.equal(new URL(`http://x${requests[0]!.path}`).pathname, '/api/model');
  assert.deepEqual(matchModels(choices, 'github-copilot/g', 25).map(formatModel), [
    'github-copilot/gemini-3.8-flash',
    'github-copilot/gpt-5.2',
    'github-copilot/gpt-5.2@high',
  ]);
  assert.deepEqual(matchModels(choices, 'gpt', 1).map(formatModel), ['github-copilot/gpt-5.2']);
  assert.deepEqual(
    matchModels(choices, 'sonnet', 5).map(formatModel),
    ['anthropic/claude-sonnet-5'],
    'display names count',
  );
  assert.equal(matchModels(choices, '', 2).length, 2, 'an empty query lists the catalogue');
  assert.deepEqual(matchModels(choices, 'nothing-like-it', 5), []);
  const pick = (text: string) => formatModel((resolveModel(choices, text) as { model: ModelChoice }).model);
  assert.equal(pick('GitHub-Copilot/GPT-5.2'), 'github-copilot/gpt-5.2');
  assert.equal(pick('github-copilot/gpt-5.2 (high)'), 'github-copilot/gpt-5.2@high');
  assert.equal(pick('gpt-5.2@high'), 'github-copilot/gpt-5.2@high', 'a model id alone is enough when unique');
  assert.equal(pick('Claude Sonnet 5'), 'anthropic/claude-sonnet-5', 'so is a display name');
  assert.deepEqual(
    (resolveModel(choices, 'gpt') as { candidates: ModelChoice[] }).candidates.map(formatModel),
    ['github-copilot/gpt-5.2', 'github-copilot/gpt-5.2@high'],
    'anything else offers the closest matches',
  );
});

test('/model shows the pin, the last answer and the agent default; switching validates, pins, refuses while a turn runs', async t => {
  const core = new Store(':memory:');
  t.after(() => core.close());
  const store = new ConversationStore(core, platform, 'binding');
  const { opencode } = await mockOpenCode(t);
  assert.deepEqual((await describeModel(store, 'dm-a', binding, opencode)).split('\n'), [
    '🧠 **Model**',
    'This conversation: the agent’s default.',
    'Last answer: none yet.',
    'Agent `librarian`: `github-copilot/gemini-3.8-flash` (agent file).',
  ]);
  assert.match(
    await switchModel(store, 'dm-a', binding, opencode, 'gpt'),
    /^No model is called `gpt`\. Closest: `github-copilot\/gpt-5\.2`, `github-copilot\/gpt-5\.2@high`\.$/,
  );
  assert.match(await switchModel(store, 'dm-a', binding, opencode, 'zzz'), /Nothing in the catalogue matches/);
  assert.match(
    await switchModel(store, 'dm-a', binding, opencode, 'openai/o9'),
    /No model is called/,
    'disabled models are not offered',
  );
  assert.equal(store.sessionOf('dm-a'), null, 'nothing was pinned');
  assert.equal(
    await switchModel(store, 'dm-a', binding, opencode, ' GPT-5.2 (high) '),
    'This conversation answers with `github-copilot/gpt-5.2@high` from its next message on, until /new.',
  );
  assert.deepEqual(store.sessionOf('dm-a')?.model, {
    providerID: 'github-copilot',
    modelID: 'gpt-5.2',
    variant: 'high',
  });
  store.enqueue(message('one'), 10);
  store.claim(scheduler, limits.resource);
  store.ready('dm-a');
  assert.match(
    await switchModel(store, 'dm-a', binding, opencode, 'anthropic/claude-sonnet-5'),
    /A turn is running in this conversation/,
  );
  assert.equal(store.sessionOf('dm-a')?.model?.modelID, 'gpt-5.2', 'refused: the pin is unchanged');
  assert.deepEqual((await describeModel(store, 'dm-a', binding, opencode)).split('\n').slice(1, 3), [
    'This conversation: `github-copilot/gpt-5.2@high` (pinned with /model, until /new).',
    'Last answer: `github-copilot/gpt-5.2@high`.',
  ]);
  store.sent('one');
  assert.match(await switchModel(store, 'dm-a', binding, opencode, 'default'), /agent’s default model again/);
  assert.equal(store.sessionOf('dm-a')?.model, null);
});

test('/stop and /steer act on the running turn only: interrupt after the engine abort, a steer prompt marked for its turn', async t => {
  const core = new Store(':memory:');
  t.after(() => core.close());
  const store = new ConversationStore(core, platform, 'binding');
  const { opencode, requests } = await mockOpenCode(t);
  const sent: string[] = [];
  const engine = new ChannelEngine(
    store,
    limits,
    scheduler,
    (turn, signal, ready) =>
      new Promise<string>((_resolve, reject) => {
        ready();
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        void turn;
      }),
    { send: async (_channel, text) => void sent.push(text) },
  );
  t.after(() => engine.stop());
  assert.deepEqual(await stopTurn(engine, opencode, 'dm-a'), {
    text: 'Nothing is running in this conversation.',
    stopped: false,
  });
  assert.equal(
    (await steerTurn(store, platform, opencode, 'dm-a', { name: 'Me', user: 'u1' }, 'also this')).steered,
    false,
  );
  assert.equal(requests.length, 0, 'nothing running: OpenCode is not asked');

  store.enqueue(message('one'), 10);
  engine.tick();
  await Promise.resolve();
  const session = store.sessionOf('dm-a')!.session;
  const steered = await steerTurn(
    store,
    platform,
    opencode,
    'dm-a',
    { name: 'Me', user: 'u1' },
    'also check the handbook',
  );
  assert.equal(steered.steered, true);
  const prompt = requests.find(r => r.path.endsWith('/prompt'))!;
  assert.equal(prompt.path, `/api/session/${session}/prompt`);
  assert.deepEqual(prompt.body, {
    text: '[Discord message from Me (user u1)]\nalso check the handbook',
    delivery: 'steer',
    metadata: { aivi: { origin: 'discord', channel: 'dm-a', user: 'u1', steer: 'msg_discord_one' } },
  });

  const stopped = await stopTurn(engine, opencode, 'dm-a');
  assert.deepEqual(stopped, { text: 'Stopped.', stopped: true });
  assert.equal(requests.at(-1)!.path, `/api/session/${session}/interrupt`);
  await new Promise(resolve => setTimeout(resolve, 20));
  const one = store.list()[0]!;
  assert.deepEqual([one.state, one.error], ['discarded', STOPPED_REASON]);
  assert.deepEqual(sent, [STOPPED_NOTICE]);
  assert.deepEqual(core.leases(), []);
});

test('redeemLink answers in words; the host decides and the module only sends', () => {
  const store = new Store(':memory:');
  const ada = store.createPerson({ name: 'Ada', roles: [] });
  assert.match(redeemLink(store, 'discord', 'u1', '12345'), /did not match/);
  const { code } = store.mintLinkCode(ada.id);
  assert.match(redeemLink(store, 'discord', 'u1', ` ${code} `), /belongs to Ada/, 'whitespace is tolerated');
  const second = store.mintLinkCode(ada.id);
  assert.match(redeemLink(store, 'discord', 'u1', second.code), /already linked to Ada/);
  // The refused relink did not consume: the code still works for another account.
  assert.match(redeemLink(store, 'discord', 'u2', second.code), /belongs to Ada/);
  store.close();
});

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { test } from 'node:test';
import { configSchema } from '@aivi/core';
import { Channels } from '../src/channel/router.ts';
import { createJobHandler, JobRefused } from '../src/jobs.ts';
import { connectOpenCode } from '../src/opencode.ts';
import { Store } from '../src/store.ts';

const NOW = Date.parse('2026-09-15T10:00:00Z');

/** A tiny OpenCode: sessions by id with their aivi origin, and one known agent per directory. */
async function fakeOpenCode(
  t: { after(fn: () => Promise<void> | void): void },
  sessions: Record<string, { agent?: string; directory: string; origin?: string }>,
  agents: Record<string, string[]>,
) {
  const server = createServer(async (req, res) => {
    for await (const _ of req) void _;
    res.setHeader('content-type', 'application/json');
    const url = new URL(req.url!, 'http://x');
    const session = /^\/api\/session\/([^/]+)$/.exec(url.pathname);
    if (session) {
      const s = sessions[decodeURIComponent(session[1]!)];
      if (!s) {
        res.writeHead(404);
        return void res.end('{"error":"no"}');
      }
      return void res.end(
        JSON.stringify({
          data: {
            id: session[1],
            agent: s.agent,
            location: { directory: s.directory },
            metadata: s.origin ? { aivi: { origin: s.origin } } : undefined,
          },
        }),
      );
    }
    if (url.pathname === '/api/agent') {
      const directory = url.searchParams.get('location[directory]') ?? '';
      return void res.end(JSON.stringify({ data: (agents[directory] ?? []).map(id => ({ id, name: id })) }));
    }
    res.writeHead(404);
    res.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}`;
}

function setup(store: Store, url: string, enabled = true) {
  const config = configSchema.parse({
    version: 1,
    opencode: { url },
    scheduler: {
      resources: { 'local-model': 1, agents: 2 },
      agentSchedules: enabled ? { resource: 'agents', max: 3 } : false,
    },
  });
  const channels = new Channels(async () => {});
  channels.register({
    id: 'discord',
    accepts: c => c === '42',
    post: async () => {},
    ownsSession: id => ['ses_discord_adopted', 'ses_discord_1'].includes(id),
    channelOf: async id => (id === 'ses_discord_1' ? '42' : undefined),
    reenter: async () => {},
  });
  const handler = createJobHandler({
    store,
    loaded: { path: '/config.json', config, projects: [], sources: [] },
    channels,
    opencode: () => connectOpenCode(config.opencode, {}),
    now: () => NOW,
  });
  return { handler, channels };
}

const refused = (status: number, pattern: RegExp) => (error: unknown) =>
  error instanceof JobRefused && error.status === status && pattern.test(error.message);

test('an agent creates a recurring agent job for its own agent and directory; results come back to its session', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const url = await fakeOpenCode(
    t,
    { ses_discord_1: { agent: 'librarian', directory: '/team', origin: 'discord' } },
    { '/team': ['librarian'] },
  );
  const { handler } = setup(store, url);
  const base = () =>
    ({ action: 'create', sessionId: 'ses_discord_1', prompt: 'Summarize last week', on: 'always' }) as const;
  const created = await handler({
    ...base(),
    messageId: 'msg_1',
    title: 'Monday summary',
    cron: '0 9 * * 1',
    timezone: 'Europe/Amsterdam',
    report: 'session',
  });
  assert.equal(created.items.length, 1);
  const item = created.items[0]!;
  assert.match(item.id, /^agent-[0-9a-f]{8}$/);
  assert.equal(item.task, 'agent');
  assert.equal(item.title, 'Monday summary');
  assert.equal(item.next.length, 3);
  assert.match(
    created.summary,
    /^Created Monday summary \(agent-[0-9a-f]{8}\): cron 0 9 \* \* 1 in Europe\/Amsterdam\. Next: Sep 21, 2026, 9:00 AM/,
  );
  assert.match(created.summary, /brought back into this conversation/);
  const entry = store.job(item.id);
  assert.equal(entry.source, 'agent');
  assert.equal(item.kind, 'recurring');
  assert.equal(item.state, 'active');
  assert.deepEqual(entry.spec.task, {
    kind: 'prompt',
    agent: 'librarian',
    directory: '/team',
    prompt: 'Summarize last week',
    timeoutMs: 1_800_000,
    onPermission: 'reject',
  });
  assert.deepEqual(entry.spec.report, { to: 'session', session: 'ses_discord_1', on: 'always' });
  assert.equal(entry.spec.resource, 'agents');

  const listed = await handler({ action: 'list', sessionId: 'ses_discord_1' });
  assert.equal(listed.items.length, 1);
  assert.match(listed.summary, /Monday summary/);
  const paused = await handler({ action: 'pause', sessionId: 'ses_discord_1', id: item.id });
  assert.equal(paused.items[0]!.state, 'paused');
  assert.deepEqual(paused.items[0]!.next, []);
  const ran = await handler({ action: 'run', sessionId: 'ses_discord_1', id: item.id });
  assert.match(ran.summary, /Queued one run/);
  const manual = store.lastRun(item.id)!;
  assert.equal(manual.state, 'queued');
  await handler({ action: 'remove', sessionId: 'ses_discord_1', id: item.id });
  assert.throws(() => store.job(item.id), /Unknown job/);
  assert.equal(store.run(manual.id).state, 'cancelled', 'removing cancels the queued run');

  const posted = await handler({ ...base(), report: 'channel', channel: '42', at: '1h' });
  assert.deepEqual(
    store.job(posted.items[0]!.id).spec.report,
    { to: 'channel', module: 'discord', channel: '42', on: 'always' },
    'a conversation defaults to its own platform',
  );
  assert.match(posted.summary, /posted to discord 42/);
  const here = await handler({ ...base(), report: 'channel', at: '1h' });
  assert.deepEqual(
    store.job(here.items[0]!.id).spec.report,
    { to: 'channel', module: 'discord', channel: '42', on: 'always' },
    '"post it to this channel": the channel the conversation lives in',
  );
});

test('one-offs, script jobs, overrides and the report checks', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const url = await fakeOpenCode(
    t,
    { ses_native: { agent: 'build', directory: '/home' } },
    { '/home': ['build'], '/other': ['coder'] },
  );
  const { handler } = setup(store, url);
  const base = { action: 'create', sessionId: 'ses_native', report: 'session', on: 'always' } as const;

  const script = await handler({ ...base, command: ['sh', 'clean.sh'], at: '2h', report: 'none' });
  const job = store.jobs()[0]!;
  assert.equal(job.spec.id, script.items[0]!.id);
  assert.equal(script.items[0]!.kind, 'one-off');
  assert.equal(job.nextAt, NOW + 2 * 3_600_000);
  assert.equal(job.spec.at, new Date(NOW + 2 * 3_600_000).toISOString());
  assert.deepEqual(job.spec.task, { kind: 'shell', command: ['sh', 'clean.sh'], cwd: '/home', timeoutMs: 600_000 });
  assert.equal(job.spec.report, undefined);
  assert.equal(store.runs().length, 0, 'the run is created when the instant comes');
  assert.match(script.summary, /Created a one-off `sh clean.sh` .* for Sep 15, 2026, .*not reported anywhere/);
  assert.equal(store.materializeDue(NOW + 2 * 3_600_000).created, 1);
  const fired = store.runs()[0]!;
  assert.equal(store.history(fired.id)[0]!.reason, `job:${fired.jobId}`);

  const other = await handler({
    ...base,
    prompt: 'Refactor',
    agent: 'coder',
    directory: '/other',
    at: '2026-09-16T09:00:00Z',
    report: 'channel',
    module: 'discord',
    channel: '42',
    on: 'failure',
  });
  const overridden = store.job(other.items[0]!.id).spec;
  assert.equal(overridden.task.kind, 'prompt');
  assert.equal((overridden.task as { agent: string }).agent, 'coder');
  assert.deepEqual(overridden.report, { to: 'channel', module: 'discord', channel: '42', on: 'failure' });
  assert.match(other.summary, /Only failures are posted to discord 42/);

  await assert.rejects(
    handler({ ...base, prompt: 'x', command: ['y'], at: '1h' }),
    refused(400, /exactly one of prompt/),
  );
  await assert.rejects(
    handler({ ...base, prompt: 'x', at: '1h', cron: '* * * * *' }),
    refused(400, /exactly one of at/),
  );
  await assert.rejects(handler({ ...base, prompt: 'x', at: 'tomorrow' }), refused(400, /Not a time/));
  await assert.rejects(handler({ ...base, prompt: 'x', cron: 'every monday' }), refused(400, /Invalid cron/));
  await assert.rejects(handler({ ...base, prompt: 'x', at: '1h', agent: 'nobody' }), refused(400, /No agent "nobody"/));
  await assert.rejects(
    handler({ ...base, prompt: 'x', at: '1h', report: 'channel', channel: '42' }),
    refused(400, /needs the module/),
    'a native session names the platform',
  );
  await assert.rejects(
    handler({ ...base, prompt: 'x', at: '1h', report: 'channel', module: 'discord' }),
    refused(400, /needs the channel id when the asking session is not a chat conversation/),
  );
  await assert.rejects(
    handler({ ...base, prompt: 'x', at: '1h', report: 'channel', module: 'discord', channel: '7' }),
    refused(400, /does not allow posting to 7/),
  );
  await assert.rejects(
    handler({ ...base, prompt: 'x', at: '1h', report: 'channel', module: 'slack', channel: '7' }),
    refused(400, /No channel module "slack"/),
  );
  await assert.rejects(
    handler({ ...base, sessionId: 'ses_gone', prompt: 'x', at: '1h' }),
    refused(404, /Unknown session/),
  );
  // The limit counts recurring jobs and one-offs that have not fired together.
  await handler({ ...base, prompt: 'third', at: '3h' });
  await assert.rejects(handler({ ...base, prompt: 'fourth', at: '4h' }), refused(409, /limit of 3/));
  const removed = await handler({ action: 'remove', sessionId: 'ses_native', id: job.spec.id });
  assert.match(removed.summary, /Removed `sh clean.sh`/);
  assert.throws(() => store.job(job.spec.id), /Unknown job/);
  assert.equal(store.runs()[0]!.state, 'cancelled', 'its queued run goes with it');
  // A retried tool call (same message) is one job, not two.
  const once = await handler({ ...base, prompt: 'once', at: '5h', messageId: 'msg_9' });
  const twice = await handler({ ...base, prompt: 'once', at: '5h', messageId: 'msg_9' });
  assert.equal(once.items[0]!.id, twice.items[0]!.id);
});

test('jobs do not create jobs, unless a conversation adopted the session; disabled config refuses everything', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const url = await fakeOpenCode(
    t,
    {
      ses_aivi_job: { agent: 'librarian', directory: '/team', origin: 'job' },
      ses_discord_adopted: { agent: 'librarian', directory: '/team', origin: 'job' },
      ses_dream: { agent: 'dreamer', directory: '/team', origin: 'dreaming' },
    },
    { '/team': ['librarian'] },
  );
  const { handler } = setup(store, url);
  const create = { action: 'create', prompt: 'again', at: '1h', report: 'none', on: 'always' } as const;
  await assert.rejects(handler({ ...create, sessionId: 'ses_aivi_job' }), refused(403, /Jobs do not create jobs/));
  await assert.rejects(handler({ ...create, sessionId: 'ses_dream' }), refused(403, /Jobs do not create jobs/));
  const adopted = await handler({ ...create, sessionId: 'ses_discord_adopted' });
  assert.equal(adopted.items.length, 1);

  const disabled = setup(new Store(':memory:'), url, false).handler;
  await assert.rejects(
    disabled({ action: 'list', sessionId: 'ses_aivi_job' }),
    refused(403, /disabled by the operator/),
  );
});

/** `aivi_jobs` as a unit, with OpenCode as a handed-in client: what the handler
 *  asks of it, what it refuses, and the words it answers in. Jobs live in the
 *  host's real in-memory store. */
import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { configSchema, jobSchema } from '@aivi/core';
import type { OpenCodeClient } from '@aivi/plugin/module';
import { Channels } from '../src/channel/router.ts';
import { createJobHandler, JobRefused } from '../src/jobs.ts';
import { Store } from '../src/store.ts';

const NOW = Date.parse('2026-09-15T10:00:00Z');
const HOUR = 3_600_000;

interface Fake {
  session?: () => Promise<unknown>;
  agents?: () => Promise<unknown>;
  opencode?: () => Promise<OpenCodeClient>;
}

/** The session an agent job is asked from: `assistant` in `/team`, one agent known there. */
const asking = (): Promise<unknown> => Promise.resolve({ agent: 'assistant', location: { directory: '/team' } });
const knowing = (): Promise<unknown> => Promise.resolve({ data: [{ id: 'assistant', name: 'assistant' }] });

function world(t: TestContext, fake: Fake = {}, settings: Record<string, unknown> = { max: 3 }) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const client = {
    session: { get: t.mock.fn(fake.session ?? asking) },
    agent: { list: t.mock.fn(fake.agents ?? knowing) },
  } as unknown as OpenCodeClient;
  const config = configSchema.parse({ version: 1, scheduler: { agentSchedules: settings } });
  const handler = createJobHandler({
    store,
    loaded: { path: '/config.json', config, projects: [], sources: [] },
    channels: new Channels(async () => {}),
    opencode: fake.opencode ?? (async () => client),
    now: () => NOW,
  });
  return { store, client, handler };
}

const create = { action: 'create', sessionId: 'ses_1', report: 'none', on: 'always' } as const;

const refused = (status: number, pattern: RegExp) => (error: unknown) =>
  error instanceof JobRefused && error.status === status && pattern.test(error.message);

for (const [cause, said] of [
  [new Error('connection refused'), 'connection refused'],
  ['down for maintenance', 'down for maintenance'],
] as const)
  test(`OpenCode that cannot be reached is a 503 the agent can relay (${typeof cause === 'string' ? 'a plain rejection' : 'an error'})`, async t => {
    const { handler } = world(t, {
      opencode: async () => {
        throw cause;
      },
    });
    await assert.rejects(
      handler({ ...create, prompt: 'Summarize', at: '1h' }),
      refused(503, new RegExp(`^OpenCode is not reachable: ${said}$`)),
    );
  });

for (const [cause, said] of [
  [new Error('agent endpoint timed out'), 'agent endpoint timed out'],
  ['agents are busy', 'agents are busy'],
] as const)
  test(`a failed agent listing is a 503, not a confident "no such agent" (${typeof cause === 'string' ? 'a plain rejection' : 'an error'})`, async t => {
    const { handler, store } = world(t, {
      agents: async () => {
        throw cause;
      },
    });
    await assert.rejects(
      handler({ ...create, prompt: 'Summarize', at: '1h' }),
      refused(503, new RegExp(`^Could not list the agents in /team: ${said}$`)),
    );
    assert.deepEqual(store.jobs(), [], 'nothing was created');
  });

test('a script job runs where, with what and for how long the agent said', async t => {
  const { handler, store } = world(t);
  await handler({
    ...create,
    command: ['sh', 'build.sh'],
    cwd: '/srv/build',
    env: { MODE: 'ci' },
    timeoutMs: 120_000,
    at: '2h',
  });
  assert.deepEqual(store.jobs()[0]!.spec.task, {
    kind: 'shell',
    command: ['sh', 'build.sh'],
    cwd: '/srv/build',
    env: { MODE: 'ci' },
    timeoutMs: 120_000,
  });
});

test('a prompt job takes the time limit the agent asked for', async t => {
  const { handler, store } = world(t);
  await handler({ ...create, prompt: 'Summarize', timeoutMs: 90_000, at: '1h' });
  assert.equal((store.jobs()[0]!.spec.task as { timeoutMs: number }).timeoutMs, 90_000);
});

test('a session with no agent can only schedule a prompt when the agent is named', async t => {
  const { handler, store } = world(t, { session: async () => ({ location: { directory: '/team' } }) });
  await assert.rejects(
    handler({ ...create, prompt: 'Summarize', at: '1h' }),
    refused(400, /^This session has no agent; pass agent explicitly\.$/),
  );
  await handler({ ...create, prompt: 'Summarize', at: '1h', agent: 'assistant' });
  assert.equal((store.jobs()[0]!.spec.task as { agent: string }).agent, 'assistant');
});

test('agent jobs run in the default pool when the operator names none', async t => {
  const { handler, store } = world(t);
  await handler({ ...create, prompt: 'Summarize', at: '1h' });
  assert.equal(store.jobs()[0]!.spec.resource, 'default');
});

for (const action of ['pause', 'resume', 'remove', 'run'] as const)
  test(`${action} of a job that does not exist is a 404 with the store's words`, async t => {
    const { handler } = world(t);
    await assert.rejects(
      handler({ action, sessionId: 'ses_1', id: 'agent-nope' }),
      refused(404, /Unknown job: agent-nope/),
    );
  });

test('resuming a job says when it runs next', async t => {
  const { handler } = world(t);
  const recurring = (await handler({ ...create, prompt: 'Weekly summary', cron: '0 9 * * 1', timezone: 'UTC' }))
    .items[0]!;
  const oneOff = (await handler({ ...create, command: ['sh', 'x.sh'], at: '2h', timezone: 'UTC' })).items[0]!;
  for (const item of [recurring, oneOff]) {
    await handler({ action: 'pause', sessionId: 'ses_1', id: item.id });
  }
  const weekly = await handler({ action: 'resume', sessionId: 'ses_1', id: recurring.id });
  assert.match(weekly.summary, /^Resumed "Weekly summary" \(agent-[0-9a-f]{8}\)\. Next: Sep 21, 2026, 9:00\sAM/);
  const once = await handler({ action: 'resume', sessionId: 'ses_1', id: oneOff.id });
  assert.match(once.summary, /^Resumed `sh x\.sh` \(agent-[0-9a-f]{8}\)\. Next: Sep 15, 2026, 12:00\sPM/);
});

test('the list says what exists, what is paused and what already ran', async t => {
  const { handler, store } = world(t);
  assert.deepEqual(await handler({ action: 'list', sessionId: 'ses_1' }), {
    summary: 'No agent-created jobs exist.',
    items: [],
  });
  const weekly = (await handler({ ...create, prompt: 'Weekly summary', cron: '0 9 * * 1', timezone: 'UTC' })).items[0]!;
  const once = (await handler({ ...create, command: ['sh', 'x.sh'], at: '2h', timezone: 'UTC' })).items[0]!;
  await handler({ action: 'pause', sessionId: 'ses_1', id: weekly.id });
  store.materializeDue(NOW + 2 * HOUR);
  const listed = await handler({ action: 'list', sessionId: 'ses_1' });
  const [paused, fired] = listed.summary.split('\n');
  assert.equal(paused, `${weekly.id}: "Weekly summary", cron 0 9 * * 1 (UTC) (paused)`);
  assert.match(
    fired!,
    new RegExp(`^${once.id}: \`sh x\\.sh\`, at Sep 15, 2026, 12:00\\sPM \\(UTC\\), last run queued$`),
  );
  assert.deepEqual(
    listed.items.map(item => [item.id, item.next, item.lastRun?.state]),
    [
      [weekly.id, [], undefined],
      [once.id, [], 'queued'],
    ],
    'a one-off that has fired has no next occurrence',
  );
});

test('a job is titled by its first line, cut at sixty characters; a script by its command; an operation by its name', async t => {
  const { handler, store } = world(t, {}, { max: 10 });
  await handler({ ...create, prompt: 'First line\nsecond line', at: '1h' });
  await handler({ ...create, prompt: `${'x'.repeat(59)}yz`, at: '1h' });
  await handler({
    ...create,
    command: ['sh', '-c', 'echo "a very long command line that goes on and on and on and on"'],
    at: '1h',
  });
  store.addJob(
    jobSchema.parse({ id: 'agent-legacy', cron: '0 9 * * *', task: { kind: 'invocation', name: 'linear.sweep' } }),
    'agent',
    NOW,
  );
  const titles = (await handler({ action: 'list', sessionId: 'ses_1' })).items.map(item => item.title);
  assert.deepEqual(
    titles.sort(),
    [
      '"First line"',
      `"${'x'.repeat(59)}…"`,
      '`sh -c echo "a very long command line that goes on and on and`',
      'linear.sweep',
    ].sort(),
  );
});

test('the limit does not refuse a retry of the message that already made the last allowed job', async t => {
  const { handler, store } = world(t, {}, { max: 1 });
  const first = await handler({ ...create, prompt: 'Summarize', at: '1h', messageId: 'msg_1' });
  const retried = await handler({ ...create, prompt: 'Summarize', at: '1h', messageId: 'msg_1' });
  assert.equal(retried.items[0]!.id, first.items[0]!.id);
  assert.equal(store.jobs().length, 1);
  await assert.rejects(
    handler({ ...create, prompt: 'Another', at: '1h', messageId: 'msg_2' }),
    refused(409, /limit of 1 agent-created jobs/),
  );
});

test('a paused job still counts toward the limit; a one-off that has run its course does not', async t => {
  const { handler, store } = world(t, {}, { max: 1 });
  const first = (await handler({ ...create, prompt: 'Summarize', at: '1h' })).items[0]!;
  store.materializeDue(NOW + HOUR);
  const [run] = store.runs({ jobId: first.id });
  store.finish(store.claimRun(run!.id, 'host', NOW + HOUR)!.id, 'host', 'succeeded', null, 'done', NOW + HOUR);
  assert.equal(store.job(first.id).state, 'done');
  const second = (await handler({ ...create, prompt: 'Weekly', cron: '0 9 * * 1' })).items[0]!;
  await handler({ action: 'pause', sessionId: 'ses_1', id: second.id });
  await assert.rejects(
    handler({ ...create, prompt: 'Third', at: '1h' }),
    refused(409, /limit of 1 agent-created jobs/),
  );
});

test('without a clock of its own the handler anchors jobs on the real one', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const handler = createJobHandler({
    store,
    loaded: { path: '/config.json', config: configSchema.parse({ version: 1 }), projects: [], sources: [] },
    channels: new Channels(async () => {}),
    opencode: async () =>
      ({
        session: { get: async () => ({ agent: 'assistant', location: { directory: '/team' } }) },
        agent: { list: async () => ({ data: [{ id: 'assistant' }] }) },
      }) as unknown as OpenCodeClient,
  });
  const before = Date.now();
  const { items } = await handler({ ...create, prompt: 'Summarize', at: '1h' });
  const { nextAt } = store.job(items[0]!.id);
  assert.ok(nextAt! >= before + HOUR && nextAt! <= Date.now() + HOUR, 'one hour from the real now');
});

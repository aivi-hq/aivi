import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Run, RunState } from '@aivi/core';
import { configSchema, jobSchema, taskSchema } from '@aivi/core';
import type { ChannelModule } from '@aivi/plugin/channel';
import { Channels } from '../src/channel/router.ts';
import { Dispatcher } from '../src/dispatcher/dispatcher.ts';
import { LeaseStore } from '../src/dispatcher/leases.ts';
import { describeOutcome, reentryPrompt, reportTarget, shouldReport } from '../src/reports.ts';
import { Scheduler } from '../src/scheduler.ts';
import { Store } from '../src/store.ts';

const module = (id: string, overrides: Partial<ChannelModule> = {}): ChannelModule => ({
  id,
  accepts: () => true,
  ownsSession: () => false,
  channelOf: async () => undefined,
  reenter: async () => {},
  post: async () => {},
  ...overrides,
});

test('report policy selects which outcomes are delivered', () => {
  assert.equal(shouldReport(null, 'succeeded'), false);
  const discord = { to: 'channel', module: 'discord', channel: '1' } as const;
  assert.equal(shouldReport({ ...discord, on: 'never' }, 'failed'), false);
  assert.equal(shouldReport({ ...discord, on: 'failure' }, 'succeeded'), false);
  assert.equal(shouldReport({ ...discord, on: 'failure' }, 'blocked'), true);
  assert.equal(shouldReport({ ...discord, on: 'failure' }, 'missed'), true, 'a missed occurrence is a failure');
  assert.equal(shouldReport({ ...discord, on: 'always' }, 'succeeded'), true);
  assert.equal(shouldReport({ to: 'session', session: 'ses_1', on: 'failure' }, 'failed'), true);
});

test('outcome text prefers the agent answer or shell output and stays bounded', () => {
  const base = {
    id: 'abcdef12-0000',
    resource: 'r',
    state: 'succeeded',
    createdAt: 0,
    scheduledFor: 0,
    startedAt: null,
    finishedAt: null,
    jobId: 'daily',
    sessionId: null,
    owner: null,
    result: null,
    error: null,
    report: null,
  } as const;
  const prompt: Run = {
    ...base,
    task: taskSchema.parse({ kind: 'prompt', agent: 'a', directory: '/d', prompt: 'p' }),
  };
  assert.equal(
    describeOutcome(prompt, 'succeeded', { text: 'All good' }, 'completed'),
    '✅ daily (prompt) succeeded\nAll good',
  );
  const shell: Run = { ...base, jobId: 'job-abcdef12', task: taskSchema.parse({ kind: 'shell', command: ['x'] }) };
  assert.equal(
    describeOutcome(shell, 'failed', { exitCode: 2, stdout: '', stderr: 'boom' }, 'Command exited with 2'),
    '❌ job-abcdef12 (shell) failed\nCommand exited with 2\nexit 2\nboom',
  );
  assert.equal(
    describeOutcome(shell, 'missed', null, 'missed: aivi was not running at Sep 15, 2026, 9:00 AM (UTC)'),
    '⏭ job-abcdef12 (shell) missed\nmissed: aivi was not running at Sep 15, 2026, 9:00 AM (UTC)',
  );
  assert.ok(describeOutcome(prompt, 'succeeded', { text: 'x'.repeat(5000) }, 'completed').length <= 4000);
  assert.equal(
    describeOutcome({ ...prompt, sessionId: 'ses_aivi_1' }, 'succeeded', { text: 'All good' }, 'completed'),
    '✅ daily (prompt) succeeded\nAll good\nsession ses_aivi_1 in OpenCode',
    'an agent job links its transcript',
  );
  const dreaming: Run = {
    ...base,
    task: taskSchema.parse({
      kind: 'invocation',
      name: 'dreaming',
      args: { directory: '/d', memoryDirectory: '/k/memory' },
    }),
  };
  const text = describeOutcome(
    dreaming,
    'succeeded',
    { reviewed: 4, changed: ['facts.md'], sessions: ['ses_x'], transcript: '/secret/path.md', text: 'Added 1 fact.' },
    'completed',
  );
  assert.equal(text, '✅ daily (dreaming) succeeded\nReviewed 4 conversation(s); updated facts.md.\nAdded 1 fact.');
  assert.ok(!text.includes('/secret') && !text.includes('ses_x'), 'no paths or session ids in chat');
  assert.match(
    describeOutcome(dreaming, 'succeeded', { reviewed: 0, changed: [] }, 'completed'),
    /No new conversations/,
  );
});

test('scheduled outcomes are posted through the registered channel module and audited; failures are audited too', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const config = configSchema.parse({ version: 1 });
  const nightly = jobSchema.parse({
    id: 'nightly',
    cron: '* * * * *',
    task: { kind: 'invocation', name: 'system.check' },
    report: { to: 'channel', module: 'discord', channel: '42' },
  });
  store.syncJobs([nightly], [], 0);
  store.materializeDue(60_000);
  const delivered: [string, string][] = [];
  const channels = new Channels();
  const unregister = channels.register(
    module('discord', {
      async post(channel, text) {
        delivered.push([channel, text]);
      },
    }),
  );
  const run = async (now: number) => {
    // Invocation work holds no lease: the dispatcher's client is never reached.
    const dispatcher = new Dispatcher({
      leases: new LeaseStore(store),
      dispatcher: configSchema.parse({ version: 1 }).dispatcher,
      opencode: async () => {
        throw new Error('not needed');
      },
      idleMs: 600_000,
      prepareMs: 600_000,
    });
    const scheduler = new Scheduler(
      store,
      config.scheduler,
      dispatcher,
      () => false,
      async () => ({ state: 'succeeded', result: { ok: true } }),
      undefined,
      async (run, state, result, reason) => {
        if (!shouldReport(run.report, state)) return;
        try {
          await channels.deliver(run.report, describeOutcome(run, state, result, reason), { run, state });
          store.note(run.id, 'reported', reportTarget(run.report));
        } catch (error) {
          store.note(run.id, 'report-failed', (error as Error).message);
        }
      },
    );
    scheduler.tick(now);
    await scheduler.drain();
  };
  await run(61_000);
  const first = store.runs()[0]!;
  assert.deepEqual(first.report, { to: 'channel', module: 'discord', channel: '42', on: 'always' });
  assert.deepEqual(delivered, [['42', '✅ nightly (system.check) succeeded\n{"ok":true}']]);
  assert.deepEqual(store.history(first.id).at(-1), {
    ...store.history(first.id).at(-1),
    action: 'reported',
    reason: 'discord:42',
  });

  unregister();
  store.materializeDue(120_000);
  await run(121_000);
  const second = store.runs()[1]!;
  assert.equal(second.state, 'succeeded', 'a delivery failure never changes the run outcome');
  assert.match(store.history(second.id).at(-1)!.reason, /No channel module "discord"/);
});

test('a report to "session" goes to the module that owns the session, else into the native session', async () => {
  const native: string[] = [];
  const channels = new Channels(async (sessionId, text) => {
    native.push(`${sessionId}:${text}`);
  });
  const reentered: string[] = [];
  const unregister = channels.register(
    module('discord', {
      accepts: c => c === '42',
      ownsSession: id => id.startsWith('ses_discord_'),
      async reenter(id, text) {
        reentered.push(`${id}:${text}`);
      },
    }),
  );
  const run = {
    id: 'r1',
    jobId: 'j',
    task: taskSchema.parse({ kind: 'invocation', name: 'system.check' }),
    resource: 'r',
    state: 'succeeded',
    createdAt: 0,
    scheduledFor: 0,
    startedAt: null,
    finishedAt: null,
    sessionId: null,
    owner: null,
    result: null,
    error: null,
    report: null,
  } satisfies Run;
  const context = { run, state: 'succeeded' as const };
  await channels.deliver({ to: 'session', session: 'ses_discord_1', on: 'always' }, 'hi', context);
  await channels.deliver({ to: 'session', session: 'ses_native', on: 'always' }, 'yo', context);
  assert.deepEqual(reentered, ['ses_discord_1:hi']);
  assert.deepEqual(native, ['ses_native:yo']);
  assert.equal(channels.ownsSession('ses_discord_1'), true);
  assert.equal(channels.ownerOf('ses_discord_1'), 'discord');
  assert.equal(channels.ownsSession('ses_native'), false);
  assert.equal(channels.refuse({ to: 'session', session: 'x', on: 'always' }), undefined);
  const discord = { to: 'channel', module: 'discord', on: 'always' } as const;
  assert.match(channels.refuse({ ...discord, channel: '1' }) ?? '', /does not allow posting to 1/);
  assert.equal(channels.refuse({ ...discord, channel: '42' }), undefined);
  assert.match(channels.refuse({ ...discord, module: 'slack', channel: '42' }) ?? '', /No channel module "slack"/);
  assert.throws(() => channels.register(module('session')), /not a module id/);
  assert.throws(() => channels.register(module('discord')), /already registered/);
  unregister();
  assert.match(channels.refuse({ ...discord, channel: '42' }) ?? '', /No channel module "discord"/);
  await channels.deliver({ to: 'session', session: 'ses_discord_1', on: 'always' }, 'later', context);
  assert.deepEqual(native.at(-1), 'ses_discord_1:later', 'without an owner the native path is used');
  assert.match(reentryPrompt('body'), /^\[aivi delivers the outcome[^\]]*\]\nbody$/);
});

const reportedAt = Date.parse('2026-09-15T09:00:00Z');
const runFor = (task: unknown, over: Partial<Run> = {}): Run => ({
  id: 'abcdef12-0000',
  jobId: 'job',
  task: taskSchema.parse(task),
  resource: 'r',
  state: 'succeeded',
  createdAt: 0,
  scheduledFor: reportedAt,
  startedAt: null,
  finishedAt: null,
  sessionId: null,
  owner: null,
  result: null,
  error: null,
  report: null,
  ...over,
});
const operation = (name: string) => ({ kind: 'invocation', name });
const script = { kind: 'shell', command: ['x'] };

const outcomes: [string, unknown, RunState, unknown, string | undefined, string][] = [
  [
    'a sources check names the missing ones',
    operation('system.check'),
    'succeeded',
    {
      sources: [
        { id: 'handbook', available: true },
        { id: 'adrs', available: false },
      ],
    },
    undefined,
    '✅ job (system.check) succeeded\nMissing sources: adrs',
  ],
  [
    'a sources check with every source there says so',
    operation('system.check'),
    'succeeded',
    { sources: [{ id: 'handbook', available: true }] },
    undefined,
    '✅ job (system.check) succeeded\nAll 1 knowledge sources available.',
  ],
  [
    'a sources check whose result has another shape is shown raw',
    operation('system.check'),
    'succeeded',
    { ok: true },
    undefined,
    '✅ job (system.check) succeeded\n{"ok":true}',
  ],
  [
    'a projects sync lists what moved and what was left alone, and why',
    operation('projects.sync'),
    'succeeded',
    {
      projects: [
        { id: 'site', state: 'updated' },
        { id: 'api', state: 'skipped', reason: 'local changes in source/' },
      ],
    },
    undefined,
    '✅ job (projects.sync) succeeded\nUpdated: site.\nSkipped: api (local changes in source/).',
  ],
  [
    'a projects sync with nothing to do says every checkout is current',
    operation('projects.sync'),
    'succeeded',
    { projects: [{ id: 'site', state: 'current' }] },
    undefined,
    '✅ job (projects.sync) succeeded\nAll 1 project checkout(s) current.',
  ],
  [
    'a projects sync whose result has another shape is shown raw',
    operation('projects.sync'),
    'succeeded',
    { projects: 'none' },
    undefined,
    '✅ job (projects.sync) succeeded\n{"projects":"none"}',
  ],
  [
    'a prune says what it deleted, expired link codes included',
    operation('runs.prune'),
    'succeeded',
    { runs: 3, jobs: 1, linkCodes: 2 },
    undefined,
    '✅ job (runs.prune) succeeded\nDeleted 3 run(s) and 1 finished one-off job(s) and 2 expired link code(s).',
  ],
  [
    'a prune that found no expired link codes does not mention them',
    operation('runs.prune'),
    'succeeded',
    { runs: 3, jobs: 0, linkCodes: 0 },
    undefined,
    '✅ job (runs.prune) succeeded\nDeleted 3 run(s) and 0 finished one-off job(s).',
  ],
  [
    'a dreaming run that reviewed nothing says there was nothing new',
    operation('dreaming'),
    'succeeded',
    { changed: [] },
    undefined,
    '✅ job (dreaming) succeeded\nNo new conversations to review.',
  ],
  [
    'a dreaming run that changed no memory file says the memory is unchanged',
    operation('dreaming'),
    'succeeded',
    { reviewed: 2, changed: 'facts.md' },
    undefined,
    '✅ job (dreaming) succeeded\nReviewed 2 conversation(s); memory unchanged.',
  ],
  [
    'a shell run that printed nothing shows its exit code alone',
    script,
    'succeeded',
    { exitCode: 0 },
    undefined,
    '✅ job (shell) succeeded\nexit 0',
  ],
  [
    'a module’s own operation shows its result raw',
    operation('linear.sweep'),
    'succeeded',
    { removed: 1 },
    undefined,
    '✅ job (linear.sweep) succeeded\n{"removed":1}',
  ],
  [
    'a run with no result has no body',
    operation('system.check'),
    'succeeded',
    null,
    undefined,
    '✅ job (system.check) succeeded',
  ],
  [
    'a falsy result is shown as it is, not dropped',
    operation('system.check'),
    'succeeded',
    0,
    undefined,
    '✅ job (system.check) succeeded\n0',
  ],
  [
    'a blocked run with no output leads with why',
    operation('system.check'),
    'blocked',
    null,
    'Host stopped while the command was running',
    '⏸ job (system.check) blocked\nHost stopped while the command was running',
  ],
  [
    'a missed occurrence with no reason says when aivi was not running',
    operation('system.check'),
    'missed',
    null,
    undefined,
    '⏭ job (system.check) missed\nmissed: aivi was not running at 2026-09-15T09:00:00.000Z',
  ],
];

for (const [name, task, state, result, reason, expected] of outcomes)
  test(`outcome text: ${name}`, () => {
    assert.equal(describeOutcome(runFor(task), state, result, reason), expected);
  });

test('a report is audited by where it went: the session or the module and its channel', () => {
  assert.equal(reportTarget({ to: 'session', session: 'ses_1', on: 'always' }), 'session:ses_1');
  assert.equal(reportTarget({ to: 'channel', module: 'discord', channel: '42', on: 'always' }), 'discord:42');
});

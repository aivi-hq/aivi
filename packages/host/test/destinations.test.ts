import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Job } from '@aivi/core';
import { configSchema, scheduleSchema, taskSchema } from '@aivi/core';
import { Destinations, describeOutcome, reentryPrompt, reportTarget, shouldReport } from '../src/destinations.ts';
import { Scheduler } from '../src/scheduler.ts';
import { Store } from '../src/store.ts';

test('report policy selects which outcomes are delivered', () => {
  assert.equal(shouldReport(null, 'succeeded'), false);
  const discord = { to: 'channel', module: 'discord', channel: '1' } as const;
  assert.equal(shouldReport({ ...discord, on: 'never' }, 'failed'), false);
  assert.equal(shouldReport({ ...discord, on: 'failure' }, 'succeeded'), false);
  assert.equal(shouldReport({ ...discord, on: 'failure' }, 'blocked'), true);
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
    scheduleId: 'daily',
    sessionId: null,
    owner: null,
    result: null,
    error: null,
    report: null,
  } as const;
  const prompt: Job = {
    ...base,
    task: taskSchema.parse({ kind: 'opencode.prompt', agent: 'a', directory: '/d', prompt: 'p' }),
  };
  assert.equal(
    describeOutcome(prompt, 'succeeded', { text: 'All good' }, 'completed'),
    '✅ schedule daily (opencode.prompt) succeeded\nAll good',
  );
  const shell: Job = { ...base, scheduleId: null, task: taskSchema.parse({ kind: 'shell', command: ['x'] }) };
  assert.equal(
    describeOutcome(shell, 'failed', { exitCode: 2, stdout: '', stderr: 'boom' }, 'Command exited with 2'),
    '❌ job abcdef12 (shell) failed\nCommand exited with 2\nexit 2\nboom',
  );
  assert.ok(describeOutcome(prompt, 'succeeded', { text: 'x'.repeat(5000) }, 'completed').length <= 4000);
  assert.equal(
    describeOutcome({ ...prompt, sessionId: 'ses_aivi_1' }, 'succeeded', { text: 'All good' }, 'completed'),
    '✅ schedule daily (opencode.prompt) succeeded\nAll good\nsession ses_aivi_1 in OpenCode',
    'an agent job links its transcript',
  );
  const dreaming: Job = {
    ...base,
    task: taskSchema.parse({ kind: 'dreaming', directory: '/d', memoryDirectory: '/k/memory' }),
  };
  const text = describeOutcome(
    dreaming,
    'succeeded',
    { reviewed: 4, changed: ['facts.md'], sessions: ['ses_x'], transcript: '/secret/path.md', text: 'Added 1 fact.' },
    'completed',
  );
  assert.equal(
    text,
    '✅ schedule daily (dreaming) succeeded\nReviewed 4 conversation(s); updated facts.md.\nAdded 1 fact.',
  );
  assert.ok(!text.includes('/secret') && !text.includes('ses_x'), 'no paths or session ids in chat');
  assert.match(
    describeOutcome(dreaming, 'succeeded', { reviewed: 0, changed: [] }, 'completed'),
    /No new conversations/,
  );
});

test('scheduled outcomes are delivered to the registered destination and audited; failures are audited too', async t => {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const config = configSchema.parse({ version: 1 });
  const schedule = scheduleSchema.parse({
    id: 'nightly',
    cron: '* * * * *',
    task: { kind: 'system.check' },
    report: { to: 'channel', module: 'discord', channel: '42' },
  });
  store.syncSchedules([schedule], 0);
  store.materializeDue(60_000);
  const delivered: [string, string][] = [];
  const destinations = new Destinations();
  const unregister = destinations.register('discord', {
    async deliver(channel, text) {
      delivered.push([channel, text]);
    },
  });
  const run = async (now: number) => {
    const scheduler = new Scheduler(
      store,
      config.scheduler,
      async () => ({ state: 'succeeded', result: { ok: true } }),
      undefined,
      async (job, state, result, reason) => {
        if (!shouldReport(job.report, state)) return;
        try {
          await destinations.deliver(job.report, describeOutcome(job, state, result, reason), { job, state });
          store.note(job.id, 'reported', reportTarget(job.report));
        } catch (error) {
          store.note(job.id, 'report-failed', (error as Error).message);
        }
      },
    );
    scheduler.tick(now);
    await scheduler.drain();
  };
  await run(61_000);
  const first = store.list()[0]!;
  assert.deepEqual(first.report, { to: 'channel', module: 'discord', channel: '42', on: 'always' });
  assert.deepEqual(delivered, [['42', '✅ schedule nightly (system.check) succeeded\n{"ok":true}']]);
  assert.deepEqual(store.history(first.id).at(-1), {
    ...store.history(first.id).at(-1),
    action: 'reported',
    reason: 'discord:42',
  });

  unregister();
  store.materializeDue(120_000);
  await run(121_000);
  const second = store.list()[1]!;
  assert.equal(second.state, 'succeeded', 'a delivery failure never changes the job outcome');
  assert.match(store.history(second.id).at(-1)!.reason, /No channel module "discord"/);
});

test('a report to "session" goes to the module that owns the session, else into the native session', async () => {
  const native: string[] = [];
  const destinations = new Destinations(async (sessionId, text) => {
    native.push(`${sessionId}:${text}`);
  });
  const reentered: string[] = [];
  const unregister = destinations.registerSessionOwner({
    id: 'discord',
    owns: id => id.startsWith('ses_discord_'),
    async reenter(id, text) {
      reentered.push(`${id}:${text}`);
    },
  });
  const job = {
    id: 'j',
    task: taskSchema.parse({ kind: 'system.check' }),
    resource: 'r',
    state: 'succeeded',
    createdAt: 0,
    scheduledFor: 0,
    startedAt: null,
    finishedAt: null,
    scheduleId: null,
    sessionId: null,
    owner: null,
    result: null,
    error: null,
    report: null,
  } satisfies Job;
  const context = { job, state: 'succeeded' as const };
  await destinations.deliver({ to: 'session', session: 'ses_discord_1', on: 'always' }, 'hi', context);
  await destinations.deliver({ to: 'session', session: 'ses_native', on: 'always' }, 'yo', context);
  assert.deepEqual(reentered, ['ses_discord_1:hi']);
  assert.deepEqual(native, ['ses_native:yo']);
  assert.equal(destinations.ownsSession('ses_discord_1'), true);
  assert.equal(destinations.ownerOf('ses_discord_1'), 'discord');
  assert.equal(destinations.ownsSession('ses_native'), false);
  assert.equal(destinations.refuse({ to: 'session', session: 'x', on: 'always' }), undefined);
  const discord = { to: 'channel', module: 'discord', on: 'always' } as const;
  assert.match(destinations.refuse({ ...discord, channel: '1' }) ?? '', /No channel module "discord"/);
  destinations.register('discord', { accepts: c => c === '42', deliver: async () => {} });
  assert.match(destinations.refuse({ ...discord, channel: '1' }) ?? '', /does not allow posting to 1/);
  assert.equal(destinations.refuse({ ...discord, channel: '42' }), undefined);
  assert.throws(() => destinations.register('session', { deliver: async () => {} }), /reserved/);
  unregister();
  await destinations.deliver({ to: 'session', session: 'ses_discord_1', on: 'always' }, 'later', context);
  assert.deepEqual(native.at(-1), 'ses_discord_1:later', 'without an owner the native path is used');
  assert.match(reentryPrompt('body'), /^\[aivi delivers the outcome[^\]]*\]\nbody$/);
});

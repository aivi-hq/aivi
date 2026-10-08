/**
 * The ticket desk at the host's seam. The host claims the `aivi_ticket_*` ids
 * once for the whole home, guards whose run a call comes from, and routes it
 * to the desk of the tracker that works that run's ticket. What a ticket *is*
 * on a platform is each tracker's own test; the permission gate is OpenCode's
 * own. What lives here: which ids exist, who may call, what the
 * arguments must be, and that the call reaches the right tracker's desk.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { Logger } from '@aivi/core';
import { TICKET_TOOL_ACTIONS } from '@aivi/plugin';
import type { RunView } from '@aivi/plugin/run';
import type { TicketDesk, Tracker } from '@aivi/plugin/tracker';
import { createTicketDesk, type DeskTool } from '../src/ticket-desk.ts';
import { ToolError } from '../src/tools.ts';

const quiet = {
  info: () => {},
  debug: () => {},
  warn: () => {},
  error: () => {},
  getChild: () => quiet,
  with: () => quiet,
} as unknown as Logger;

/** A desk that records every call and answers from one standing ticket, so a
 *  test sees exactly what the host asked of the tracker, in what words. */
class FakeDesk {
  calls: string[] = [];
  posted: string[] = [];
  created: { title: string; description: string }[] = [];
  applied: { label: string; on: boolean }[] = [];
  edited: { title?: string; description?: string }[] = [];

  async read(): Promise<ReturnType<TicketDesk['read']>> {
    this.calls.push('read');
    return {
      identifier: 'X-1',
      title: 'Ship it',
      description: 'Body',
      lane: 'Triage',
      labels: ['now'],
      url: 'https://x/1',
    };
  }
  async comments() {
    this.calls.push('comments');
    return [{ author: 'aivi', body: 'a note', at: '2026-10-07' }];
  }
  async labels() {
    this.calls.push('labels');
    return { team: ['now', 'later'], on: ['now'] };
  }
  async edit(_run: RunView, changes: { title?: string; description?: string }) {
    this.calls.push('edit');
    this.edited.push(changes);
    return { identifier: 'X-1', title: changes.title ?? 'Ship it', url: 'https://x/1' };
  }
  async comment(_run: RunView, text: string) {
    this.calls.push('comment');
    this.posted.push(text);
  }
  async create(_run: RunView, input: { title: string; description: string }) {
    this.calls.push('create');
    this.created.push(input);
    return { identifier: 'X-9', url: 'https://x/9', lane: 'Triage' };
  }
  async label(_run: RunView, label: string, on: boolean) {
    this.calls.push('label');
    this.applied.push({ label, on });
  }
}

const harness = () => {
  const runs = new Map<string, RunView>();
  const desks = new Map<string, FakeDesk>();
  const trackers = new Map<string, Tracker>();
  const wakes: string[] = [];
  const register = (trackerId: string) => {
    const desk = new FakeDesk();
    desks.set(trackerId, desk);
    trackers.set(trackerId, { id: trackerId, desk: desk as unknown as TicketDesk } as Tracker);
    return desk;
  };
  const tools = createTicketDesk(
    {
      runBySession: session => runs.get(session),
      tracker: id => trackers.get(id),
      wake: async projectId => void wakes.push(projectId),
    },
    quiet,
  );
  const byId = new Map<string, DeskTool>(tools.map(t => [`${t.descriptor.namespace}_${t.descriptor.name}`, t]));
  return {
    tools,
    desks,
    wakes,
    register,
    startRun: (over: Partial<RunView> = {}) => {
      runs.set('ses_w', {
        id: 'run_1',
        projectId: 'p',
        trackerId: 'tracker-linear',
        ticketId: 't-1',
        lane: 'Triage',
        agent: 'product',
        state: 'working',
        updatedAt: 0,
        ...over,
      } as RunView);
    },
    call: (id: string, input: Record<string, unknown> = {}, session = 'ses_w') =>
      byId.get(id)!.handler({ sessionId: session, input }),
  };
};

test('the desk claims exactly the ids the kit names — no more, no less', () => {
  assert.deepEqual(
    harness()
      .tools.map(t => `${t.descriptor.namespace}_${t.descriptor.name}`)
      .sort(),
    [...TICKET_TOOL_ACTIONS].sort(),
    'the desk is TICKET_TOOL_ACTIONS, what the installer’s wildcard must cover and the agent file allows',
  );
});

test('the desk answers the run that owns the ticket, and nobody else’s session', async () => {
  const owned = harness();
  owned.register('tracker-linear');
  await assert.rejects(
    () => owned.call('aivi_ticket_read', {}, 'ses_stranger'),
    (e: unknown) => e instanceof ToolError && e.status === 404 && /not an aivi run/.test(e.message),
    'a session outside the ledger gets the plain reason, never a ticket',
  );
  owned.startRun({ state: 'completed' });
  await assert.rejects(() => owned.call('aivi_ticket_read'), /run has ended/);
  owned.startRun({ trackerId: 'unregistered' });
  await assert.rejects(
    () => owned.call('aivi_ticket_read'),
    /not registered/,
    'a run whose tracker left says so plainly',
  );
});

test('a call reaches the desk of the tracker that works the run, never another’s', async () => {
  const owned = harness();
  const linear = owned.register('tracker-linear');
  const github = owned.register('tracker-github');
  owned.startRun();
  assert.deepEqual(await owned.call('aivi_ticket_read'), {
    identifier: 'X-1',
    title: 'Ship it',
    description: 'Body',
    lane: 'Triage',
    labels: ['now'],
    url: 'https://x/1',
  });
  owned.startRun({ trackerId: 'tracker-github' });
  await owned.call('aivi_ticket_read');
  assert.deepEqual(linear.calls, ['read'], 'the Linear desk answered the Linear run');
  assert.deepEqual(github.calls, ['read'], 'and the GitHub desk answered the GitHub run');
});

test('comments land on the ticket through the tracker’s desk', async () => {
  const owned = harness();
  const desk = owned.register('tracker-linear');
  owned.startRun();
  assert.deepEqual(await owned.call('aivi_ticket_comment', { text: 'a note for people' }), { posted: true });
  assert.deepEqual(await owned.call('aivi_ticket_comments'), {
    comments: [{ author: 'aivi', body: 'a note', at: '2026-10-07' }],
  });
  assert.deepEqual(desk.posted, ['a note for people'], 'the note is on the ticket, not the session');
});

test('edit validates the hand before the tracker is asked', async () => {
  const owned = harness();
  const desk = owned.register('tracker-linear');
  owned.startRun();
  await assert.rejects(() => owned.call('aivi_ticket_edit', {}), /Give a title, a description, or both/);
  await assert.rejects(
    () => owned.call('aivi_ticket_edit', { title: 'x'.repeat(251) }),
    /title is longer than 250 characters/,
  );
  assert.equal(desk.calls.length, 0, 'a refused call never reached the tracker');
  assert.deepEqual(await owned.call('aivi_ticket_edit', { title: 'Sharper' }), {
    identifier: 'X-1',
    title: 'Sharper',
    url: 'https://x/1',
  });
  assert.deepEqual(desk.edited, [{ title: 'Sharper' }], 'the description was never mentioned, never touched');
});

test('labels: the catalogue answers, add and remove are one operation each', async () => {
  const owned = harness();
  const desk = owned.register('tracker-linear');
  owned.startRun();
  assert.deepEqual(await owned.call('aivi_ticket_labels'), { team: ['now', 'later'], on: ['now'] });
  await owned.call('aivi_ticket_add_label', { label: 'later' });
  await owned.call('aivi_ticket_remove_label', { label: 'now' });
  assert.deepEqual(desk.applied, [
    { label: 'later', on: true },
    { label: 'now', on: false },
  ]);
});

test('create wakes the walk itself, webhook or no webhook', async () => {
  const owned = harness();
  const desk = owned.register('tracker-linear');
  owned.startRun();
  assert.deepEqual(
    await owned.call('aivi_ticket_create', { title: 'A separate thing', description: 'Found while sharpening X-1.' }),
    {
      identifier: 'X-9',
      url: 'https://x/9',
      lane: 'Triage',
    },
  );
  assert.deepEqual(desk.created, [{ title: 'A separate thing', description: 'Found while sharpening X-1.' }]);
  assert.deepEqual(owned.wakes, ['p'], 'the escape hatch wakes the walk, webhook or no webhook');
  await assert.rejects(
    () => owned.call('aivi_ticket_create', { title: '', description: 'x' }),
    /title must be a non-empty string/,
  );
});

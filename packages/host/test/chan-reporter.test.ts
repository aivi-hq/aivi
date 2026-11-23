import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import type { SessionEvent, SessionEventListener } from '@aivi/plugin/module';
import { type Editable, ProgressReporter } from '../src/channel/reporter.ts';
import { recorder } from './support.ts';

type Send = Editable['send'];
type Edit = Editable['edit'];
type Remove = NonNullable<Editable['delete']>;
type Notice = NonNullable<Editable['notice']>;

/** One reporter over a recorded delivery. The placeholder is `m1`; `emit` plays a session event into the
 *  reporter's watch. With no throttle every event that changes the text is edited at once. */
function world(options: { send?: Send; edit?: Edit; remove?: Remove; notice?: Notice } = {}) {
  const delivery = {
    send: mock.fn(options.send ?? (async () => 'm1')),
    edit: mock.fn(options.edit ?? (async () => {})),
    delete: mock.fn(options.remove ?? (async () => {})),
    ...(options.notice ? { notice: options.notice } : {}),
  };
  const watch = mock.fn((_session: string, _listener: SessionEventListener) => () => {});
  const { log, said } = recorder();
  const reporter = new ProgressReporter(
    delivery,
    'chan',
    'ses_1',
    { mode: 'status', events: { watch }, throttleMs: 0 },
    log,
  );
  const emit = (type: string, data: Record<string, unknown> = {}) => {
    const event: SessionEvent = { type, data: { sessionID: 'ses_1', ...data } };
    watch.mock.calls[0]!.arguments[1](event);
  };
  const calls = (fn: { mock: { calls: { arguments: unknown[] }[] } }) => fn.mock.calls.map(call => call.arguments);
  return { reporter, delivery, emit, calls, said };
}

test('a placeholder that cannot be posted is warned about, and the turn ends with plain messages', async () => {
  const refused = new Error('rate limited');
  const ends = [
    ['the answer', (reporter: ProgressReporter) => reporter.finish(['The', 'answer']), ['The', 'answer']],
    [
      'a failure notice',
      (reporter: ProgressReporter) => reporter.fail('Something went wrong'),
      ['Something went wrong'],
    ],
  ] as const;
  for (const [name, end, texts] of ends) {
    const { reporter, delivery, calls, said } = world({
      send: async (_conversation, text) => {
        if (text === '⏳ thinking…') throw refused;
        return undefined;
      },
    });
    await end(reporter);

    assert.deepEqual(calls(delivery.send), [['chan', '⏳ thinking…'], ...texts.map(text => ['chan', text])], name);
    assert.equal(
      delivery.edit.mock.callCount() + delivery.delete.mock.callCount(),
      0,
      `${name}: nothing to edit or delete`,
    );
    assert.deepEqual(said('warn'), [{ level: 'warn', event: 'progress.placeholder.failed', error: refused }], name);
  }
});

test('a progress edit that is refused is warned about, and the answer is still posted over the placeholder', async () => {
  const refused = new Error('message was deleted');
  const attempted = Promise.withResolvers<void>();
  const { reporter, delivery, emit, calls, said } = world({
    edit: async () => {
      attempted.resolve();
      throw refused;
    },
  });

  emit('session.tool.input.started', { id: 't1', name: 'read' });
  await attempted.promise;
  await reporter.finish(['Done']);

  assert.deepEqual(calls(delivery.edit), [['chan', 'm1', '🔧 reading']]);
  assert.deepEqual(said('warn'), [{ level: 'warn', event: 'progress.edit.failed', error: refused }]);
  assert.deepEqual(calls(delivery.send).slice(1), [['chan', 'Done']]);
  assert.deepEqual(calls(delivery.delete), [['chan', 'm1']]);
});

test('an event that leaves the shown text as it is edits nothing; the next one that changes it edits once', async () => {
  const edited = Promise.withResolvers<void>();
  const { reporter, delivery, emit, calls } = world({ edit: async () => edited.resolve() });

  emit('session.usage.updated');
  emit('session.tool.input.started', { id: 't1', name: 'read' });
  await edited.promise;
  await reporter.finish(['Done']);

  assert.deepEqual(calls(delivery.edit), [['chan', 'm1', '🔧 reading']]);
});

test('a placeholder that cannot be deleted is warned about, and the answer stays posted', async () => {
  const refused = new Error('missing permission');
  const { reporter, delivery, calls, said } = world({
    remove: async () => {
      throw refused;
    },
  });

  await reporter.finish(['Done']);

  assert.deepEqual(calls(delivery.send).slice(1), [['chan', 'Done']]);
  assert.deepEqual(calls(delivery.delete), [['chan', 'm1']]);
  assert.deepEqual(said('warn'), [{ level: 'warn', event: 'progress.delete.failed', error: refused }]);
});

test('a failure notice that cannot be edited into the placeholder is posted as a new message', async () => {
  const refused = new Error('message was deleted');
  const { reporter, delivery, calls, said } = world({
    edit: async () => {
      throw refused;
    },
  });

  await reporter.fail('Something went wrong');

  assert.deepEqual(calls(delivery.edit), [['chan', 'm1', 'Something went wrong']]);
  assert.deepEqual(calls(delivery.send).slice(1), [['chan', 'Something went wrong']]);
  assert.deepEqual(said('warn'), [{ level: 'warn', event: 'progress.edit.failed', error: refused }]);
});

test('a failure notice goes through the platform’s own notice channel when it has one, and the placeholder is left to it', async () => {
  const notice = mock.fn(async (_conversation: string, _text: string) => {});
  const { reporter, delivery, calls } = world({ notice });

  await reporter.fail('Something went wrong');

  assert.deepEqual(calls(notice), [['chan', 'Something went wrong']]);
  assert.equal(delivery.edit.mock.callCount(), 0);
  assert.equal(delivery.send.mock.callCount(), 1, 'only the placeholder was posted');
});

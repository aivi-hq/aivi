/** The Meet module's logic without a browser: by ruling (2026-10-13) the
 *  suite launches no Chrome. The button trail was proven twice outside the
 *  suite — in the lab fixture and in the operator's real meeting of
 *  2026-10-13 (waiting room, typed name, host admitted) — and `driveJoin`
 *  is kept as exactly the shape that ran there. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { meetConfigSchema, plugin } from '../src/config.ts';
import { createMeetModule } from '../src/module.ts';

test('the plugin declaration and the block defaults answer themselves', () => {
  assert.equal(plugin.id, 'google-meet');
  assert.deepEqual(meetConfigSchema.parse({}), {
    name: 'aivi',
    joinTimeoutMs: 60_000,
    askTimeoutMs: 900_000,
    mode: 'call',
    agent: 'assistant',
    headless: true,
  });
  assert.equal(meetConfigSchema.parse({ name: 'Clawd' }).name, 'Clawd');
  assert.equal(meetConfigSchema.parse({ mode: 'meeting' }).mode, 'meeting');
  assert.equal(meetConfigSchema.parse({ headless: false }).headless, false);
});

test('the module claims its operations at start and releases them at stop', async () => {
  const claimed = new Set<string>();
  const released: string[] = [];
  const noop = () => {};
  const services = {
    loaded: { path: '/home/config.json', config: { stateDirectory: '/home/state' } },
    log: { getChild: () => ({ info: noop, warn: noop, error: noop, debug: noop }) },
    tasks: { claim: (name: string) => claimed.add(name), release: (name: string) => released.push(name) },
  };
  const running = await createMeetModule(meetConfigSchema.parse({})).start(services as never);
  assert.deepEqual([...claimed], ['meet.join', 'meet.leave']);
  await running.stop();
  assert.deepEqual(released, ['meet.join', 'meet.leave']);
});

test('meet.join says its own name when handed a non-URL', async () => {
  const handlers = new Map<string, (run: never) => Promise<{ state: string; reason?: string }>>();
  const noop = () => {};
  const services = {
    loaded: { path: '/home/config.json', config: { stateDirectory: '/home/state' } },
    log: { getChild: () => ({ info: noop, warn: noop, error: noop, debug: noop }) },
    tasks: {
      claim: (name: string, handler: (run: never) => Promise<{ state: string; reason?: string }>) =>
        handlers.set(name, handler),
      release: () => {},
    },
  };
  const running = await createMeetModule(meetConfigSchema.parse({})).start(services as never);
  const run = { task: { kind: 'invocation', name: 'meet.join', args: { url: 'not a link' } } } as never;
  const result = await handlers.get('meet.join')!(run);
  assert.equal(result.state, 'failed');
  assert.match(result.reason ?? '', /meet\.join needs args/);
  await running.stop();
});

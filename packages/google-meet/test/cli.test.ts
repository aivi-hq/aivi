import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import { Store } from '@aivi/host';
import { cliFixture } from '../../plugin/test/cli-fixture.ts';
import cli from '../src/cli.ts';

const URL = 'https://meet.google.com/abc-defg-hij';
/** A process that is certainly there, and one that certainly is not. */
const LIVE = process.pid;
const DEAD = 2 ** 31 - 1;

/** A home with a store and a state directory; `call` writes the record serve keeps of a call. */
async function home(t: TestContext) {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'aivi-meet-cli-'));
  const store = new Store(':memory:');
  t.after(async () => {
    store.close();
    await rm(stateDirectory, { recursive: true, force: true });
  });
  const record = join(stateDirectory, 'meet.json');
  return {
    stateDirectory,
    store,
    record,
    call: (pid: number) =>
      writeFile(record, JSON.stringify({ pid, url: URL, phase: 'in-call', since: '2026-11-18T10:00:00Z' })),
  };
}

/** Serve's side of a request: the poke makes it run the queued job to this end. */
const serve = (store: Store, state: 'succeeded' | 'failed', result: unknown, reason: string) => () => {
  const [run] = store.runs({ state: 'queued' });
  store.claimRun(run!.id, 'serve');
  store.finish(run!.id, 'serve', state, result, reason);
};

/** Mock time, and a promise that settles when the command starts its wait:
 *  the moment to move the clock, observed and not guessed. */
function clock(t: TestContext) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse('2026-11-18T10:00:00Z') });
  const waiting = Promise.withResolvers<void>();
  const timeout = globalThis.setTimeout;
  t.mock.method(globalThis, 'setTimeout', (...args: Parameters<typeof setTimeout>) => {
    const handle = timeout(...args);
    waiting.resolve();
    return handle;
  });
  return waiting.promise;
}

test('meet status says whether a call is live, and calls a dead record stale', async t => {
  const { stateDirectory, record, call } = await home(t);
  const meet = cliFixture(cli, { stateDirectory });
  await meet.run('status');
  await writeFile(record, 'not json');
  await meet.run('status');
  await writeFile(record, JSON.stringify({ pid: 'none', url: URL }));
  await meet.run('status');
  assert.deepEqual(meet.printed, [{ running: false }, { running: false }, { running: false }]);
  assert.deepEqual(meet.said, ['Not in a call.', 'Not in a call.', 'Not in a call.']);

  await call(DEAD);
  await meet.run('status');
  assert.deepEqual(meet.printed[3], {
    running: false,
    stale: { pid: DEAD, url: URL, phase: 'in-call', since: '2026-11-18T10:00:00Z' },
  });
  assert.match(String(meet.said[3]), /stale — its process \d+ is gone/);

  await call(LIVE);
  await meet.run('status');
  assert.deepEqual(meet.printed[4], {
    running: true,
    pid: LIVE,
    url: URL,
    phase: 'in-call',
    since: '2026-11-18T10:00:00Z',
  });
});

test('meet join asks serve to join and follows the run to its end', async t => {
  const { stateDirectory, store, call } = await home(t);
  const joined = cliFixture(cli, {
    stateDirectory,
    store,
    onPoke: serve(store, 'succeeded', { title: 'Standup' }, ''),
  });
  await joined.run('join', URL);
  assert.deepEqual(joined.printed, [{ requesting: URL }, { joined: true, url: URL, title: 'Standup' }]);
  assert.equal(joined.pokes(), 1, 'serve is woken: the meeting is its work');
  const [job] = store.jobs();
  assert.deepEqual(job!.spec.task, { kind: 'invocation', name: 'meet.join', args: { url: URL } });

  const refused = cliFixture(cli, {
    stateDirectory,
    store,
    onPoke: serve(store, 'failed', null, 'the host never admitted aivi'),
  });
  await refused.run('join', URL);
  assert.deepEqual(refused.printed[1], { joined: false, state: 'failed', reason: 'the host never admitted aivi' });
  assert.equal(refused.said[1], 'The join did not make it: the host never admitted aivi');

  await call(LIVE);
  await assert.rejects(refused.run('join', URL), /already in a call \(in-call: .* — aivi meet leave first/);
});

test('meet join says so when the join was cancelled before it ran', async t => {
  const { stateDirectory, store } = await home(t);
  const meet = cliFixture(cli, {
    stateDirectory,
    store,
    onPoke: () => {
      const [run] = store.runs({ state: 'queued' });
      store.cancelQueued(run!.id);
    },
  });

  await meet.run('join', URL);

  assert.equal(meet.said[1], 'The join did not make it: cancelled');
});

test('meet join stops following a join that is still working when its watch ends', async t => {
  const { stateDirectory, store } = await home(t);
  const waiting = clock(t);
  const meet = cliFixture(cli, { stateDirectory, store });
  const following = meet.run('join', URL);
  await waiting;
  t.mock.timers.tick(60 * 60_000); // past the join and the admission windows together
  await following;
  assert.deepEqual(meet.printed[1], { joined: false, watching: false });
  assert.match(String(meet.said[1]), /still working/);
  assert.equal(store.runs({ state: 'queued' }).length, 1, 'the run goes on without this terminal');
});

test('meet leave hangs up the call serve holds, and cleans a record nobody is behind', async t => {
  const { stateDirectory, store, record, call } = await home(t);
  const nothing = cliFixture(cli, { stateDirectory, store });
  await nothing.run('leave');
  await call(DEAD);
  await nothing.run('leave');
  assert.deepEqual(nothing.printed, [{ left: false }, { left: false, cleaned: true }]);
  assert.equal(existsSync(record), false, 'the stale record is gone');
  assert.equal(nothing.pokes(), 0, 'serve was never asked');

  await call(LIVE);
  const failed = cliFixture(cli, { stateDirectory, store, onPoke: serve(store, 'failed', null, 'the tab was gone') });
  await failed.run('leave');
  assert.deepEqual(failed.printed, [{ left: false, state: 'failed' }]);
  assert.match(String(failed.said[0]), /did not confirm \(the tab was gone\)/);
  assert.equal(existsSync(record), true, 'an unconfirmed leave keeps the record');

  const left = cliFixture(cli, { stateDirectory, store, onPoke: serve(store, 'succeeded', null, '') });
  await left.run('leave');
  assert.deepEqual(left.printed, [{ left: true }]);
  assert.equal(left.said[0], `Hung up ${URL}.`);
  assert.equal(existsSync(record), false);
});

test('meet leave says so when the hang-up is still running after its watch', async t => {
  const { stateDirectory, store, call } = await home(t);
  await call(LIVE);
  const waiting = clock(t);
  const meet = cliFixture(cli, { stateDirectory, store });
  const following = meet.run('leave');
  await waiting;
  t.mock.timers.tick(61_000);
  await following;
  assert.deepEqual(meet.printed, [{ left: false, state: 'watching' }]);
  assert.match(String(meet.said[0]), /did not confirm \(still running\)/);
});

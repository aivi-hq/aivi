/** The module supervisor as a unit: what a module is handed, what it refuses
 *  before anything starts, how a retry ends with the host, and how a stop
 *  that fails is told. Nothing here waits on a clock: a retry that is
 *  sleeping is ended by the host signal. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ModuleContract } from '../src/modules.ts';
import { ModuleSupervisor } from '../src/modules.ts';
import { TaskRegistry } from '../src/tasks.ts';
import { ToolRegistry } from '../src/tools.ts';
import { recorder } from './support.ts';

type Services = Record<string, unknown>;

const operation = async () => ({ state: 'succeeded' as const, result: null });

/** A module that records the services it was started with and every start and stop, in order. */
function module(id: string, said: string[], over: Partial<ModuleContract<Services>> = {}) {
  const started: Services[] = [];
  const contract: ModuleContract<Services> = {
    id,
    async start(services) {
      started.push(services);
      said.push(`${id}.start`);
      return {
        async stop() {
          said.push(`${id}.stop`);
        },
      };
    },
    ...over,
  };
  return { contract, started };
}

const supervise = (services: Services, signal: AbortSignal) =>
  new ModuleSupervisor<Services>(services, signal, recorder().log, () => {});

test('a module is handed the shared services as they are when the supervisor scopes nothing', async () => {
  const shared = { tasks: 'the shared door', tools: 'the shared door' };
  const linear = module('linear', []);
  await supervise(shared, new AbortController().signal).start([linear.contract]);
  assert.equal(linear.started[0], shared);
});

for (const [name, scoped] of [
  ['tasks', { tasks: true, tools: false }],
  ['tools', { tasks: false, tools: true }],
] as const)
  test(`only the ${name} door is scoped when only that registry is given: its claims carry the module's id`, async () => {
    const shared = { tasks: 'the shared door', tools: 'the shared door' };
    const tasks = new TaskRegistry();
    const tools = new ToolRegistry();
    const linear = module('linear', []);
    const supervisor = new ModuleSupervisor<Services>(
      shared,
      new AbortController().signal,
      recorder().log,
      () => {},
      undefined,
      scoped.tasks ? tasks : undefined,
      scoped.tools ? tools : undefined,
    );
    await supervisor.start([linear.contract]);
    const given = linear.started[0]!;
    assert.notEqual(given, shared, 'the module got its own copy of the services');
    assert.equal(given.tasks === shared.tasks, !scoped.tasks);
    assert.equal(given.tools === shared.tools, !scoped.tools);
    if (scoped.tasks) {
      (given.tasks as { claim(name: string, handler: typeof operation): void }).claim('linear.sweep', operation);
      assert.deepEqual(tasks.claimed(), [{ name: 'linear.sweep', owner: 'linear' }]);
    }
    if (scoped.tools) {
      (given.tools as { claim(descriptor: unknown, handler: () => Promise<unknown>): void }).claim(
        { namespace: 'aivi', name: 'sweep', description: 'Sweep.', input: { type: 'object' } },
        async () => ({}),
      );
      assert.deepEqual(tools.claimed(), [{ id: 'aivi_sweep', owner: 'linear' }]);
    }
  });

test('two modules with one id are refused before either starts', async () => {
  const said: string[] = [];
  const first = module('discord', said);
  const second = module('discord', said);
  await assert.rejects(
    supervise({}, new AbortController().signal).start([first.contract, second.contract]),
    /Module discord is registered twice/,
  );
  assert.deepEqual(said, []);
});

test('a module that cannot stop is reported, and the others stop all the same, last started first', async () => {
  const said: string[] = [];
  const broken = new Error('socket would not close');
  const supervisor = supervise({}, new AbortController().signal);
  await supervisor.start([
    module('first', said).contract,
    module('second', said, {
      async start() {
        said.push('second.start');
        return {
          async stop() {
            said.push('second.stop');
            throw broken;
          },
        };
      },
    }).contract,
    module('third', said).contract,
  ]);
  assert.deepEqual(await supervisor.stop(), [broken]);
  assert.deepEqual(said, ['first.start', 'second.start', 'third.start', 'third.stop', 'second.stop', 'first.stop']);
});

test('a retry that is waiting when the host stops ends there: no further attempt is made', async () => {
  const abort = new AbortController();
  let attempts = 0;
  const flaky = module('flaky', [], {
    async start() {
      attempts++;
      throw new Error('503 Service Unavailable');
    },
  });
  const supervisor = new ModuleSupervisor<Services>({}, abort.signal, recorder().log, () => {}, {
    baseMs: 60_000,
    maxMs: 60_000,
  });
  await supervisor.start([flaky.contract]);
  assert.deepEqual(
    supervisor.health().map(m => [m.id, m.state, m.attempts]),
    [['flaky', 'degraded', 1]],
    'the first attempt failed and a retry sleeps for a minute',
  );
  abort.abort();
  assert.deepEqual(await supervisor.stop(), []);
  assert.equal(attempts, 1, 'the sleeping retry was ended, not fired');
});

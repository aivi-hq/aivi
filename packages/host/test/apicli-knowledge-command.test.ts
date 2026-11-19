/** The knowledge commands as a unit: what each one asks of the loaded config,
 *  the store, the running host and the model warmer, and what it prints. The
 *  home's context, the host client and the warmer are module mocks; nothing
 *  here loads a home, reaches a host or downloads a model. */
import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import type { KnowledgeSource, LoadedConfig } from '@aivi/core';
import { loadedWith, parse } from './apicli-fixture.ts';

const world = { loaded: loadedWith() };
const print = mock.fn();
const poke = mock.fn(async () => {});
const getChild = mock.fn((name: string) => `${name} log`);
const enqueue = mock.fn((_task: unknown, _resource: string, _key: string) => 'the queued run');
const search = mock.fn(async (_request: unknown) => ['a hit']);
const warm = { models: { embed: 'e', rerank: 'r', generate: 'g' }, embedded: 12 };
const warmKnowledge = mock.fn(async (..._args: unknown[]) => warm);
const createHostClient = mock.fn((_url: string) => ({ search }));
const withStore = mock.fn(async (_loaded: LoadedConfig, fn: (store: { enqueue: typeof enqueue }) => unknown) =>
  fn({ enqueue }),
);

mock.module('../src/cli/context.ts', {
  exports: {
    // The parser of the repeatable `--project`: no test here passes that flag,
    // because the real `collect` throws on its first value.
    collect: mock.fn(),
    context: async () => ({ loaded: world.loaded, poke, log: { getChild } }),
    hostUrl: () => 'http://host.test',
    print,
    withStore,
  },
});
mock.module('@aivi/plugin/api', { exports: { createHostClient } });
mock.module('@aivi/knowledge', { exports: { QMD_BUILTIN_MODELS: {}, warmKnowledge } });

const { registerKnowledge, warmHome } = await import('../src/cli/commands/knowledge.ts');

beforeEach(() => {
  for (const spy of [print, poke, getChild, enqueue, search, warmKnowledge, createHostClient, withStore])
    spy.mock.resetCalls();
  world.loaded = loadedWith();
});

const sources: KnowledgeSource[] = [
  { id: 'company', path: '/company', kind: 'doc', scope: 'core' },
  { id: 'adrs', path: '/app/docs', kind: 'decision', scope: 'project', projectId: 'app' },
];

const printed = () => print.mock.calls.map(call => call.arguments);

test('sources lists every source the home indexes', async () => {
  world.loaded = loadedWith({}, { projects: [{ id: 'app', directory: '/app' }], sources });
  await parse(registerKnowledge, 'sources');
  assert.deepEqual(printed(), [[sources]]);
});

test('search asks the running host for what the flags select and prints its hits', async () => {
  for (const [argv, request] of [
    [['wiki'], { query: 'wiki' }],
    [['wiki', '--limit', '5'], { query: 'wiki', limit: 5 }],
    [['wiki', '--core-only'], { query: 'wiki', projects: [] }],
    [['wiki', '--no-core'], { query: 'wiki', includeCore: false }],
  ] as const) {
    search.mock.resetCalls();
    await parse(registerKnowledge, 'knowledge', 'search', ...argv);
    assert.deepEqual(search.mock.calls[0]!.arguments, [request], argv.join(' '));
  }
  assert.deepEqual(createHostClient.mock.calls[0]!.arguments, ['http://host.test']);
  assert.deepEqual(printed().at(-1), [['a hit']]);
});

test('index queues one index run on the maintenance pool and wakes the host', async () => {
  await parse(registerKnowledge, 'knowledge', 'index');
  assert.deepEqual(withStore.mock.calls[0]!.arguments[0], world.loaded);
  const [task, resource, key] = enqueue.mock.calls[0]!.arguments;
  assert.deepEqual([task, resource], [{ kind: 'invocation', name: 'knowledge.index' }, 'maintenance']);
  assert.match(key, /^index:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.deepEqual(printed(), [['the queued run']]);
  assert.equal(poke.mock.callCount(), 1);
});

test('index takes any pool name when none are configured, and only a configured one when some are', async () => {
  await parse(registerKnowledge, 'knowledge', 'index', '--resource', 'anything');
  assert.equal(enqueue.mock.calls[0]!.arguments[1], 'anything');

  world.loaded = loadedWith({ dispatcher: { pools: { fast: { capacity: 1 }, maintenance: { capacity: 1 } } } });
  await parse(registerKnowledge, 'knowledge', 'index', '--resource', 'fast');
  assert.equal(enqueue.mock.calls[1]!.arguments[1], 'fast');

  world.loaded = loadedWith({ dispatcher: { pools: { fast: { capacity: 1 } } } });
  await assert.rejects(
    parse(registerKnowledge, 'knowledge', 'index'),
    /Unknown dispatcher pool: maintenance; name one of fast/,
  );
  assert.equal(enqueue.mock.callCount(), 2, 'a refused pool queues nothing');
});

test('index refuses to queue anything when knowledge search is switched off', async () => {
  world.loaded = loadedWith({ search: false });
  await assert.rejects(parse(registerKnowledge, 'knowledge', 'index'), /Knowledge search is disabled in the config/);
  assert.equal(withStore.mock.callCount() + poke.mock.callCount(), 0);
});

test('warm downloads and loads the models of the home and prints what it did and how long it took', async t => {
  t.mock.timers.enable({ apis: ['Date'] });
  warmKnowledge.mock.mockImplementationOnce(async () => {
    t.mock.timers.tick(3_400);
    return warm;
  });
  await parse(registerKnowledge, 'knowledge', 'warm');
  assert.deepEqual(warmKnowledge.mock.calls[0]!.arguments, [world.loaded, undefined, 'knowledge log']);
  assert.deepEqual(printed(), [[{ ...warm, seconds: 3 }]]);
  assert.equal(warmKnowledge.mock.callCount(), 1);
  assert.deepEqual(await warmHome(), { ...warm, seconds: 0 }, 'setup reaches the same edge');
});

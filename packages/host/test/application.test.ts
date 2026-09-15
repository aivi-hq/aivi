import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.ts';
import { runHost } from '../src/application.ts';
import type { HostModule, HostResources } from '../src/application.ts';
import { configSchema } from '@aivi/core';
import { createExecutor } from '../src/runtime.ts';
import { Scheduler } from '../src/scheduler.ts';

const loaded = () => ({ path: '/config', config: configSchema.parse({ version: 1, host: { port: 0 }, search: { provider: 'qmd' } }), sources: [], projects: [] });
const auth = { mode: 'token' as const, token: 'test-token-for-local-host-only' };
const noOpenCode = async () => { throw new Error('OpenCode must not be contacted in this test'); };

test('one host starts modules with shared services and stops them in reverse order before knowledge closes', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const events: string[] = [];
  const knowledge = { async index() { events.push('index'); }, async search() { return []; }, async close() { events.push('knowledge.stop'); } };
  const modules: HostModule[] = ['discord', 'future-module'].map(id => ({ id, async start(services) {
    assert.equal(services.store, store); assert.equal(services.knowledge, knowledge);
    assert.equal(typeof services.opencode, 'function'); assert.equal(typeof services.log.info, 'function');
    events.push(`${id}.start`);
    return { async stop() { assert.equal(services.signal.aborted, true); events.push(`${id}.stop`); } };
  } }));
  const abort = new AbortController();
  const resources = async (): Promise<HostResources> => ({ knowledge, browser: { async execute() { return {}; }, async close() { events.push('browser.stop'); } } });
  await runHost({ loaded: loaded(), store, resources, modules, auth, signal: abort.signal, onReady: () => { events.push('ready'); abort.abort(); } });
  assert.deepEqual(events, ['index','discord.start','future-module.start','ready','future-module.stop','discord.stop','browser.stop','knowledge.stop']);
  store.acquireDaemon('another'); store.releaseDaemon('another');
});

test('startup failure unwinds earlier modules and releases ownership', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  const events: string[] = [];
  const resources = async () => ({ knowledge: { async search() { return []; }, async index() {}, async close() { events.push('close'); } } });
  const modules: HostModule[] = [
    { id: 'first', async start() { return { async stop() { events.push('stop'); } }; } },
    { id: 'broken', async start() { throw new Error('start failed'); } },
  ];
  await assert.rejects(runHost({ loaded: loaded(), store, resources, modules, auth, signal: new AbortController().signal }), /start failed/);
  assert.deepEqual(events, ['stop','close']);
  store.acquireDaemon('another'); store.releaseDaemon('another');
});

test('duplicate host is rejected before initializing shared services', async t => {
  const store = new Store(':memory:'); t.after(() => store.close()); store.acquireDaemon('existing');
  let called = false;
  const resources = async () => { called = true; throw new Error('must not run'); };
  await assert.rejects(runHost({ loaded: loaded(), store, resources, auth, signal: new AbortController().signal }), /already owns/);
  assert.equal(called, false); store.releaseDaemon('existing');
});

test('once mode dispatches due work without opening the API or starting modules', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  let indexed = 0;
  const knowledge = { async index() { indexed++; return { indexed: 2 }; }, async search() { return []; }, async close() {} };
  const config = loaded();
  config.config.search!.indexOnStart = false;
  const job = store.enqueue({ kind: 'knowledge.index' }, 'local-model', 'index');
  let moduleStarted = false;
  const modules: HostModule[] = [{ id: 'never', async start() { moduleStarted = true; return { async stop() {} }; } }];
  await runHost({ loaded: config, store, resources: async () => ({ knowledge }), modules, auth: { mode: 'none' }, once: true, signal: new AbortController().signal });
  assert.equal(indexed, 1); assert.equal(store.get(job.id).state, 'succeeded'); assert.equal(moduleStarted, false);
  store.acquireDaemon('another'); store.releaseDaemon('another');
});

test('scheduled knowledge indexing uses the same injected service', async t => {
  const store = new Store(':memory:'); t.after(() => store.close());
  let indexed = 0;
  const knowledge = { async index() { indexed++; return { indexed: 2 }; }, async search() { return []; }, async close() {} };
  const config = loaded();
  const job = store.enqueue({ kind: 'knowledge.index' }, 'local-model', 'index');
  const scheduler = new Scheduler(store, config.config.scheduler, createExecutor(config, { store, knowledge, opencode: noOpenCode }));
  scheduler.tick(); await scheduler.drain();
  assert.equal(indexed, 1); assert.equal(store.get(job.id).state, 'succeeded');
});

/** The host's own tools as a unit: which capability each one needs to exist,
 *  what each does with the input a session sends, and what it answers or
 *  refuses with. A tool is called the way the door calls it: through the
 *  registry the host claimed it in, with the session's envelope and the
 *  model's input. The capabilities (knowledge service, jobs handler, context
 *  reader, composed referee) are fakes handed in as arguments. */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { type TestContext, test } from 'node:test';
import type { KnowledgeService, SearchHit } from '@aivi/core';
import { claimHostTools, type HostToolDeps } from '../src/api/host-tools.ts';
import { type JobHandler, JobRefused } from '../src/jobs.ts';
import { Store } from '../src/store.ts';
import { ToolError, ToolRegistry } from '../src/tools.ts';
import { loadedWith, scratchDir } from './apicli-fixture.ts';
import { recorder } from './support.ts';

const company = { id: 'company', path: '/company', kind: 'doc', scope: 'core' } as const;
const adrs = { id: 'adrs', path: '/app/docs', kind: 'decision', scope: 'project', projectId: 'app' } as const;
const catalog = loadedWith({}, { projects: [{ id: 'app', directory: '/app' }], sources: [company, adrs] });

/** The host's tools claimed over the given capabilities, and a way to call one as a session would. */
function toolsOver(t: TestContext, deps: Partial<HostToolDeps> = {}) {
  const store = new Store(':memory:');
  t.after(() => store.close());
  const registry = new ToolRegistry();
  const log = recorder();
  claimHostTools(registry, { store, loaded: catalog, log: log.log, ...deps });
  return {
    log,
    ids: () => registry.list().map(tool => tool.id),
    call: (id: string, input: Record<string, unknown> = {}, ids: { sessionId?: string; messageId?: string } = {}) =>
      registry.get(id)!.handler({ sessionId: 'ses_1', input, ...ids }),
  };
}

/** What a tool refuses with: the status the caller sees and the words it reads. */
const refused = (status: number, message: string | RegExp) => (error: unknown) => {
  assert.ok(error instanceof ToolError, String(error));
  assert.equal(error.status, status);
  if (typeof message === 'string') assert.equal(error.message, message);
  else assert.match(error.message, message);
  return true;
};

const knowledgeOver = (search: KnowledgeService['search']): KnowledgeService => ({
  search,
  index: async () => {},
  close: async () => {},
});

test('a capability that does not exist claims no tool, so none is offered that would only fail', t => {
  assert.deepEqual(toolsOver(t).ids(), ['aivi_sources', 'aivi_status', 'knowledge_projects']);
  const everything = toolsOver(t, {
    knowledge: knowledgeOver(async () => []),
    context: async () => '',
    jobs: async () => ({ summary: '', items: [] }),
    compose: async () => ({}),
  });
  assert.deepEqual(everything.ids(), [
    'aivi_config',
    'aivi_context',
    'aivi_jobs',
    'aivi_sources',
    'aivi_status',
    'knowledge_projects',
    'knowledge_search',
  ]);
});

test('aivi_status reports the health of the modules and the slots the dispatcher holds', async t => {
  const modules = [{ id: 'voice', state: 'running' as const, attempts: 1, lastError: null, nextRetryAt: null }];
  const { call } = toolsOver(t, { health: () => modules, leases: () => 2 });
  const view = (await call('aivi_status')) as { modules: unknown; leases: number; sources: number };
  assert.deepEqual([view.modules, view.leases, view.sources], [modules, 2, 2]);
});

test('aivi_sources lists what the named projects and kinds select, and refuses a selection it cannot read', async t => {
  const { call } = toolsOver(t);
  assert.deepEqual(await call('aivi_sources'), [company, adrs]);
  assert.deepEqual(await call('aivi_sources', { projects: ['app'], includeCore: false, kinds: ['decision'] }), [adrs]);
  await assert.rejects(call('aivi_sources', { projects: 'app' }), refused(400, 'Invalid source selection'));
  await assert.rejects(call('aivi_sources', { projects: ['typo'] }), refused(400, 'Unknown project: typo'));
});

test('knowledge_projects lists the projects with the kinds each can be searched by', async t => {
  assert.deepEqual(await toolsOver(t).call('knowledge_projects'), [
    { id: 'app', sources: [{ id: 'adrs', kind: 'decision' }] },
  ]);
});

test('knowledge_search asks the service for what was selected, and refuses or reports what it cannot serve', async t => {
  const hits: SearchHit[] = [];
  const search = t.mock.fn<KnowledgeService['search']>(async () => hits);
  const { call, log } = toolsOver(t, { knowledge: knowledgeOver(search) });
  const selected = { query: 'wiki', limit: 3, projects: ['app'], includeCore: false, kinds: ['decision'] };
  for (const [input, request] of [
    [{ query: 'wiki' }, { query: 'wiki', limit: 8 }],
    [selected, selected],
  ] as const) {
    assert.equal(await call('knowledge_search', input), hits);
    assert.deepEqual(search.mock.calls.at(-1)!.arguments, [request]);
  }
  await assert.rejects(call('knowledge_search', {}), refused(400, 'Invalid search request'));
  await assert.rejects(
    call('knowledge_search', { query: 'wiki', projects: ['typo'] }),
    refused(400, 'Unknown project: typo'),
  );
  assert.equal(search.mock.callCount(), 2, 'a refused request never reaches the service');

  const failure = new Error('the index is locked');
  search.mock.mockImplementationOnce(async () => {
    throw failure;
  });
  await assert.rejects(call('knowledge_search', { query: 'wiki' }), refused(503, 'Knowledge search is unavailable'));
  assert.deepEqual(log.said('warn'), [{ level: 'warn', event: 'knowledge.search.failed', error: failure }]);
});

test('aivi_context describes the calling session within a bound, and says so when OpenCode cannot be read', async t => {
  const context = t.mock.fn(async (_session: string, _signal: AbortSignal) => '🧠 **Context**');
  const { call, log } = toolsOver(t, { context });
  assert.deepEqual(await call('aivi_context', {}, { sessionId: 'ses_x' }), { text: '🧠 **Context**' });
  const [session, signal] = context.mock.calls[0]!.arguments;
  assert.equal(session, 'ses_x');
  assert.ok(signal instanceof AbortSignal);

  const failure = new Error('session not found');
  context.mock.mockImplementationOnce(async () => {
    throw failure;
  });
  await assert.rejects(
    call('aivi_context', {}, { sessionId: 'ses_gone' }),
    refused(502, 'Could not read that session from OpenCode'),
  );
  assert.deepEqual(log.said('warn'), [{ level: 'warn', event: 'context.failed', session: 'ses_gone', error: failure }]);
});

test('aivi_config names the corrupt file instead of failing shapelessly when config.json is not valid JSON', async t => {
  const dir = await scratchDir(t, 'aivi-host-tools-');
  const path = join(dir, 'config.json');
  await writeFile(path, '{"version":');
  const { call } = toolsOver(t, { loaded: loadedWith({}, { path }), compose: async () => ({}) });
  await assert.rejects(
    call('aivi_config', { action: 'read' }),
    refused(
      500,
      /^config\.json is not valid JSON: .+\. Repair the file by hand; the tool will not read or write over it until it loads again\.$/,
    ),
  );
});

test('aivi_jobs forwards the request under the session’s own ids, whatever the model wrote', async t => {
  const reply = { summary: 'Created.', items: [] };
  const jobs = t.mock.fn(async (_request: unknown) => reply);
  const { call } = toolsOver(t, { jobs });
  assert.equal(await call('aivi_jobs', { action: 'list', sessionId: 'forged' }, { sessionId: 'ses_real' }), reply);
  assert.deepEqual(jobs.mock.calls[0]!.arguments, [{ action: 'list', sessionId: 'ses_real' }]);

  await call(
    'aivi_jobs',
    { action: 'create', prompt: 'ping', at: '1h', messageId: 'forged' },
    { sessionId: 'ses_real', messageId: 'msg_real' },
  );
  assert.partialDeepStrictEqual(jobs.mock.calls[1]!.arguments[0], {
    action: 'create',
    sessionId: 'ses_real',
    messageId: 'msg_real',
  });
});

test('aivi_jobs refuses a request it cannot read, relays a refusal as it was said and hides any other failure', async t => {
  const jobs = t.mock.fn<JobHandler>(async () => ({ summary: '', items: [] }));
  const { call, log } = toolsOver(t, { jobs });
  await assert.rejects(call('aivi_jobs', {}), refused(400, /^Invalid job request: .+/));
  assert.equal(jobs.mock.callCount(), 0, 'the host validates before the handler is asked');

  jobs.mock.mockImplementationOnce(async () => {
    throw new JobRefused('Jobs do not create jobs', 403);
  });
  await assert.rejects(call('aivi_jobs', { action: 'run', id: 'nightly' }), refused(403, 'Jobs do not create jobs'));

  const failure = new Error('sqlite exploded');
  jobs.mock.mockImplementationOnce(async () => {
    throw failure;
  });
  await assert.rejects(
    call('aivi_jobs', { action: 'list' }),
    refused(500, 'The job operation failed on the host; check its log.'),
  );
  assert.deepEqual(log.said('warn'), [{ level: 'warn', event: 'jobs.failed', action: 'list', error: failure }]);
});

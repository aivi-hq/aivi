import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BrowserConfig } from '@aivi/core';
import { browserConfigSchema, getLogger } from '@aivi/core';
import type { HostServices } from '@aivi/host';
import { ToolError, ToolRegistry } from '@aivi/host';
import type { BrowserTransport } from '../src/index.ts';
import { createBrowserModule } from '../src/index.ts';

const config = (): BrowserConfig =>
  browserConfigSchema.parse({ connection: { mode: 'existing', userDataDir: '/aivi/chrome' } });

/** A transport that reports an empty browser and counts closes; Chrome never starts. */
function fixture() {
  let closed = 0;
  const calls: string[] = [];
  const transport: BrowserTransport = {
    async call(name) {
      calls.push(name);
      return { structuredContent: { pages: [] } };
    },
    async close() {
      closed++;
    },
  };
  return { transport, calls, closed: () => closed };
}

test('the browser module claims aivi_browser at its own door; stop releases it and closes the MCP child', async () => {
  const registry = new ToolRegistry();
  const fake = fixture();
  const services = {
    tools: registry.forModule('browser'),
    log: getLogger(['aivi', 'host']),
  } as unknown as HostServices;
  const running = await createBrowserModule(config(), fake.transport).start(services);

  const served = registry.list();
  assert.deepEqual(
    served.map(tool => tool.id),
    ['aivi_browser'],
  );
  const tool = served[0]!;
  assert.equal(tool.namespace, 'aivi');
  assert.equal(tool.name, 'browser');
  assert.equal(tool.timeoutMs, 300_000, 'the descriptor carries its own 300 s budget');
  assert.equal(registry.claimed()[0]!.owner, 'browser', 'claimed under the module, not the host');

  // A valid action reaches the transport with the envelope session as its owner.
  assert.deepEqual(await registry.get('aivi_browser')!.handler({ sessionId: 'ses_owner', input: { action: 'tabs' } }), {
    tabs: [],
  });
  assert.deepEqual(fake.calls, ['list_pages']);

  // A malformed action is the agent's to fix: a 400 with the reason, not a 500.
  await assert.rejects(
    registry.get('aivi_browser')!.handler({ sessionId: 'ses_owner', input: { action: 'evaluate_script' } }),
    (error: unknown) => error instanceof ToolError && error.status === 400,
  );

  await running.stop();
  assert.equal(fake.closed(), 1, 'stop closed the MCP child');
  assert.equal(
    registry.get('aivi_browser'),
    undefined,
    'stop released the tool so the next plugin load will not see it',
  );
});

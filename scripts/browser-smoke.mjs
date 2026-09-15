import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { browserConfigSchema } from '@aivi/core';
import { createBrowserService } from '@aivi/browser';

// Uses a throwaway dedicated profile and local fixture only. No installed user
// profiles, external websites, credentials, or extensions are read or modified.
const directory = await mkdtemp(join(tmpdir(), 'aivi-browser-smoke-'));
const server = createServer((_request, response) => {
  response.setHeader('content-type', 'text/html');
  response.end('<!doctype html><title>Aivi fixture</title><label>Name <input id="name"></label><button onclick="document.getElementById(\'result\').textContent=\'Hello \'+document.getElementById(\'name\').value">Greet</button><p id="result"></p>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const service = createBrowserService(browserConfigSchema.parse({ connection: {
  mode: 'launch', userDataDir: directory, headless: true,
  ...(process.env.AIVI_TEST_CHROME ? { executablePath: process.env.AIVI_TEST_CHROME } : {}),
} }));
function find(node, name) {
  if (node?.name === name && node.uid) return node.uid;
  for (const child of node?.children ?? []) { const result = find(child, name); if (result) return result; }
}
try {
  const url = `http://127.0.0.1:${server.address().port}`;
  const a = (await service.execute('smoke-a', { action: 'open', url })).tab;
  const b = (await service.execute('smoke-b', { action: 'open', url })).tab;
  assert.ok(a && b);
  const snapshot = (await service.execute('smoke-a', { action: 'snapshot', tabId: a.tabId })).snapshot;
  const input = find(snapshot, 'Name ' ) ?? find(snapshot, 'Name');
  const button = find(snapshot, 'Greet');
  assert.ok(input && button, 'Fixture input and button must have snapshot uids');
  await service.execute('smoke-a', { action: 'fill', tabId: a.tabId, uid: input, value: 'Aivi' });
  // A new snapshot prevents relying on element IDs surviving a DOM change.
  const refreshed = (await service.execute('smoke-a', { action: 'snapshot', tabId: a.tabId })).snapshot;
  await service.execute('smoke-a', { action: 'click', tabId: a.tabId, uid: find(refreshed, 'Greet') });
  const result = await service.execute('smoke-a', { action: 'snapshot', tabId: a.tabId });
  assert.match(JSON.stringify(result.snapshot), /Hello Aivi/);
  await assert.rejects(service.execute('smoke-b', { action: 'close', tabId: a.tabId }), /not owned/);
  await service.execute('smoke-a', { action: 'close', tabId: a.tabId });
  assert.equal((await service.execute('smoke-b', { action: 'tabs' })).tabs.length, 1);
  await service.execute('smoke-b', { action: 'close', tabId: b.tabId });
  console.log('Chrome MCP smoke passed: open → snapshot → fill → click → ownership → close');
} finally {
  await service.close();
  await new Promise(resolve => server.close(resolve));
  await rm(directory, { recursive: true, force: true });
}

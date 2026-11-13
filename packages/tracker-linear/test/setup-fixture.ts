import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http, { type IncomingMessage, type RequestListener, type Server, type ServerResponse } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import type { TestContext } from 'node:test';
import type { RequestLogEntry } from '@aivi/core';
import { setupDiary, setupFixture } from '../../plugin/test/setup-fixture.ts';
import { type DelegateAnswer, LinearClient, type LinearIssue } from '../src/client.ts';
import { signWebhook } from '../src/webhook.ts';

const now = Date.parse('2026-11-13T10:00:00Z');
const publicUrl = 'https://aivi.example';
const appId = 'linear-app';
const webhookPath = `/linear/webhooks/app/${appId}`;
export const issue = { id: 'issue-1', identifier: 'ENG-1' } as LinearIssue;
const answers = [appId, publicUrl, 'client-id', 'client-secret', 'signing-secret', 'team-1'];

/** A server-shaped fake: callbacks are invoked directly; no socket is opened. */
function installListener(t: TestContext) {
  let handler: RequestListener;
  const created = Promise.withResolvers<void>();
  const server = Object.assign(new EventEmitter(), {
    listen: t.mock.fn((_port: number, _host: string, ready: () => void) => {
      ready();
    }),
    address: t.mock.fn(() => ({ port: 4321, address: '127.0.0.1', family: 'IPv4' })),
    close: t.mock.fn(),
    closeAllConnections: t.mock.fn(),
  });
  const create = t.mock.method(http, 'createServer', (listener: unknown) => {
    handler = listener as RequestListener;
    created.resolve();
    return server as unknown as Server;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  const request = (url: string | undefined) => {
    const response = {
      writeHead: t.mock.fn((_status: number, _headers?: Record<string, string>) => response),
      end: t.mock.fn(),
    };
    handler.call(server as unknown as Server, { url } as IncomingMessage, response as unknown as ServerResponse);
    return response;
  };
  return { server, create, created: created.promise, request };
}

export function setupWizard(t: TestContext, scripted: unknown[] = answers) {
  t.mock.property(process, 'env', { ...process.env, AIVI_PROBE_WINDOW_MS: '9000' });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now });
  const h = setupFixture(t, scripted);
  const diary = setupDiary(t);
  const watching = [Promise.withResolvers<void>(), Promise.withResolvers<void>()] as const;
  diary.requests.mock.mockImplementation(filter => {
    if (filter?.method === 'POST') watching[h.spinners.length - 1]?.resolve();
    return diary.read(filter);
  });
  const listener = installListener(t);
  h.withStore.mock.mockImplementation(async fn => fn(diary.store));
  h.fetch.mock.mockImplementation(async url => {
    assert.ok(url === 'http://127.0.0.1:4100/health' || url === 'https://api.linear.app/oauth/token', url);
    return Response.json({ ok: true });
  });
  h.print.mock.mockImplementation(() => {
    listener.request('/callback?code=install-code');
  });
  const append = (payload: Record<string, unknown>, extra: Partial<RequestLogEntry> = {}) => {
    const body = JSON.stringify({ webhookTimestamp: now, ...payload });
    const row: RequestLogEntry = {
      id: Math.max(0, ...diary.rows.map(row => row.id)) + 1,
      at: now,
      method: 'POST',
      path: webhookPath,
      status: 404,
      body,
      truncated: false,
      headers: { 'linear-signature': signWebhook(body, 'signing-secret') },
      ...extra,
    };
    diary.rows.push(row);
    return row;
  };
  const viewer = t.mock.method(LinearClient.prototype, 'viewerId', async () => 'bot-user');
  const teams = t.mock.method(LinearClient.prototype, 'listTeams', async () => [
    { id: 'team-1', key: 'ENG', name: 'Engineering', states: [] },
  ]);
  const createIssue = t.mock.method(LinearClient.prototype, 'createIssue', async () => {
    append({ type: 'Issue', action: 'create', data: { id: issue.id, identifier: issue.identifier } });
    return issue;
  });
  const delegate = t.mock.method(LinearClient.prototype, 'setDelegate', async (): Promise<DelegateAnswer> => {
    append({ type: 'AgentSessionEvent', action: 'created', agentSession: { id: 'session-1', issue } });
    return {
      success: true,
      issue: {
        identifier: issue.identifier,
        agentSessions: { nodes: [{ id: 'session-1', status: 'pending', startedAt: null, url: null }] },
      },
    };
  });
  const archive = t.mock.method(LinearClient.prototype, 'deleteIssue', async () => {
    assert.equal(h.configWrites.mock.callCount(), 0, 'cleanup precedes config writes');
    assert.equal(h.secretWrites.mock.callCount(), 0, 'cleanup precedes secret writes');
  });
  return { ...h, diary, listener, append, viewer, teams, createIssue, delegate, archive, watching };
}

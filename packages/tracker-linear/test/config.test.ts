import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  assistantAgent,
  linearPrimarySecretNames,
  linearSchema,
  linearSecretNames,
  plugin,
  primaryLinearApp,
} from '../src/config.ts';

test('linear settings: defaults, secret names, the loopback MCP', () => {
  const linear = linearSchema.parse({ apps: { dev: {} } });
  assert.deepEqual(
    [linear.listener, linear.humanLabel, linear.resource, linear.progress, linear.turnTimeoutMs, linear.logMisroutes],
    [false, 'needs-human', 'local-model', 'tools', 7_200_000, true],
  );
  assert.deepEqual(linear.mcp, { port: 4101 }, 'the Linear MCP is on by default on its loopback port');
  assert.deepEqual(linearSchema.parse({ apps: { dev: {} }, mcp: false }).mcp, false);
  assert.deepEqual(linearSecretNames('dev-app'), {
    clientId: 'LINEAR_DEV_APP_CLIENT_ID',
    clientSecret: 'LINEAR_DEV_APP_CLIENT_SECRET',
    webhookSecret: 'LINEAR_DEV_APP_WEBHOOK_SECRET',
  });
  assert.deepEqual(linearPrimarySecretNames, {
    clientId: 'LINEAR_CLIENT_ID',
    clientSecret: 'LINEAR_CLIENT_SECRET',
    webhookSecret: 'LINEAR_WEBHOOK_SECRET',
  });
  assert.ok(
    linearSchema.safeParse({ apps: { data: {} } }).success,
    'no app id is reserved: the bare names mean the primary',
  );
});

test('the primary is asked only when several apps stand, and must be one of them', () => {
  // Several apps without a primary: which one carries the data feed is ambiguous.
  assert.equal(linearSchema.safeParse({ apps: { developer: {}, reviewer: {} } }).success, false);
  // A primary that is not a configured app is a typo.
  assert.equal(linearSchema.safeParse({ primary: 'ghost', apps: { developer: {}, reviewer: {} } }).success, false);
  assert.equal(linearSchema.safeParse({ primary: 'developer', apps: { developer: {}, reviewer: {} } }).success, true);
  assert.equal(primaryLinearApp(linearSchema.parse({ apps: { only: {} } })), 'only', 'the one app is the primary');
  assert.equal(primaryLinearApp(undefined), undefined);
});

test('the assistant has one fallback name, never the persona slugged into it', () => {
  assert.equal(assistantAgent(undefined), 'assistant', 'the one assistant is the fallback name');
  assert.equal(assistantAgent(linearSchema.parse({ apps: {}, agent: 'clawd' })), 'clawd');
});

test('the plugin declaration is the registry entry: module id and schema', () => {
  assert.equal(plugin.id, 'linear', 'the module id is the plugins.linear config key');
  assert.equal(plugin.configSchema, linearSchema);
  assert.equal(typeof plugin.createModule, 'function');
});

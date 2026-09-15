import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectOpenCode, restartOpenCode } from '../src/opencode.ts';

const endpoint = { url: 'http://127.0.0.1:1', auth: { type: 'basic' as const, username: 'opencode', password: 'p' } };
const never = async (): Promise<never> => {
  throw new Error('must not be called');
};

test('a missing service is started through the SDK with AIVI_TOKEN in its environment; "discover" never starts one', async () => {
  const calls: unknown[] = [];
  const started: string[] = [];
  const client = await connectOpenCode(
    { lifecycle: 'ensure' },
    { AIVI_TOKEN: 'token-for-the-plugin-inside-opencode' },
    {
      discover: async () => undefined,
      ensure: async options => {
        calls.push(options);
        options?.onStart?.('missing');
        return endpoint;
      },
      onStart: reason => started.push(reason),
    },
  );
  assert.ok(client.session, 'a client for the started service');
  assert.deepEqual((calls[0] as { env: unknown }).env, { AIVI_TOKEN: 'token-for-the-plugin-inside-opencode' });
  assert.deepEqual(started, ['missing']);

  await assert.rejects(
    connectOpenCode({ lifecycle: 'discover' }, {}, { discover: async () => undefined, ensure: never }),
    /No running OpenCode v2 service found/,
  );
  // A running service is used as is by every lifecycle.
  const untouched = await connectOpenCode({ lifecycle: 'own' }, {}, { discover: async () => endpoint, ensure: never });
  assert.ok(untouched.session);
});

test('"own" replaces a running service at startup with pty handoff; other lifecycles and url leave it alone', async () => {
  const events: string[] = [];
  const hooks = {
    discover: async () => endpoint,
    stop: async (options?: { pty?: string }) => {
      events.push(`stop:${options?.pty}`);
    },
    ensure: async (options?: { env?: Record<string, string> }) => {
      events.push(`ensure:${options?.env?.AIVI_TOKEN ?? '-'}`);
      return endpoint;
    },
    onStart: (reason: string) => events.push(`start:${reason}`),
  };
  assert.equal(await restartOpenCode({ lifecycle: 'own' }, { AIVI_TOKEN: 't' }, hooks), true);
  assert.deepEqual(events, ['start:restart', 'stop:handoff', 'ensure:t']);
  events.length = 0;
  assert.equal(await restartOpenCode({ lifecycle: 'own' }, {}, { ...hooks, discover: async () => undefined }), false);
  assert.equal(await restartOpenCode({ lifecycle: 'ensure' }, {}, hooks), false);
  assert.equal(await restartOpenCode({ lifecycle: 'discover' }, {}, hooks), false);
  assert.equal(await restartOpenCode({ url: 'http://elsewhere:1', lifecycle: 'own' }, {}, hooks), false);
  assert.deepEqual(events, [], 'nothing stopped or started');
});

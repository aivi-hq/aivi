import assert from 'node:assert/strict';
import { test } from 'node:test';
import { connectOpenCode } from '../src/opencode.ts';

const endpoint = { url: 'http://127.0.0.1:1', auth: { type: 'basic' as const, username: 'opencode', password: 'p' } };

test('a missing service is started through the SDK with AIVI_TOKEN in its environment; ensure:false only discovers', async () => {
  const calls: unknown[] = [];
  const started: string[] = [];
  const client = await connectOpenCode(
    { ensure: true },
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
    connectOpenCode(
      { ensure: false },
      {},
      {
        discover: async () => undefined,
        ensure: async () => {
          throw new Error('must not be called');
        },
      },
    ),
    /No running OpenCode v2 service found/,
  );
  // A running service is never restarted or touched.
  const untouched = await connectOpenCode(
    { ensure: true },
    {},
    {
      discover: async () => endpoint,
      ensure: async () => {
        throw new Error('must not be called');
      },
    },
  );
  assert.ok(untouched.session);
});

import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { announce, ONLINE_NOTICE } from '../src/channel/presence.ts';
import { recorder } from './support.ts';

test('a status notice goes to every report channel; a channel that refuses it is warned about and the others still hear it', async () => {
  const refused = new Error('missing access');
  const send = mock.fn(async (channel: string, _text: string) => {
    if (channel === 'ops') throw refused;
  });
  const { log, said } = recorder();

  await announce(['ops', 'general'], send, ONLINE_NOTICE, log);

  assert.deepEqual(
    send.mock.calls.map(call => call.arguments),
    [
      ['ops', ONLINE_NOTICE],
      ['general', ONLINE_NOTICE],
    ],
  );
  assert.deepEqual(said('warn'), [{ level: 'warn', event: 'presence.notify_failed', channel: 'ops', error: refused }]);
});

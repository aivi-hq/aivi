/** What the voice code does when Discord's native opus encoder fails on an
 *  answer. The real encoder cannot be made to fail on a well-formed frame, so
 *  `@discordjs/opus` is replaced here by an encoder that always fails (the
 *  package loads it with `createRequire`, which the module mock reaches). The
 *  working codec is `discord.test.ts`'s and `voice.test.ts`'s. */
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';
import { sineWav } from './voice-fixture.ts';

class FailingEncoder {
  encode(_frame: Buffer): Buffer {
    throw new Error('the opus encoder failed');
  }

  decode(_packet: Buffer): Buffer {
    throw new Error('the opus decoder failed');
  }
}
mock.module('@discordjs/opus', { exports: { OpusEncoder: FailingEncoder } });

const { wavToOpus } = await import('../src/voice.ts');

test('an answer the encoder fails on is said and gives no packets, so nothing half-encoded is spoken', () => {
  const lines: { event: string; fields: Record<string, unknown> | undefined }[] = [];
  const say = (event: string, fields?: Record<string, unknown>) => void lines.push({ event, fields });
  const log = { debug: say, info: say, warn: say, error: say };

  assert.deepEqual(wavToOpus(sineWav(24000, 0.1), log), []);

  assert.deepEqual(lines, [
    { event: 'voice.discord.encode-failed', fields: { error: 'Error: the opus encoder failed' } },
  ]);
});

/** The Slack id shapes: a channel starts with C or G, a DM channel with D, a
 *  user with U or W, and each has at least eight capitals or digits after it. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isChannelId, isDMChannelId, isUserId } from '../src/config.ts';

const shapes = [
  ['channel', isChannelId, ['C0123ABCD', 'G0123ABCD'], ['D0123ABCD', 'U0123ABCD']],
  ['DM channel', isDMChannelId, ['D0123ABCD', 'D0123456789'], ['C0123ABCD', 'G0123ABCD']],
  ['user', isUserId, ['U0123ABCD', 'W0123ABCD'], ['C0123ABCD', 'D0123ABCD']],
] as const;

for (const [name, is, valid, otherKinds] of shapes) {
  test(`a ${name} id has its own prefix and eight capitals or digits after it`, () => {
    for (const id of valid) assert.equal(is(id), true, id);
    for (const id of [...otherKinds, 'c0123abcd', 'C0123ABC', 'C0123ABCD!', ' C0123ABCD', ''])
      assert.equal(is(id), false, id);
  });
}

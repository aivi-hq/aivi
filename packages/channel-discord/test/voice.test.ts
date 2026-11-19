/** The Discord voice watcher: what it hears, how it joins and leaves, how it
 *  speaks, and what it does when Discord or the voice plugin fail. The
 *  watcher is the real one over the fakes of `voice-fixture.ts`; Discord's
 *  native opus is real too (it is a pure codec). The parts that reach
 *  `@discordjs/voice` are `voice-player.test.ts`'s subject. */
import assert from 'node:assert/strict';
import { type TestContext, test } from 'node:test';
import { VoiceConnectionStatus } from '@discordjs/voice';
import { PacketBand, watchVoice, wavToOpus } from '../src/voice.ts';
import { codec, type HarnessOptions, sineWav, voiceHarness } from './voice-fixture.ts';

/** A meeting in progress: the watcher over the fakes, one linked person sitting in the first channel. The watcher is
 *  stopped when the test ends. */
async function inCall(t: TestContext, options?: HarnessOptions) {
  const h = voiceHarness(options);
  const watcher = watchVoice(h.deps);
  t.after(() => watcher.stop());
  await h.settle(); // the watcher's first look: nobody is there yet
  h.enter(h.channelId, 'u-link');
  await h.settle();
  return { h, watcher };
}

type Harness = ReturnType<typeof voiceHarness>;

const logOf = () => {
  const lines: { event: string; fields: Record<string, unknown> | undefined }[] = [];
  const say = (event: string, fields?: Record<string, unknown>) => void lines.push({ event, fields });
  return { lines, log: { debug: say, info: say, warn: say, error: say } };
};

/** 20 ms of a 440 Hz tone as one opus packet, the way Discord's receiver hands it over. */
const tone = (opus = codec()) => {
  const pcm = new Int16Array(960 * 2);
  for (let i = 0; i < 960; i++) {
    pcm[2 * i] = pcm[2 * i + 1] = Math.round(Math.sin((2 * Math.PI * 440 * i) / 48000) * 8000);
  }
  return opus.encode(Buffer.from(pcm.buffer));
};

test('a person’s speech is decoded packet by packet and streamed into their lane as 16 kHz audio', async t => {
  const { h } = await inCall(t);
  const opus = codec();
  h.speaking.emit('start', 'u-link');

  for (let n = 0; n < 4; n++) h.streams()[0]!.emit('data', tone(opus));

  const [lane] = h.lanes();
  assert.deepEqual(
    lane!.chunks.map(chunk => chunk.length),
    [320, 320, 320, 320],
    'one 20 ms packet is 320 samples at 16 kHz',
  );
  assert.ok(
    lane!.chunks.some(chunk => chunk.some(sample => Math.abs(sample) > 0.05)),
    'it is the tone that arrives, not silence',
  );
});

for (const [name, heard, expected] of [
  ['with its text, so nothing is lost', async () => 'hello there', []],
  [
    'and is said to be lost when the lane has no text for it',
    async () => null,
    [{ event: 'voice.discord.lost-utterance', userId: 'u-link', seconds: 0.5 }],
  ],
  [
    'and is said to have failed when the lane cannot finish it',
    async () => Promise.reject(new Error('the model is gone')),
    [{ event: 'voice.discord.heard-failed', userId: 'u-link', error: 'Error: the model is gone' }],
  ],
] as const) {
  test(`an utterance that Discord’s silence rule ends is committed through its lane, ${name}`, async t => {
    t.mock.timers.enable({ apis: ['Date'] });
    const { h } = await inCall(t, { heard });
    const opus = codec();
    h.speaking.emit('start', 'u-link');
    for (let n = 0; n < 25; n++) h.streams()[0]!.emit('data', tone(opus)); // 25 packets: half a second
    t.mock.timers.tick(1500);

    h.streams()[0]!.emit('end');
    await h.settle();

    assert.equal(h.lanes()[0]!.ended, true);
    assert.deepEqual(
      h.said('info').filter(line => line.event === 'voice.discord.utterance'),
      [{ event: 'voice.discord.utterance', userId: 'u-link', channel: h.channelId, delivered: 0.5, span: 1.5 }],
      'the audio delivered is told against the span the person was heard speaking',
    );
    assert.deepEqual(h.said('warn'), expected);
  });
}

test('a packet that will not decode is counted and the next one is heard: one bad packet is not a dead call', async t => {
  const { h } = await inCall(t);
  h.speaking.emit('start', 'u-link');

  h.streams()[0]!.emit('data', Buffer.from([0xff, 0xfe, 0xfd, 0xfc, 0xde, 0xad, 0xbe, 0xef]));
  h.streams()[0]!.emit('data', tone());

  const [warning] = h.said('warn');
  assert.equal(warning!.event, 'voice.discord.decode-error');
  assert.equal(warning!.userId, 'u-link');
  assert.match(String(warning!.error), /corrupted/);
  assert.equal(h.lanes()[0]!.pushed, 320, 'only the good packet reached the lane');
});

test('a person’s stream that fails is logged', async t => {
  const { h } = await inCall(t);
  h.speaking.emit('start', 'u-link');

  h.streams()[0]!.emit('error', new Error('socket reset'));

  assert.deepEqual(h.said('warn'), [
    { event: 'voice.discord.stream-error', userId: 'u-link', error: 'Error: socket reset' },
  ]);
});

for (const [name, user, speaker, person] of [
  ['their aivi person when the account is linked', 'u-link', 'person-u-link', true],
  ['their nickname in the guild when it is not', 'u-stranger', 'forger', false],
  ['their Discord handle when the guild has no nickname for them', 'u-named', 'handle', false],
  ['their id when Discord names nobody', 'u-nobody', 'u-nobody', false],
] as const) {
  test(`a speaker is heard under ${name}`, async t => {
    const { h } = await inCall(t);

    h.speaking.emit('start', user);

    assert.deepEqual(
      h.lanes().map(lane => lane.init),
      [{ speaker, user, person, channel: h.channelId }],
    );
  });
}

test('a join that fails is said, and tried again at the next presence', async t => {
  let attempts = 0;
  const { h } = await inCall(t, {
    join: () => {
      throw new Error(`no permission to connect (${++attempts})`);
    },
  });
  assert.deepEqual(h.said('warn'), [
    { event: 'voice.discord.join-failed', channelId: h.channelId, error: 'Error: no permission to connect (1)' },
  ]);

  h.client.emit('voiceStateUpdate');
  await h.settle();

  assert.equal(attempts, 2, 'nothing was left behind that would stop the next try');
});

for (const [name, options, reason] of [
  [
    'a gateway that never gets ready',
    () => ({
      ready: async () => {
        throw new Error('did not become ready in 20 s');
      },
    }),
    'Error: did not become ready in 20 s',
  ],
  [
    'a bot that was removed from the guild while it connected',
    (current: () => Harness) => ({
      ready: async () => {
        current().client.guilds.cache.delete(current().deps.config.guild);
      },
    }),
    'Error: voice: guild 123456789012345678 not found for the bot token',
  ],
] as const) {
  test(`${name}: the half-made connection is destroyed, the join is said to have failed, and the next presence tries again`, async t => {
    let current: Harness | undefined;
    const h = voiceHarness(options(() => current!));
    current = h;
    const watcher = watchVoice(h.deps);
    t.after(() => watcher.stop());
    await h.settle();
    h.enter(h.channelId, 'u-link');
    await h.settle();

    assert.deepEqual(
      h.connections().map(connection => connection.destroyed),
      [true],
    );
    assert.deepEqual(h.said('warn'), [{ event: 'voice.discord.join-failed', channelId: h.channelId, error: reason }]);

    h.client.emit('voiceStateUpdate');
    await h.settle();

    assert.deepEqual(h.joins, [h.channelId, h.channelId]);
  });
}

test('a guild the bot is not in cannot be joined, and that is said', async t => {
  const h = voiceHarness();
  const { join: _join, ready: _ready, play: _play, ...rest } = h.deps;
  h.client.guilds.cache.delete(h.deps.config.guild);
  const watcher = watchVoice(rest);
  t.after(() => watcher.stop());
  await h.settle();

  h.enter(h.channelId, 'u-link');
  await h.settle();

  assert.deepEqual(h.said('warn'), [
    {
      event: 'voice.discord.join-failed',
      channelId: h.channelId,
      error: 'Error: voice: guild 123456789012345678 not found for the bot token',
    },
  ]);
  assert.deepEqual(h.joins, []);
});

test('a connection’s errors and disconnections are said, with the channel they happened in', async t => {
  const { h } = await inCall(t);
  const [connection] = h.connections();

  connection!.emit('error', new Error('socket closed'));
  connection!.emit(VoiceConnectionStatus.Disconnected);

  assert.deepEqual(h.said('warn'), [
    { event: 'voice.discord.connection-error', channelId: h.channelId, error: 'Error: socket closed' },
    { event: 'voice.discord.disconnected', channelId: h.channelId },
  ]);
});

test('a voice plugin that fails to open a room is said, and the next presence opens it', async t => {
  const { h } = await inCall(t, { firstOpenFails: new Error('the engine fell over') });
  assert.deepEqual(h.said('warn'), [{ event: 'voice.discord.reconcile-failed', error: 'Error: the engine fell over' }]);
  assert.deepEqual(h.joins, []);

  h.client.emit('voiceStateUpdate');
  await h.settle();

  assert.equal(h.openCalls(), 1);
  assert.deepEqual(h.joins, [h.channelId]);
});

test('a presence that is still queued when the watcher stops joins nothing', async () => {
  const h = voiceHarness();
  const watcher = watchVoice(h.deps);

  h.enter(h.channelId, 'u-link');
  await watcher.stop();

  assert.deepEqual(h.joins, []);
  assert.equal(h.openCalls(), 0);
});

test('the end of an answer, when no answer is playing, changes nothing', async t => {
  const { h } = await inCall(t);

  h.mouthFlushes[0]!();

  assert.deepEqual(h.subscribed(), []);
  assert.deepEqual(h.played, []);
});

test('an answer that cannot be read as a wav is not spoken, and no player is woken for it', async t => {
  const { h } = await inCall(t);

  assert.equal(await h.mouthPlays[0]!(Buffer.alloc(44)), false);

  assert.deepEqual(h.said('warn'), [{ event: 'voice.discord.wav-unreadable', error: 'Error: not a RIFF/WAVE file' }]);
  assert.deepEqual(h.subscribed(), []);
});

test('an answer whose player fails is lost and said, and the next answer gets the air', async t => {
  const { h } = await inCall(t, { firstPlayFails: new Error('the player broke') });

  assert.equal(await h.mouthPlays[0]!(sineWav(24000, 0.1)), false, 'what never reached the wire is not played');
  const heard = h.mouthPlays[0]!(sineWav(24000, 0.1));
  h.mouthFlushes[0]!();

  assert.equal(await heard, true);
  assert.deepEqual(h.said('warn'), [
    { event: 'voice.discord.play-failed', channelId: h.channelId, error: 'Error: the player broke' },
  ]);
  assert.deepEqual(h.played, [5]);
});

test('a barge stops every player, even when one of them is already gone', async t => {
  const { h } = await inCall(t);
  h.enter(h.otherId, 'u-link'); // the same person sits in the other channel too: two connections
  await h.settle();
  const answer = h.mouthPlays[0]!(sineWav(24000, 0.1));
  const [gone, listening] = h.subscribed() as { stop(now: boolean): void }[];
  const failing = t.mock.method(gone!, 'stop', () => {
    throw new Error('this player is gone');
  });
  const stopped = t.mock.method(listening!, 'stop', () => true);

  h.mouthStops[0]!();

  assert.equal(await answer, false);
  assert.deepEqual(
    stopped.mock.calls.map(call => call.arguments),
    [[true]],
  );
  failing.mock.restore(); // leaving the channels at the end of the test stops the players for real
});

test('a band hands the player its packets in order, then silence while it waits, then the end once it is flushed', () => {
  const band = new PacketBand();
  const silence = Buffer.from([0xf8, 0xff, 0xfe]);
  const settled: boolean[] = [];

  band.add([Buffer.from('a'), Buffer.from('b')], played => void settled.push(played));
  assert.equal(band.pull(silence)!.toString(), 'a');
  assert.deepEqual(settled, [], 'the wav is played only when its last packet has left');
  assert.equal(band.pull(silence)!.toString(), 'b');
  assert.deepEqual(settled, [true]);
  assert.equal(band.pull(silence), silence, 'the wire is kept on air while the next wav is synthesized');
  band.flush();

  assert.equal(band.pull(silence), null, 'flushed and dry: the resource ends');
});

test('a killed band hands nothing, refuses more audio and settles what waited as unplayed, once', () => {
  const band = new PacketBand();
  const settled: boolean[] = [];
  let deaths = 0;
  band.onDead = () => {
    deaths++;
  };
  band.add([Buffer.from('a')], played => void settled.push(played));

  band.kill();
  band.kill();
  band.add([Buffer.from('b')], played => void settled.push(played));

  assert.equal(band.pull(Buffer.from([0])), null);
  assert.deepEqual(settled, [false, false]);
  assert.equal(deaths, 1);
});

for (const [name, wav, reason] of [
  ['one that is not PCM', sineWav(24000, 0.05, { format: 3 }), 'not PCM (format 3)'],
  ['one that is not 16-bit', sineWav(24000, 0.05, { bits: 8 }), 'not s16le (got 8 bit)'],
  ['one with no audio chunk', sineWav(24000, 0.05, { data: false }), 'wav lacks fmt+data'],
  ['one with no channels', sineWav(24000, 0.05, { channels: 0 }), 'wav lacks fmt+data'],
] as const) {
  test(`${name} is refused with the reason, and gives no packets`, () => {
    const { lines, log } = logOf();

    assert.deepEqual(wavToOpus(wav, log), []);

    assert.deepEqual(lines, [{ event: 'voice.discord.wav-unreadable', fields: { error: `Error: ${reason}` } }]);
  });
}

for (const [name, rate, channels] of [
  ['mono at 24 kHz, the voice plugin’s own', 24000, 1],
  ['stereo, mixed down', 24000, 2],
  ['48 kHz, which needs no resampling', 48000, 1],
  ['16 kHz, interpolated up', 16000, 1],
] as const) {
  test(`a wav of 0.1 s, ${name}, becomes five 20 ms packets`, () => {
    const { lines, log } = logOf();

    assert.equal(wavToOpus(sineWav(rate, 0.1, { channels }), log).length, 5);

    assert.deepEqual(lines, []);
  });
}

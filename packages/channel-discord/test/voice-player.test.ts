/** What the voice watcher asks of Discord's voice library: the join and its
 *  ready wait when no seam is given, and the audio player an answer plays on.
 *  `@discordjs/voice` is replaced by fakes of its four functions the watcher
 *  calls (the rest of the module is real), so the player is a plain emitter
 *  with a state, and a test moves it from state to state. The watcher is the
 *  real one over the fakes of `voice-fixture.ts`. */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Readable } from 'node:stream';
import { mock, type TestContext, test } from 'node:test';
import * as real from '@discordjs/voice';
import { sineWav, voiceHarness } from './voice-fixture.ts';

const { AudioPlayerStatus, NoSubscriberBehavior, StreamType, VoiceConnectionStatus } = real;

/** An audio player as the watcher touches it: a state, the events of a state change, `play` and `stop`. `play` leaves
 *  the player in the state a test chose to see after it (`made.afterPlay`), as the library moves it on. */
class FakePlayer extends EventEmitter {
  state: { status: real.AudioPlayerStatus } = { status: AudioPlayerStatus.Idle };
  play = mock.fn((_resource: unknown) => {
    if (made.afterPlay) this.state = { status: made.afterPlay };
  });
  stop = mock.fn((_force: boolean) => true);

  /** The library changes the player's state and says so. */
  become(status: real.AudioPlayerStatus) {
    const old = this.state;
    this.state = { status };
    this.emit('stateChange', old, this.state);
  }
}

const players: FakePlayer[] = [];
/** The state a player is made in, and the state it is in once it was given a resource (none: it stays as it was). */
const made = {
  status: AudioPlayerStatus.Idle as real.AudioPlayerStatus,
  afterPlay: undefined as real.AudioPlayerStatus | undefined,
};
const createAudioPlayer = mock.fn((_options: unknown) => {
  const player = new FakePlayer();
  player.state = { status: made.status };
  players.push(player);
  return player;
});
const createAudioResource = mock.fn((stream: unknown, options: unknown) => ({ stream, options }));
const joinVoiceChannel = mock.fn((_options: unknown): unknown => ({}));
const entersState = mock.fn(async (connection: unknown, _status: unknown, _ms: number) => connection);
mock.module('@discordjs/voice', {
  exports: { ...real, createAudioPlayer, createAudioResource, entersState, joinVoiceChannel },
});

const { watchVoice } = await import('../src/voice.ts');

type Calls = { mock: { calls: Array<{ arguments: unknown[] }> } };
const calls = (fn: Calls) => fn.mock.calls.map(call => call.arguments);

/** A meeting in progress over the library's fakes, with the watcher's own player seam: one linked person sits in the
 *  first channel, and no timer runs for real. */
async function inCall(
  t: TestContext,
  initial: real.AudioPlayerStatus = AudioPlayerStatus.Idle,
  afterPlay?: real.AudioPlayerStatus,
) {
  for (const fake of [createAudioPlayer, createAudioResource, joinVoiceChannel, entersState]) fake.mock.resetCalls();
  players.length = 0;
  made.status = initial;
  made.afterPlay = afterPlay;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = voiceHarness();
  const { play: _play, ...deps } = h.deps; // the answer is played by the watcher's own player code
  const watcher = watchVoice(deps);
  t.after(() => watcher.stop());
  await h.settle();
  h.enter(h.channelId, 'u-link');
  await h.settle();
  return { h, watcher };
}

test('without seams the watcher joins through Discord’s voice library and gives the connection 20 s to be ready', async t => {
  for (const fake of [joinVoiceChannel, entersState]) fake.mock.resetCalls();
  const h = voiceHarness();
  const { join, ready: _ready, play: _play, ...deps } = h.deps;
  const connection = join!(h.channelId); // what the library would hand back
  joinVoiceChannel.mock.mockImplementation(() => connection);
  entersState.mock.mockImplementation(async (handed: unknown) => handed);
  const watcher = watchVoice(deps);
  t.after(() => watcher.stop());
  await h.settle();

  h.enter(h.channelId, 'u-link');
  await h.settle();

  assert.deepEqual(calls(joinVoiceChannel), [
    [
      {
        channelId: h.channelId,
        guildId: h.deps.config.guild,
        adapterCreator: h.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false,
      },
    ],
  ]);
  assert.deepEqual(calls(entersState), [[connection, VoiceConnectionStatus.Ready, 20_000]]);
  assert.ok(h.said('info').some(line => line.event === 'voice.discord.joined'));
});

test('an answer plays as one resource on one player that listens to the connection, and the next answer plays on it again', async t => {
  const { h } = await inCall(t);

  const first = h.mouthPlays[0]!(sineWav(24000, 0.1)); // five packets
  await h.settle();
  const [player] = players;
  assert.deepEqual(calls(createAudioPlayer), [[{ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } }]]);
  assert.deepEqual(h.subscribed(), [player], 'the player is the connection’s audio source');
  assert.equal(player!.play.mock.callCount(), 1);
  const [[stream, options]] = calls(createAudioResource) as [[Readable, unknown]];
  assert.deepEqual(options, { inputType: StreamType.Opus });

  player!.become(AudioPlayerStatus.Playing);
  h.mouthFlushes[0]!(); // the answer is complete: the stream ends once it is dry
  const pulled = Array.from({ length: 7 }, () => stream.read() as Buffer | null);
  player!.become(AudioPlayerStatus.Idle);

  assert.equal(await first, true, 'the wav is played once its last packet has left');
  assert.deepEqual(
    pulled.map(packet => packet !== null && packet.length > 3),
    [true, true, true, true, true, false, false],
    'five real packets, then the end of the resource (a null that closes the stream)',
  );

  const second = h.mouthPlays[0]!(sineWav(24000, 0.05));
  await h.settle();
  assert.equal(createAudioPlayer.mock.callCount(), 1, 'one player for the channel, whatever the answers');
  assert.equal(player!.play.mock.callCount(), 2, 'a fresh resource for the new answer');
  h.mouthFlushes[0]!();
  for (let i = 0; i < 4; i++) (calls(createAudioResource)[1]![0] as Readable).read();
  assert.equal(await second, true);
});

test('while the next wav is being made the stream keeps the player on air with silence', async t => {
  const { h } = await inCall(t);
  h.mouthPlays[0]!(sineWav(24000, 0.02)); // one packet
  await h.settle();
  const [[stream]] = calls(createAudioResource) as [[Readable]];

  const pulled = [stream.read(), stream.read(), stream.read()] as Buffer[];

  assert.ok(pulled[0]!.length > 3, 'the packet first');
  assert.deepEqual(pulled[1], Buffer.from([0xf8, 0xff, 0xfe]), 'Discord’s own silence frame');
  assert.deepEqual(pulled[2], Buffer.from([0xf8, 0xff, 0xfe]));
});

test('an answer whose band was killed before the player was idle never plays', async t => {
  const { h } = await inCall(t, AudioPlayerStatus.Playing); // an earlier answer is still on the wire
  const answer = h.mouthPlays[0]!(sineWav(24000, 0.1));
  await h.settle();

  h.mouthStops[0]!(); // the person interrupts
  players[0]!.become(AudioPlayerStatus.Idle);
  await h.settle();

  assert.equal(await answer, false);
  assert.equal(players[0]!.play.mock.callCount(), 0);
  assert.equal(createAudioResource.mock.callCount(), 0);
  assert.deepEqual(h.said('warn'), []);
});

for (const [name, initial, afterPlay, patience, ms] of [
  ['to be idle for the answer’s turn', AudioPlayerStatus.Playing, undefined, 'idle', 60_000],
  ['to start playing what it was given', AudioPlayerStatus.Idle, AudioPlayerStatus.Buffering, 'playing/idle', 10_000],
  ['to finish what it was given', AudioPlayerStatus.Idle, AudioPlayerStatus.Playing, 'idle', 300_000],
] as const) {
  test(`a player that never comes ${name} fails the answer after ${ms / 1000} s`, async t => {
    const { h } = await inCall(t, initial, afterPlay);
    const answer = h.mouthPlays[0]!(sineWav(24000, 0.1));
    await h.settle(); // the answer is waiting for the player, as far as it gets
    t.mock.timers.tick(ms);
    await h.settle();

    assert.equal(await answer, false);
    assert.deepEqual(h.said('warn'), [
      {
        event: 'voice.discord.play-failed',
        channelId: h.channelId,
        error: `Error: player did not enter ${patience} within ${ms}ms`,
      },
    ]);
  });
}

test('a player that passes through states the answer does not wait for is waited on until it reaches the ones it does', async t => {
  const { h } = await inCall(t, AudioPlayerStatus.Idle, AudioPlayerStatus.Buffering);
  const answer = h.mouthPlays[0]!(sineWav(24000, 0.02)); // one packet
  await h.settle();
  const [player] = players;
  const [[stream]] = calls(createAudioResource) as [[Readable]];

  player!.become(AudioPlayerStatus.AutoPaused); // not the start the answer waits for
  player!.become(AudioPlayerStatus.Playing);
  h.mouthFlushes[0]!();
  stream.read();
  stream.read();
  assert.equal(await answer, true);
  player!.become(AudioPlayerStatus.Buffering); // not the end it waits for
  t.mock.timers.tick(300_000);
  await h.settle();

  assert.deepEqual(h.said('warn'), [
    {
      event: 'voice.discord.play-failed',
      channelId: h.channelId,
      error: 'Error: player did not enter idle within 300000ms',
    },
  ]);
});

test('a player that fails while the answer waits for it ends the answer, and says so twice: as the player’s and as the answer’s', async t => {
  const { h } = await inCall(t, AudioPlayerStatus.Playing);
  const answer = h.mouthPlays[0]!(sineWav(24000, 0.1));
  await h.settle();

  players[0]!.emit('error', new Error('the decoder exploded'));

  assert.equal(await answer, false);
  assert.deepEqual(h.said('warn'), [
    { event: 'voice.discord.player-error', channelId: h.channelId, error: 'Error: the decoder exploded' },
    { event: 'voice.discord.play-failed', channelId: h.channelId, error: 'Error: the decoder exploded' },
  ]);
});

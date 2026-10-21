import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { CHAT_COMMANDS } from '@aivi/host';
import type { VoiceRoom } from '@aivi/plugin/voice';
import { type VoiceConnection, VoiceConnectionStatus } from '@discordjs/voice';
import { ApplicationCommandOptionType, ChannelType } from 'discord.js';
import { authorized, discordConfigSchema, reaches } from '../src/config.ts';
import { DISCORD, discordCommands } from '../src/module.ts';
import { type DiscordVoiceConfig, resample16, type VoiceWatchDeps, watchVoice, wavToOpus } from '../src/voice.ts';

// the same placement the source uses: native opus seen through this package
const require = createRequire(import.meta.url);
const { OpusEncoder } = require('@discordjs/opus') as {
  OpusEncoder: new (rate: number, channels: number) => { encode(buf: Buffer): Buffer; decode(buf: Buffer): Buffer };
};

// the wire's silence, and the wire's patience, in test units
const SILENCE_FRAME = Buffer.from([248, 255, 254]);
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const config = discordConfigSchema.parse({
  applicationId: '10000000000000001',
  directory: '/assistant',
  messageContent: true,
  access: {
    channels: [
      { id: '10000000000000004', trigger: 'mention-to-start' },
      { id: '10000000000000006', trigger: 'any', sessions: 'channel' },
    ],
  },
});

const ME = '10000000000000002';

test('access policy: linked persons talk anywhere aivi listens, unlinked accounts nowhere', () => {
  const dm = {
    channelId: 'dm',
    userId: ME,
    guildId: null,
    parentId: null,
    isDM: true,
    mentioned: false,
    knownConversation: false,
    senderLinked: true,
  };
  assert.equal(authorized(config, dm), true, 'a linked person may DM');
  assert.equal(authorized(config, { ...dm, senderLinked: false }), false, 'an unlinked account may not');
  assert.equal(authorized(config, { ...dm, guildId: 'g' }), false, 'a DM route must not carry a guild');
  const home = {
    channelId: '10000000000000004',
    userId: ME,
    guildId: 'g',
    parentId: null,
    isDM: false,
    mentioned: true,
    knownConversation: false,
    senderLinked: true,
  };
  assert.equal(authorized(config, home), true, 'any linked person may ping the home channel');
  assert.equal(authorized(config, { ...home, senderLinked: false }), false, 'strangers are ignored in channels');
  assert.equal(authorized(config, { ...home, mentioned: false }), false, 'home channel requires a mention');
  assert.equal(
    authorized(config, { ...home, channelId: 'thread-1', parentId: '10000000000000004' }),
    true,
    'threads inherit their parent channel policy',
  );
  const inThread = { ...home, channelId: 'thread-1', parentId: '10000000000000004', mentioned: false };
  assert.equal(
    authorized(config, { ...inThread, knownConversation: true }),
    true,
    'mention-to-start: no mention needed once aivi is in the thread',
  );
  assert.equal(authorized(config, inThread), false, 'a thread aivi is not part of still needs a mention');
  assert.equal(
    authorized(
      { ...config, access: { ...config.access, channels: [{ ...config.access.channels[0]!, trigger: 'mention' }] } },
      { ...inThread, knownConversation: true },
    ),
    false,
    'plain mention mode always needs a mention',
  );
  const always = { ...home, channelId: '10000000000000006', mentioned: false };
  assert.equal(authorized(config, always), true, 'an always-on channel hears linked persons without a mention');
  assert.equal(authorized(config, { ...home, channelId: 'elsewhere', parentId: null }), false);
  assert.equal(
    authorized(config, { ...always, channelId: 'thread-2', parentId: '10000000000000006' }),
    false,
    'channel mode ignores threads',
  );
  assert.equal(config.access.channels[0]!.sessions, 'threads', 'thread mode is the default');
  assert.throws(
    () =>
      discordConfigSchema.parse({
        applicationId: '10000000000000001',
        directory: '/l',
        access: { channels: [{ id: '10000000000000004' }] },
      }),
    /messageContent/,
  );
  assert.equal(config.access.channels[0]!.trigger, 'mention-to-start', 'natural thread behaviour is the default');
  assert.deepEqual(DISCORD, { id: 'discord', label: 'Discord', replyLimit: 1900 });
});

test('reaches: the place decides, the sender does not', () => {
  const base = {
    userId: ME,
    guildId: 'g',
    parentId: null,
    isDM: false,
    mentioned: false,
    knownConversation: false,
    senderLinked: false,
  };
  assert.equal(reaches(config, { ...base, channelId: '10000000000000004' }), true);
  assert.equal(reaches(config, { ...base, channelId: 'thread-1', parentId: '10000000000000004' }), true);
  assert.equal(reaches(config, { ...base, channelId: 'thread-1', parentId: '10000000000000006' }), false);
  assert.equal(reaches(config, { ...base, channelId: 'elsewhere' }), false);
  assert.equal(reaches(config, { ...base, channelId: 'dm', guildId: null, isDM: true }), true, 'DMs always reach');
  assert.equal(reaches(config, { ...base, channelId: 'dm', isDM: true }), false, 'the guild stays checked');
});

test('slash commands are the shared table, so a command cannot exist without a handler or vice versa', () => {
  const commands = discordCommands().map(c => c.toJSON());
  assert.deepEqual(
    commands.map(c => c.name),
    CHAT_COMMANDS.map(c => c.name),
  );
  const byName = new Map(commands.map(c => [c.name, c]));
  assert.equal(byName.get('new')!.options?.length ?? 0, 0);
  assert.deepEqual(
    byName.get('search')!.options!.map(o => [o.name, o.type, o.required]),
    [
      ['query', ApplicationCommandOptionType.String, true],
      ['project', ApplicationCommandOptionType.String, false],
    ],
  );
  const model = byName.get('model')!.options![0]!;
  assert.deepEqual(
    [model.name, model.required, (model as { autocomplete?: boolean }).autocomplete],
    ['model', false, true],
  );
  const queue = byName.get('queue')!.options![0]!;
  assert.deepEqual(
    [queue.name, queue.required, (queue as { autocomplete?: boolean }).autocomplete],
    ['text', true, false],
  );
  assert.ok(commands.every(c => c.description.length <= 100));
});

test('voice block: join these channels or none, and Discord names the speakers', () => {
  // absent: aivi never joins voice
  assert.equal(config.voice, undefined);
  const base = {
    applicationId: '10000000000000001',
    directory: '/assistant',
    access: { channels: [] },
  };
  const voice = discordConfigSchema.parse({
    ...base,
    voice: { guild: '123456789012345678', channels: ['223456789012345678'] },
  }).voice!;
  assert.equal(voice.silenceMs, 500);
  // snowflakes only, and at least one channel
  assert.equal(
    discordConfigSchema.safeParse({
      ...base,
      voice: { guild: 'not-a-snowflake', channels: ['223456789012345678'] },
    }).success,
    false,
  );
  assert.equal(
    discordConfigSchema.safeParse({
      ...base,
      voice: { guild: '123456789012345678', channels: [] },
    }).success,
    false,
  );
});

test('resample16: exact 3:1 box average, ASR grade and honest length', () => {
  const f48 = new Float32Array([0.3, 0.6, 0.9, -0.3, -0.6, -0.9, 0.5, 0.5]); // last two: no full triple
  const pcm = resample16(f48);
  assert.equal(pcm.length, 2, 'floor(n/3): a partial triple is not a sample');
  assert.ok(Math.abs(pcm[0]! - 0.6) < 1e-6);
  assert.ok(Math.abs(pcm[1]! + 0.6) < 1e-6);
});

/** Presence-driven voice: the watcher joins where a linked person sits and
 *  leaves where none remains. Everything is faked — no Discord, no engine. */
function voiceHarness(
  options: { linked?: string[]; openRoom?: () => VoiceRoom | null; playGate?: () => Promise<void> } = {},
) {
  const guildId = '123456789012345678';
  const channelId = '223456789012345678';
  const otherId = '323456789012345678';
  const linked = new Set(options.linked ?? ['u-link']);
  const members = new Map<string, { user: { bot: boolean } }>();
  const otherMembers = new Map<string, { user: { bot: boolean } }>();
  const channel = {
    type: ChannelType.GuildVoice,
    // the real guild member manager answers through .cache; the map is both
    members: Object.assign(members, { cache: members }),
  };
  const otherChannel = {
    type: ChannelType.GuildVoice,
    members: Object.assign(otherMembers, { cache: otherMembers }),
  };
  const client = Object.assign(new EventEmitter(), {
    channels: {
      cache: new Map<string, unknown>([
        [channelId, channel],
        [otherId, otherChannel],
      ]),
    },
    guilds: {
      cache: new Map<string, unknown>([
        [
          guildId,
          { voiceAdapterCreator: () => ({}), members: { cache: new Map([['u-stranger', { displayName: 'forger' }]]) } },
        ],
      ]),
    },
  });
  const joins: string[] = [];
  const played: number[] = [];
  const logs: string[] = [];
  const log = {
    debug: (msg: string) => logs.push(`debug ${msg}`),
    info: (msg: string) => logs.push(`info ${msg}`),
    warn: (msg: string) => logs.push(`warn ${msg}`),
    error: (msg: string) => logs.push(`error ${msg}`),
  };
  let roomStops = 0;
  const mouthPlays: Array<(wav: Buffer) => boolean | Promise<boolean>> = [];
  const mouthStops: Array<() => void> = [];
  const mouthFlushes: Array<() => void> = [];
  const mouth = { regs: 0, unregs: 0 };
  const barges: string[] = [];
  // Live lanes hear() opens: tests inspect who got one, whether they were
  // marked a person, and what became of their audio.
  interface FakeLane {
    init: { speaker: string; user: string; person?: boolean; channel?: string };
    pushed: number;
    ended: boolean;
    aborted: boolean;
  }
  const lanes: FakeLane[] = [];
  const utteranceStreams: EventEmitter[] = [];
  // the receiver's per-user subscription map, as the real one keeps it
  const subscriptions = new Map<string, EventEmitter>();
  // the receiver's speaking lane, wired for real: hear() subscribes here,
  // and a test can put words (or interruptions) in the room by emitting
  const speaking = new EventEmitter();
  const fakeRoom = {
    feed: async () => {},
    heard: async () => '',
    lane: (init: { speaker: string; user: string; person?: boolean; channel?: string }) => {
      const l: FakeLane = { init, pushed: 0, ended: false, aborted: false };
      lanes.push(l);
      return {
        push: (pcm: Float32Array) => {
          l.pushed += pcm.length;
        },
        end: async () => {
          l.ended = true;
          return '';
        },
        abort: () => {
          l.aborted = true;
        },
      };
    },
    mouth: (play: (wav: Buffer) => boolean, stop?: () => void, flush?: () => void) => {
      mouth.regs++;
      mouthPlays.push(play);
      if (stop) mouthStops.push(stop);
      if (flush) mouthFlushes.push(flush);
      return () => {
        mouth.unregs++;
      };
    },
    bargeIn: () => {
      barges.push('barge');
    },
    onEvent: () => {},
    stop: async () => {
      roomStops++;
    },
  } as unknown as VoiceRoom;
  let openCalls = 0;
  const deps: VoiceWatchDeps = {
    client: client as unknown as VoiceWatchDeps['client'],
    config: {
      guild: guildId,
      channels: [channelId, otherId],
      silenceMs: 500,
    } satisfies DiscordVoiceConfig,
    openRoom:
      options.openRoom ??
      (() => {
        openCalls++;
        return fakeRoom;
      }),
    personName: userId => (linked.has(userId) ? `person-${userId}` : undefined),
    log,
    join: channelIdArg => {
      joins.push(channelIdArg);
      const connection = new EventEmitter() as EventEmitter & {
        state: { status: VoiceConnectionStatus };
        destroyed: boolean;
        destroy(): void;
        receiver: unknown;
        subscribe: unknown;
      };
      connection.state = { status: VoiceConnectionStatus.Ready };
      connection.destroyed = false;
      connection.destroy = () => {
        connection.destroyed = true;
      };
      connection.receiver = {
        speaking: {
          on: (event: string, fn: (userId: string) => void) => {
            speaking.on(event, fn);
          },
        },
        // faithful to the real receiver: while a user's stream is open,
        // subscribe hands back THAT SAME STREAM, and 'close' (which follows
        // 'end' the way autoDestroy does) frees the user for a new one.
        subscribe: (userId: string) => {
          const existing = subscriptions.get(userId);
          if (existing) return existing;
          const stream = new EventEmitter();
          subscriptions.set(userId, stream);
          stream.once('end', () => stream.emit('close'));
          stream.once('close', () => {
            if (subscriptions.get(userId) === stream) subscriptions.delete(userId);
          });
          utteranceStreams.push(stream);
          return stream;
        },
      };
      connection.subscribe = () => () => {}; // the audio player's seat
      return connection as unknown as VoiceConnection;
    },
    ready: async () => {},
    // the real player state machine wants a live connection; here the play
    // drains ONE ANSWER's band like the wire does: pull packets until the
    // flush drains dry (or a barge kills the band), counting real audio —
    // one call per answer is itself the proof that chunks share a resource
    play: async (_player, band) => {
      if (options.playGate) await options.playGate();
      let n = 0;
      while (!band.drained()) {
        const p = band.pull(SILENCE_FRAME);
        if (p === null) break; // the answer died: the resource is over
        if (p !== SILENCE_FRAME) {
          n++;
          continue;
        }
        await sleep(1); // on air, feeding silence while the next chunk lands
      }
      if (n > 0) played.push(n);
    },
  };
  const settle = () => new Promise(resolve => setImmediate(resolve));
  const enter = (target: string, userId: string, bot = false) => {
    (client.channels.cache.get(target) as { members: Map<string, { user: { bot: boolean } }> }).members.set(userId, {
      user: { bot },
    });
    client.emit('voiceStateUpdate');
  };
  const exit = (target: string, userId: string) => {
    (client.channels.cache.get(target) as { members: Map<string, unknown> }).members.delete(userId);
    client.emit('voiceStateUpdate');
  };
  const move = (from: string, to: string, userId: string) => {
    // Discord says “moved” in one event: the meeting must survive the walk.
    (client.channels.cache.get(from) as { members: Map<string, unknown> }).members.delete(userId);
    (client.channels.cache.get(to) as { members: Map<string, { user: { bot: boolean } }> }).members.set(userId, {
      user: { bot: false },
    });
    client.emit('voiceStateUpdate');
  };
  return {
    deps,
    joins,
    played,
    logs,
    settle,
    enter,
    exit,
    move,
    mouthPlays,
    mouthStops,
    mouthFlushes,
    barges: () => barges.length,
    lanes: () => lanes,
    streams: () => utteranceStreams,
    speaking,
    mouthCounts: () => ({ ...mouth }),
    roomStops: () => roomStops,
    openCalls: () => openCalls,
    channelId,
    otherId,
  };
}

test('voice presence: nobody in, nothing born — no room, no join, no transcript', async () => {
  const h = voiceHarness();
  const watcher = watchVoice(h.deps);
  await h.settle();
  assert.deepEqual(h.joins, [], 'the bot stays out of the empty channel');
  assert.equal(h.openCalls(), 0, 'the voice seat is never asked at startup');
  await watcher.stop();
});

test('voice presence: a linked person opens the meeting; the last one out closes it', async () => {
  const h = voiceHarness();
  const watcher = watchVoice(h.deps);
  h.enter(h.channelId, 'u-link');
  await h.settle();
  assert.deepEqual(h.joins, [h.channelId], 'the bot joins where its person sits');
  assert.ok(h.logs.includes('info voice.discord.meeting-open'));
  h.move(h.channelId, h.otherId, 'u-link'); // walks to the other configured channel
  await h.settle();
  assert.deepEqual(h.joins, [h.channelId, h.otherId], 'the bot follows');
  assert.ok(h.logs.includes('info voice.discord.left'), 'the empty channel was left');
  assert.equal(h.openCalls(), 1, 'one meeting, not one per channel');
  assert.equal(h.roomStops(), 0, 'the walk does not close the meeting');
  h.exit(h.otherId, 'u-link');
  await h.settle();
  assert.equal(h.roomStops(), 1, 'the meeting closed with the last person: transcript and engine end here');
  await watcher.stop();
  assert.equal(h.roomStops(), 1, 'stopping an already-closed watcher stops nothing twice');
});

test('voice presence: strangers and bots never summon the bot', async () => {
  const h = voiceHarness();
  const watcher = watchVoice(h.deps);
  h.enter(h.channelId, 'u-stranger');
  h.enter(h.channelId, 'u-bot', true);
  await h.settle();
  assert.deepEqual(h.joins, []);
  assert.equal(h.openCalls(), 0);
  h.enter(h.channelId, 'u-link');
  await h.settle();
  assert.deepEqual(h.joins, [h.channelId], 'the linked arrival is what moves the bot');
  await watcher.stop();
});

test('voice presence: a missing voice plugin says so once and never takes the text bot down', async () => {
  const h = voiceHarness({ openRoom: () => null });
  const watcher = watchVoice(h.deps);
  h.enter(h.channelId, 'u-link');
  await h.settle();
  assert.equal(h.logs.filter(l => l === 'error voice.not-loaded').length, 1, 'one loud line, not a loop');
  h.exit(h.channelId, 'u-link');
  h.enter(h.channelId, 'u-link');
  await h.settle();
  assert.equal(h.logs.filter(l => l === 'error voice.not-loaded').length, 1, 'the repeat stays quiet');
  await watcher.stop();
});

test('voice presence: a channel id that is not a voice channel is said at boot, loudly', async () => {
  const h = voiceHarness();
  (h.deps.client.channels.cache as unknown as Map<string, { type: number }>).set('423456789012345678', {
    type: ChannelType.GuildText,
  });
  const watcher = watchVoice({
    ...h.deps,
    config: { ...h.deps.config, channels: [h.channelId, '423456789012345678'] },
  });
  await h.settle();
  assert.ok(
    h.logs.some(l => l === 'warn voice.discord.channel-invalid'),
    'a typo is not read as an eternally empty channel',
  );
  await watcher.stop();
});

// The spoken lane: the voice plugin synthesizes a wav, this package puts it
// on the wire as opus — and says so at every step.

test('voice mouth: the meeting registers a voice and takes it back when it closes', async () => {
  const h = voiceHarness();
  const watcher = watchVoice(h.deps);
  h.enter(h.channelId, 'u-link');
  await h.settle();
  assert.equal(h.mouthCounts().regs, 1, 'the room gets a mouth when the meeting opens');
  assert.equal(h.mouthCounts().unregs, 0);
  h.exit(h.channelId, 'u-link');
  await h.settle();
  assert.equal(h.mouthCounts().unregs, 1, 'the mouth goes with the meeting, not the module');
  // an answer with no connection is refused at once, loudly
  assert.equal(await h.mouthPlays[0]!(sineWav(24000, 0.05)), false, 'the refusal settles at once');
  assert.ok(h.logs.includes('warn voice.discord.unspoken'), 'nothing swallowed silently');
  await watcher.stop();
});

test('voice mouth: an answer plays as opus to the end and says so', async () => {
  const h = voiceHarness();
  const watcher = watchVoice(h.deps);
  h.enter(h.channelId, 'u-link');
  await h.settle();
  assert.equal(await h.mouthPlays[0]!(sineWav(24000, 0.1)), true, 'the mouth plays the wav and says so');
  h.mouthFlushes[0]!(); // the answer is over: the player may drain
  await sleep(10);
  assert.deepEqual(h.played, [5], '0.1 s at 24 kHz → five 20 ms opus frames, played — not buffered');
  assert.ok(h.logs.includes('debug voice.discord.spoken'), h.logs.join('\n'));
  await watcher.stop();
});

test('barge-in is words-verified: a speaking start opens a live lane, not a silence', async () => {
  const h = voiceHarness();
  const watcher = watchVoice(h.deps);
  h.enter(h.channelId, 'u-link');
  await h.settle();
  // A sniffle passes Discord's VAD (speaking start) but carries no words:
  // the start opens a LIVE lane and subscribes audio — it does not silence
  // aivi. Words verify the interruption inside the room (voice package
  // coverage); here: who gets a lane, and what a cough comes to.
  h.speaking.emit('start', 'u-link');
  assert.equal(h.barges(), 0, 'a bare speaking start no longer silences aivi');
  assert.equal(h.lanes().length, 1, 'the speaker got a live lane of their own');
  assert.equal(h.lanes()[0]!.init.person, true, 'a linked person may interrupt');
  h.speaking.emit('start', 'u-stranger');
  assert.equal(h.lanes()[1]!.init.person, false, 'a stranger is heard but cannot interrupt');
  // audio too short to be an utterance: the lane aborts unheard, no line
  h.streams()[0]!.emit('end');
  await h.settle();
  assert.ok(h.lanes()[0]!.aborted, 'a cough is not an utterance: the lane closes unheard');
  assert.equal(h.lanes()[0]!.ended, false, 'nothing was committed for it');
  await watcher.stop();
});

test('a breath mid-utterance keeps one lane: the same sentence is never heard twice', async () => {
  const h = voiceHarness();
  const watcher = watchVoice(h.deps);
  h.enter(h.channelId, 'u-link');
  await h.settle();
  h.speaking.emit('start', 'u-link');
  assert.equal(h.lanes().length, 1, 'the speaker opens a lane');
  // Discord's VAD drops the speaking flag on a breath and re-fires the
  // start; the receiver would hand the still-open stream to a second
  // subscribe — two lanes on one stream heard every remaining word twice.
  h.speaking.emit('start', 'u-link');
  assert.equal(h.lanes().length, 1, 'a mid-utterance re-start opens no second lane');
  assert.equal(h.streams().length, 1, 'the breath never subscribed onto the open stream');
  // the utterance closes, the stream closes with it: the next utterance is
  // a fresh lane, not a ghost on the old one
  h.streams()[0]!.emit('end');
  await h.settle();
  h.speaking.emit('start', 'u-link');
  assert.equal(h.lanes().length, 2, 'a new utterance after the close gets its own lane');
  await watcher.stop();
});

test('one answer plays as one continuous resource: no seam between chunks touches the wire', async () => {
  // a latch, not a one-shot promise: the second answer's drain must pass
  // once the gate is open, not await a fresh promise nobody resolves
  let gateOpen = false;
  let openGate = () => {};
  const gate = new Promise<void>(res => {
    openGate = () => {
      gateOpen = true;
      res();
    };
  });
  const h = voiceHarness({ playGate: async () => (gateOpen ? undefined : gate) });
  const watcher = watchVoice(h.deps);
  h.enter(h.channelId, 'u-link');
  await h.settle();
  // The old shape played every TTS chunk as its own resource: the player
  // touched Idle at each seam (~113 ms of silence) and long answers stuttered
  // every two seconds. A band is one answer, one resource.
  const first = h.mouthPlays[0]!(sineWav(24000, 0.1)); // opens the answer's band — wire stalled
  const second = h.mouthPlays[0]!(sineWav(24000, 0.1)); // joins the SAME band, no new resource
  h.mouthFlushes[0]!(); // the answer's last chunk is handed over
  assert.deepEqual(h.played, [], 'the gate holds the wire');
  openGate();
  await sleep(10);
  assert.deepEqual(h.played, [10], 'one drain took ten packets: the play seam ran ONCE for the answer');
  assert.equal(await first, true, 'both chunks played');
  assert.equal(await second, true, 'and their promises say played, not queued');
  // the next answer is a fresh resource: between answers the wire may rest
  const third = h.mouthPlays[0]!(sineWav(24000, 0.05));
  h.mouthFlushes[0]!();
  await sleep(10);
  assert.deepEqual(h.played, [10, 3], 'a new answer opens a new drain');
  assert.equal(await third, true);
  await watcher.stop();
});

test('a barge kills the unheard packets: every wav promise settles at once', async () => {
  let gateOpen = false;
  let openGate = () => {};
  const gate = new Promise<void>(res => {
    openGate = () => {
      gateOpen = true;
      res();
    };
  });
  const h = voiceHarness({ playGate: async () => (gateOpen ? undefined : gate) });
  const watcher = watchVoice(h.deps);
  h.enter(h.channelId, 'u-link');
  await h.settle();
  // The room holds its speaking window open until each chunk's promise
  // settles — a promise that resolved at enqueue left aivi talking through
  // interruptions while the room believed nobody was on the air.
  const first = h.mouthPlays[0]!(sineWav(24000, 0.1));
  const second = h.mouthPlays[0]!(sineWav(24000, 0.1));
  h.mouthFlushes[0]!();
  h.mouthStops[0]!(); // the person interrupts: silence now, unheard packets die
  assert.equal(await first, false, 'packets that never reached the wire are unheard, not “played”');
  assert.equal(await second, false, 'the queued chunk dies with the answer');
  openGate();
  await sleep(10);
  assert.deepEqual(h.played, [], 'nothing played after the answer died');
  assert.equal(h.logs.filter(l => l === 'debug voice.discord.spoken').length, 0, 'spoken means played: nothing was');
  await watcher.stop();
});

test('the TTS wav becomes 20 ms stereo opus that decodes back', () => {
  const logs: string[] = [];
  const log = { debug: () => {}, info: () => {}, warn: (m: string) => void logs.push(m), error: () => {} };
  const packets = wavToOpus(sineWav(24000, 0.1), log);
  assert.equal(packets.length, 5, '0.1 s at 24 kHz → five 20 ms frames at 48 kHz');
  assert.deepEqual(logs, [], 'a clean wav costs no complaint');
  const decoder = new OpusEncoder(48000, 2);
  const back: Buffer = decoder.decode(packets[0]!);
  assert.equal(back.length / 2, 1920, 'one frame: 960 samples per channel, stereo');
});

test('a corrupted packet is caught and the decoder lives', () => {
  // Why native (live incident 2026-10-12): opusscript's shared WASM heap
  // turned ONE mid-stream corrupted packet into a dead process-wide opus
  // subsystem — hearing and speaking both "memory access out of bounds"
  // until restart. Native libopus: the bad packet throws catchably and
  // everything after it still decodes.
  const codec = new OpusEncoder(48000, 2);
  const good = codec.encode(Buffer.alloc(960 * 2 * 2));
  assert.throws(() => codec.decode(Buffer.from([0xff, 0xfe, 0xfd, 0xfc, 0xde, 0xad, 0xbe, 0xef])));
  assert.equal(codec.decode(good).length, 3840, 'the decoder survived the corruption');
});

test('a wav that is not PCM is said, not swallowed', () => {
  const logs: string[] = [];
  const log = { debug: () => {}, info: () => {}, warn: (m: string) => void logs.push(m), error: () => {} };
  assert.equal(wavToOpus(Buffer.alloc(44), log).length, 0);
  assert.ok(logs.includes('voice.discord.wav-unreadable'));
});

/** One second-fraction of 440 Hz sine as a s16le mono wav, header by hand. */
function sineWav(rate: number, seconds: number): Buffer {
  const n = Math.round(rate * seconds);
  const wav = Buffer.alloc(44 + n * 2);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + n * 2, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    wav.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * (i / rate)) * 8000), 44 + 2 * i);
  }
  return wav;
}

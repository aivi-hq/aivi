/** Presence-driven voice, with everything faked: the watcher joins where a
 *  linked person sits and leaves where none remains. The guild, its channels
 *  and its members, the connections (what `join` hands back), the receiver that
 *  names speakers, and the voice room are fakes made of plain objects; the
 *  watcher is the real one, and so is Discord's native opus. Nothing here opens
 *  a socket or talks to Discord. */
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import type { VoiceRoom } from '@aivi/plugin/voice';
import { type VoiceConnection, VoiceConnectionStatus } from '@discordjs/voice';
import { ChannelType } from 'discord.js';
import type { DiscordVoiceConfig, VoiceWatchDeps } from '../src/voice.ts';

const require = createRequire(import.meta.url);
type Codec = { encode(buf: Buffer): Buffer; decode(buf: Buffer): Buffer };
/** The native opus codec of the package, as the source sees it (one object that encodes and decodes). */
export const codec = (): Codec =>
  new (require('@discordjs/opus') as { OpusEncoder: new (rate: number, channels: number) => Codec }).OpusEncoder(
    48000,
    2,
  );

/** The wire's silence, in test units. */
const SILENCE_FRAME = Buffer.from([248, 255, 254]);
export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export interface HarnessOptions {
  linked?: string[];
  openRoom?: () => VoiceRoom | null;
  playGate?: () => Promise<void>;
  /** What a lane answers when its utterance ends. */
  heard?: () => Promise<string | null>;
  /** The wait for a connection to be ready; the default is ready at once. */
  ready?: (connection: VoiceConnection) => Promise<unknown>;
  /** The join itself; the default hands back a fake connection. */
  join?: (channelId: string) => VoiceConnection;
  /** The player's first drain fails with this, the next ones run. */
  firstPlayFails?: Error;
  /** The voice plugin fails to open the first room with this, the next opens work. */
  firstOpenFails?: Error;
}

export function voiceHarness(options: HarnessOptions = {}) {
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
  const guild = {
    voiceAdapterCreator: () => ({}),
    members: {
      cache: new Map<string, unknown>([
        ['u-stranger', { displayName: 'forger' }],
        ['u-named', { user: { username: 'handle' } }],
      ]),
    },
  };
  const client = Object.assign(new EventEmitter(), {
    channels: {
      cache: new Map<string, unknown>([
        [channelId, channel],
        [otherId, otherChannel],
      ]),
    },
    guilds: { cache: new Map<string, unknown>([[guildId, guild]]) },
  });
  const joins: string[] = [];
  const played: number[] = [];
  const logs: string[] = [];
  const lines: { level: string; event: string; fields: Record<string, unknown> | undefined }[] = [];
  const said = (level: string) => (msg: string, fields?: Record<string, unknown>) => {
    logs.push(`${level} ${msg}`);
    lines.push({ level, event: msg, fields });
  };
  const log = { debug: said('debug'), info: said('info'), warn: said('warn'), error: said('error') };
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
    chunks: Float32Array[];
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
  const connections: (EventEmitter & { destroyed: boolean })[] = [];
  const subscribed: unknown[] = [];
  const fakeRoom = {
    feed: async () => {},
    heard: async () => '',
    lane: (init: { speaker: string; user: string; person?: boolean; channel?: string }) => {
      const l: FakeLane = { init, pushed: 0, chunks: [], ended: false, aborted: false };
      lanes.push(l);
      return {
        push: (pcm: Float32Array) => {
          l.pushed += pcm.length;
          l.chunks.push(pcm);
        },
        end: async () => {
          l.ended = true;
          return options.heard ? options.heard() : '';
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
  let openAttempts = 0;
  let playsFailed = false;
  const fakeConnection = (channelIdArg: string) => {
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
    connection.subscribe = (player: unknown) => {
      subscribed.push(player);
      return () => {};
    }; // the audio player's seat
    connections.push(connection);
    return connection as unknown as VoiceConnection;
  };
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
        if (options.firstOpenFails && openAttempts++ === 0) throw options.firstOpenFails;
        openCalls++;
        return fakeRoom;
      }),
    personName: userId => (linked.has(userId) ? `person-${userId}` : undefined),
    log,
    join: options.join ?? fakeConnection,
    ready: options.ready ?? (async () => {}),
    // the real player state machine wants a live connection; here the play
    // drains ONE ANSWER's band like the wire does: pull packets until the
    // flush drains dry (or a barge kills the band), counting real audio —
    // one call per answer is itself the proof that chunks share a resource
    play: async (_player, band) => {
      if (options.firstPlayFails && !playsFailed) {
        playsFailed = true;
        throw options.firstPlayFails;
      }
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
    client,
    guild,
    joins,
    played,
    logs,
    /** What the watcher said at a level, line by line, with its fields. */
    said: (level: string): Record<string, unknown>[] =>
      lines.filter(line => line.level === level).map(({ event, fields }) => ({ event, ...fields })),
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
    connections: () => connections,
    /** What the watcher gave each connection to subscribe: the audio players. */
    subscribed: () => subscribed,
    speaking,
    mouthCounts: () => ({ ...mouth }),
    roomStops: () => roomStops,
    openCalls: () => openCalls,
    channelId,
    otherId,
  };
}

/** A s16le wav, header by hand: `seconds` of a 440 Hz sine at `rate`, in `channels` identical channels. The format
 *  and the bit depth can be written wrong, and the `data` chunk left out, to make a wav that cannot be read. */
export function sineWav(
  rate: number,
  seconds: number,
  {
    channels = 1,
    format = 1,
    bits = 16,
    data = true,
  }: { channels?: number; format?: number; bits?: number; data?: boolean } = {},
): Buffer {
  const n = Math.round(rate * seconds);
  const size = data ? n * channels * 2 : 0;
  const wav = Buffer.alloc(44 + size);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(36 + size, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(format, 20);
  wav.writeUInt16LE(channels, 22);
  wav.writeUInt32LE(rate, 24);
  wav.writeUInt32LE(rate * channels * 2, 28);
  wav.writeUInt16LE(channels * 2, 32);
  wav.writeUInt16LE(bits, 34);
  wav.write(data ? 'data' : 'junk', 36);
  wav.writeUInt32LE(size, 40);
  for (let i = 0; i < n; i++) {
    const sample = Math.round(Math.sin(2 * Math.PI * 440 * (i / rate)) * 8000);
    for (let c = 0; c < channels && data; c++) wav.writeInt16LE(sample, 44 + 2 * (i * channels + c));
  }
  return wav;
}

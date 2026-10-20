/** Discord voice capture: the bot hears its configured channels — but only
 *  while its people are there.
 *
 *  Presence drives everything: the first **linked person** entering a
 *  configured channel opens a meeting (voice room born, connection made);
 *  the last one leaving ends it (connection destroyed, room stopped, the
 *  transcript closes — bounded). The engine outlives it: models are warm
 *  in `@aivi/voice` for the next meeting, not the channel's to keep. Bots
 *  and strangers never summon anything: the operator not being in a channel
 *  must cost nothing, and a voice block that idles 99.99% of the day must
 *  idle as *nothing*, not as a held connection and an open-ended transcript.
 *  The voice plugin is resolved at that first join, never at startup: it is
 *  optional, and an optional capability must not be a boot dependency of a
 *  module that starts before it (a serve that died at boot because discord
 *  asked for the voice seat before the voice module provided it was exactly
 *  that bug, ruled out 2026-10-12).
 *
 *  Discord names its speakers (SSRC → user id) and streams each one live:
 *  every utterance is decoded while the person is still talking and pushed
 *  into a `lane()` of the voice room under that name — a linked account
 *  speaks under its aivi person name, everyone else keeps their Discord
 *  display name. Our `silenceMs` (AfterSilence) rule says when an utterance
 *  ends. Identifying people from audio is the voice plugin's job for
 *  anonymous rooms; this room is not anonymous.
 *
 *  DAVE reality, verified 2026-10-11: Discord enforces E2EE on voice since
 *  2026-03-01; @discordjs/voice 0.19.2 fixed the zero-audio receive bug
 *  (#11419 / PR #11449), yet receive stays officially "stable support not
 *  guaranteed". So every utterance logs delivered audio against the
 *  speaking span — silent loss cannot hide here.
 *
 *  Aivi also SPEAKS: the room's mouth plays the voice plugin's TTS wav here —
 *  PCM → 48 kHz stereo → 20 ms opus packets → the audio player, out through
 *  the same DAVE-sealed connection that carries the hearing.
 */
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import type { VoiceRoom } from '@aivi/plugin/voice';
import {
  type AudioPlayer,
  type AudioPlayerState,
  AudioPlayerStatus,
  createAudioPlayer,
  createAudioResource,
  EndBehaviorType,
  entersState,
  joinVoiceChannel,
  NoSubscriberBehavior,
  StreamType,
  type VoiceConnection,
  VoiceConnectionStatus,
} from '@discordjs/voice';
import { ChannelType, type Client, type Guild, type Snowflake, type VoiceBasedChannel } from 'discord.js';

const require = createRequire(import.meta.url);
// @discordjs/opus: native libopus (release build), one object that encodes
// AND decodes. Chosen over opusscript the hard way (verified 2026-10-12):
// the WASM port shares ONE linear memory across every instance and builds
// libopus with assertions on, so a single corrupted packet (a DAVE rekey
// artifact mid-stream) aborted the heap — every later opus call in the
// process, hearing AND speaking, died with "memory access out of bounds"
// until a restart. Native: a corrupted packet throws catchably ("data
// passed is corrupted") and the decoder lives. Objects free with GC; there
// is no delete() to remember.
interface NativeOpus {
  encode(buf: Buffer): Buffer;
  decode(buf: Buffer): Buffer;
}
const { OpusEncoder } = require('@discordjs/opus') as {
  OpusEncoder: new (rate: number, channels: number) => NativeOpus;
};

const SR = 16000;
const MIN_UTTERANCE_S = 0.5; // coughs and blips are not utterances

export interface DiscordVoiceConfig {
  guild: string;
  channels: string[];
  silenceMs: number;
}

type VoiceLog = {
  debug(msg: string, f?: Record<string, unknown>): void;
  info(msg: string, f?: Record<string, unknown>): void;
  warn(msg: string, f?: Record<string, unknown>): void;
  error(msg: string, f?: Record<string, unknown>): void;
};

/** The name a speaker carries: the aivi person behind a linked account
 *  first (the operator's link ritual), then Discord's own display name,
 *  then the id. Never a guess from audio — Discord says who this is. */
function speakerName(
  guild: Guild,
  personName: (userId: string) => string | undefined,
  userId: string,
  log: VoiceLog,
): string {
  try {
    const person = personName(userId);
    if (person) return person;
  } catch (error) {
    log.warn('voice.discord.person-failed', { userId, error: String(error) });
  }
  const member = guild.members.cache.get(userId as Snowflake);
  return member?.displayName ?? member?.user?.username ?? userId;
}

export interface VoiceWatcher {
  /** Stop watching, leave every channel, close the meeting in progress. */
  stop(): Promise<void>;
}

export interface VoiceWatchDeps {
  client: Client;
  config: DiscordVoiceConfig;
  /** Birth the room for the next meeting; null when the voice plugin is not
   *  loaded — said once loudly, retried at the next presence, never fatal:
   *  text conversations do not die for a missing optional capability. */
  openRoom: () => VoiceRoom | null;
  personName: (userId: string) => string | undefined;
  log: VoiceLog;
  /** Test seams: the real discordjs join and its ready wait by default. */
  join?: (channelId: string) => VoiceConnection;
  ready?: (connection: VoiceConnection) => Promise<unknown>;
  /** The player state machine needs a live connection; tests fake the play.
   *  It is handed one answer's band and drains it as one resource. */
  play?: (player: AudioPlayer, band: PacketBand) => Promise<void>;
}

/** Watch the configured channels and keep presence and connection in step:
 *  join where a linked person sits, leave where none remains, and close the
 *  whole meeting — room, transcript, engine — when the last person is gone. */
export function watchVoice(deps: VoiceWatchDeps): VoiceWatcher {
  const { client, config, log } = deps;
  const channels = new Set(config.channels);

  const defaultJoin = (channelId: string): VoiceConnection => {
    const guild = client.guilds.cache.get(config.guild as Snowflake);
    if (!guild) throw new Error(`voice: guild ${config.guild} not found for the bot token`);
    return joinVoiceChannel({
      channelId,
      guildId: config.guild,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false, // deaf means no audio delivered
      selfMute: false, // aivi answers out loud: the mouth plays opus here
    });
  };
  const join = deps.join ?? defaultJoin;
  const ready =
    deps.ready ?? ((connection: VoiceConnection) => entersState(connection, VoiceConnectionStatus.Ready, 20_000));

  // A misconfigured id is said once at boot, loudly: presence would otherwise
  // read a typo'd channel as eternally empty and never say anything.
  for (const channelId of channels) {
    const channel = client.channels.cache.get(channelId as Snowflake);
    if (!channel || (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice))
      log.warn('voice.discord.channel-invalid', {
        channelId,
        hint: 'voice: not a voice channel I can see (is the bot in the guild, with Connect permission?)',
      });
  }

  let room: VoiceRoom | null = null;
  let closed = false;
  let notLoadedSaid = false;
  const connections = new Map<string, VoiceConnection>();
  const joining = new Set<string>();

  // The meeting's voice: one audio player per live connection. Each answer
  // is its OWN resource: @discordjs/voice does not queue — when the last
  // packet drains, the player starves (5 missed frames), goes Idle and
  // detaches from the connection; the next answer must play() a fresh
  // resource, which re-attaches it. Writing into one permanently-open stream
  // (the first shape here) left every answer after the first buffering into
  // a player nobody was reading: written, logged, never heard.
  const players = new Map<string, AudioPlayer>();
  let mouthOff: (() => void) | null = null;
  /** The answer currently on the wire: one resource per answer, every wav
   *  joining the same stream. Playing each chunk as its own resource left a
   *  ~113 ms silence at every chunk seam (the player touches Idle between
   *  resources — scheduling the next play costs a few wire ticks), and long
   *  answers stuttered every two seconds. One band, no seams. */
  let band: AnswerBand | null = null;

  /** Hand one wav to the wire. The returned promise settles when THIS wav
   *  is done with: every packet pulled by the player (played), dropped
   *  because a barge killed the answer, or failed. The room keeps the
   *  answer's speaking window open until every chunk's promise settles —
   *  resolving at enqueue was the lie that left aivi talking through every
   *  interruption while `speaking` said nobody was on the air. */
  function speak(wav: Buffer): Promise<boolean> {
    if (connections.size === 0) {
      log.warn('voice.discord.unspoken', {
        hint: 'an answer to speak, but aivi holds no voice connection right now',
      });
      return Promise.resolve(false);
    }
    const packets = wavToOpus(wav, log);
    if (!packets.length) return Promise.resolve(false); // wavToOpus said why
    const seconds = (packets.length * 20) / 1000;
    // A fresh answer opens a fresh band: once the old one was flushed (drained
    // or still draining — the room only speaks again after its promises
    // settled) or killed by a barge (the next answer must get the air).
    if (!band || band.dead || Array.from(band.bands.values(), pb => pb.isFlushed).every(Boolean)) band = openBand();
    const current = band;
    const settled = Promise.all(
      Array.from(
        current.bands.values(),
        pb => new Promise<boolean>(res => (current.dead ? res(false) : pb.add(packets, res))),
      ),
    ).then(played => {
      const ok = played.length > 0 && played.every(Boolean);
      if (ok) log.debug('voice.discord.spoken', { seconds, channels: played.length });
      return ok;
    });
    return settled.catch(error => {
      log.warn('voice.discord.speak-failed', { error: String(error) });
      return false;
    });
  }

  /** The answer is over: close the band so the player drains to Idle. The
   *  next answer plays as a fresh resource (a player that never sees its
   *  stream end detaches and later answers buffer unheard — the first
   *  shape's bug, still dodged). The reference stays until a barge or the
   *  next answer: a barge after the flush must still reach the draining
   *  packets' promises. */
  function flushBand(): void {
    if (!band) return;
    for (const pb of band.bands.values()) pb.flush();
  }

  /** Silence now: the playing answer stops mid-packet, everything queued
   *  with it dies unheard. */
  function stopAllPlayers(): void {
    if (band) {
      for (const pb of band.bands.values()) pb.kill();
      band = null;
    }
    for (const player of players.values()) {
      try {
        player.stop(true);
      } catch {
        /* a player already gone stops with it */
      }
    }
  }

  interface AnswerBand {
    bands: Map<string, PacketBand>;
    dead: boolean;
  }

  function openBand(): AnswerBand {
    const made: AnswerBand = { bands: new Map(), dead: false };
    for (const [channelId, connection] of connections) {
      const pb = new PacketBand();
      pb.onDead = () => {
        made.dead = true;
      };
      made.bands.set(channelId, pb);
      play(playerOf(channelId, connection), pb).catch(error => {
        log.warn('voice.discord.play-failed', { channelId, error: String(error) });
        pb.kill();
      });
    }
    return made;
  }

  function playerOf(channelId: string, connection: VoiceConnection): AudioPlayer {
    let player = players.get(channelId);
    if (!player) {
      player = createAudioPlayer({ behaviors: { noSubscriber: NoSubscriberBehavior.Pause } });
      player.on('error', err => log.warn('voice.discord.player-error', { channelId, error: String(err) }));
      connection.subscribe(player);
      players.set(channelId, player);
    }
    return player;
  }

  /** Play one answer as one resource: Idle first (answers land back to back,
   *  an answer never interrupts one), then Playing until the band is flushed
   *  dry, then Idle again. A barge's stop lands the player at Idle without
   *  ever passing through Playing, so that wait counts Idle as arrived. */
  async function playAnswer(player: AudioPlayer, packets: PacketBand): Promise<void> {
    await waitStates(player, [AudioPlayerStatus.Idle], 60_000);
    if (packets.dead) return;
    const stream = new Readable({
      objectMode: true,
      read() {
        const p = packets.pull(SILENCE_OPUS);
        this.push(p);
      },
    });
    player.play(createAudioResource(stream, { inputType: StreamType.Opus }));
    // Playing or Idle: a barge's stop can land the player back at Idle
    // without ever passing through Playing.
    await waitStates(player, [AudioPlayerStatus.Playing, AudioPlayerStatus.Idle], 10_000);
    await waitStates(player, [AudioPlayerStatus.Idle], 5 * 60_000);
  }

  /** Test seam: the real player state machine needs a live connection. */
  const play = deps.play ?? ((player: AudioPlayer, packets: PacketBand) => playAnswer(player, packets));

  /** The non-bot linked people sitting in that voice channel right now. */
  function listeners(channelId: string): string[] {
    const channel = client.channels.cache.get(channelId as Snowflake) as VoiceBasedChannel | undefined;
    if (!channel?.members) return [];
    const ids: string[] = [];
    for (const [userId, member] of channel.members) {
      if (member.user.bot || !personHasName(userId)) continue;
      ids.push(userId);
    }
    return ids;
  }
  const personHasName = (userId: string) => deps.personName(userId) !== undefined;

  async function joinChannel(channelId: string): Promise<void> {
    if (!room) return; // the meeting closed while this was queued
    joining.add(channelId);
    try {
      const connection = join(channelId);
      connections.set(channelId, connection);
      connection.on('error', err => log.warn('voice.discord.connection-error', { channelId, error: String(err) }));
      connection.on(VoiceConnectionStatus.Disconnected, () => {
        // Discord moves voice servers routinely; rejoining is the supervisor's
        // decision, not a silent loop of ours: say so loudly once.
        log.warn('voice.discord.disconnected', { channelId });
      });
      await ready(connection);
      if (connections.get(channelId) !== connection) return; // already left or replaced
      const guild = client.guilds.cache.get(config.guild as Snowflake);
      if (!guild) throw new Error(`voice: guild ${config.guild} not found for the bot token`);
      hear(connection, guild, config, channelId, room, deps.personName, log);
      log.info('voice.discord.joined', { channelId });
    } catch (error) {
      log.warn('voice.discord.join-failed', { channelId, error: String(error) });
      if (connections.get(channelId)) {
        connections.get(channelId)!.destroy();
        connections.delete(channelId);
      }
    } finally {
      joining.delete(channelId);
    }
  }

  function leave(channelId: string): void {
    players.get(channelId)?.stop(true);
    players.delete(channelId);
    connections.get(channelId)?.destroy();
    connections.delete(channelId);
    log.info('voice.discord.left', { channelId });
  }

  function closeMeeting(): Promise<void> {
    const meeting = room;
    room = null;
    if (mouthOff) {
      mouthOff(); // the meeting's mouth goes with the meeting
      mouthOff = null;
    }
    for (const channelId of [...connections.keys()]) leave(channelId);
    log.info('voice.discord.meeting-closed');
    return meeting?.stop() ?? Promise.resolve();
  }

  let working: Promise<void> = Promise.resolve();
  function reconcile(): void {
    working = working
      .then(reconcileNow)
      .catch(error => log.warn('voice.discord.reconcile-failed', { error: String(error) }));
  }
  async function reconcileNow(): Promise<void> {
    if (closed) return;
    const present = config.channels.filter(channelId => listeners(channelId).length > 0);
    if (present.length === 0) {
      if (room) await closeMeeting();
      return;
    }
    if (!room) {
      const opened = deps.openRoom();
      if (!opened) {
        if (!notLoadedSaid) {
          notLoadedSaid = true;
          log.error('voice.not-loaded', {
            hint: 'a voice block is configured but the voice plugin is not loaded: aivi add @aivi/voice',
          });
        }
        return;
      }
      room = opened;
      mouthOff = room.mouth(wav => speak(wav), stopAllPlayers, flushBand); // aivi's answers get a voice, a way to be silenced, and an end of answer
      log.info('voice.discord.meeting-open');
    }
    for (const channelId of present)
      if (!connections.has(channelId) && !joining.has(channelId)) await joinChannel(channelId);
    for (const channelId of [...connections.keys()]) if (!present.includes(channelId)) leave(channelId);
  }

  const onUpdate = () => reconcile();
  client.on('voiceStateUpdate', onUpdate);
  reconcile(); // a person already sitting in the channel when aivi wakes is present

  return {
    async stop() {
      closed = true;
      client.off('voiceStateUpdate', onUpdate);
      await working;
      await closeMeeting();
    },
  };
}

function hear(
  connection: VoiceConnection,
  guild: Guild,
  config: DiscordVoiceConfig,
  channelId: string,
  room: VoiceRoom,
  personName: (userId: string) => string | undefined,
  log: VoiceLog,
): void {
  const receiver = connection.receiver;
  // One lane per open subscription. While a user's stream is still open the
  // receiver hands out THAT SAME STREAM to a new subscribe call — so a
  // mid-utterance speaking.start (a breath past Discord's VAD timeout) that
  // opened a second lane would hang two lanes off one stream and transcribe
  // the rest of the sentence twice. A breath keeps the lane it has; only a
  // closed stream (the receiver's own 'close') frees the user for a new one.
  const open = new Set<string>();
  receiver.speaking.on('start', (userId: string) => {
    if (open.has(userId)) return;
    // The person's stream goes LIVE: every Opus packet is decoded, resampled
    // and pushed into a lane of their own while they are still speaking, so
    // words come back as they are heard — a linked person's first recognized
    // word is the barge-in (the speaking start is not: it carries no content,
    // which is how a sniffle used to silence whole answers). Bots and
    // strangers are heard but never silence aivi.
    open.add(userId);
    const person = personName(userId) !== undefined;
    const speaker = speakerName(guild, personName, userId, log);
    const lane = room.lane({ speaker, user: userId, person, channel: channelId });
    const startWall = Date.now();
    const stream = receiver.subscribe(userId, {
      end: { behavior: EndBehaviorType.AfterSilence, duration: config.silenceMs },
    });
    // Each data event is one Opus packet (48 kHz, 20 ms); the decoder is
    // stereo so mixed senders are downmixed by us. The 48→16 kHz resample is
    // 3:1 exact, so packets keep their shape streamed. A packet that will
    // not decode is counted, not fatal — and with native opus it truly
    // stays fatal only to that one packet: the decoder survives corruption.
    const decoder = new OpusEncoder(48000, 2);
    let streamed = 0; // 16 kHz samples delivered
    stream.on('error', err => log.warn('voice.discord.stream-error', { userId, error: String(err) }));
    stream.on('data', (packet: Buffer) => {
      try {
        const pcm: Buffer = decoder.decode(packet);
        const i16 = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.length / 2);
        const m = new Int16Array(i16.length / 2);
        for (let i = 0; i < m.length; i++) m[i] = Math.round((i16[2 * i]! + i16[2 * i + 1]!) / 2);
        const f48 = new Float32Array(m.length);
        for (let i = 0; i < m.length; i++) f48[i] = m[i]! / 32768;
        const pcm16 = resample16(f48);
        streamed += pcm16.length;
        lane.push(pcm16);
      } catch (err) {
        log.warn('voice.discord.decode-error', { userId, error: String(err) });
      }
    });
    stream.on('end', () => {
      const dur = streamed / SR;
      const wallSpan = (Date.now() - startWall) / 1000;
      if (dur < MIN_UTTERANCE_S) {
        lane.abort(); // a cough, not an utterance: no line, the live lane closes unheard
        return;
      }
      // Honest accounting against the silent-loss history: delivered audio
      // vs the span the person was heard speaking.
      log.info('voice.discord.utterance', {
        userId,
        channel: channelId,
        delivered: +dur.toFixed(2),
        span: +wallSpan.toFixed(2),
      });
      // The platform's silence rule closed the utterance; the lane flushes
      // its tail and commits the line with what streamed.
      void lane
        .end()
        .then(text => {
          if (!text) log.warn('voice.discord.lost-utterance', { userId, seconds: +dur.toFixed(2) });
        })
        .catch(error => log.warn('voice.discord.heard-failed', { userId, error: String(error) }));
    });
    // The receiver frees the user's subscription at close, not at end: the
    // guard follows the same moment so a new utterance in between can never
    // subscribe onto the dying stream.
    stream.once('close', () => open.delete(userId));
  });
}

/** 48 kHz → 16 kHz: three samples into one (a cheap box average; ASR grade,
 *  and the ratio is exact). */
export function resample16(f48: Float32Array): Float32Array {
  const out = new Float32Array(Math.floor(f48.length / 3));
  for (let i = 0; i < out.length; i++) out[i] = (f48[3 * i]! + f48[3 * i + 1]! + f48[3 * i + 2]!) / 3;
  return out;
}

/** The voice plugin's TTS wav (PCM s16le, any rate, any channel count) into
 *  Discord's currency: 20 ms stereo opus packets at 48 kHz, out of the same
 *  DAVE-sealed connection that carries the hearing. A wav that will not
 *  parse is said, not swallowed. */
export function wavToOpus(wav: Buffer, log: VoiceLog): Buffer[] {
  const parsed = parseWav(wav, log);
  if (!parsed) return [];
  const mono = resample48(parsed.samples, parsed.rate);
  const encoder = new OpusEncoder(48000, 2);
  const FRAME = 960; // 20 ms at 48 kHz
  const stereo = new Int16Array(FRAME * 2);
  const packets: Buffer[] = [];
  try {
    for (let off = 0; off < mono.length; off += FRAME) {
      for (let i = 0; i < FRAME; i++) {
        const s = mono[off + i] ?? 0; // the tail is zero-padded, not dropped
        stereo[2 * i] = s;
        stereo[2 * i + 1] = s;
      }
      // One buffer in, one 20 ms packet out: the buffer length is the frame
      // size (960 samples x 2 channels x 2 bytes), VoIP application default.
      const packet: Buffer = encoder.encode(Buffer.from(stereo.buffer, stereo.byteOffset, stereo.byteLength));
      if (packet && packet.length > 0) packets.push(packet);
    }
    return packets;
  } catch (error) {
    log.warn('voice.discord.encode-failed', { error: String(error) });
    return [];
  }
}

/** Wait for the player to enter one of the given states, with ONE listener
 *  pair and deterministic cleanup. The library's `entersState` attaches its
 *  own listeners per call and a raced-away loser holds them until its
 *  timeout: per-sentence answers stacked error/playing/idle listeners until
 *  Node warned of a leak. One waiter, one pair, always cleaned. */
function waitStates(player: AudioPlayer, states: AudioPlayerStatus[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    if (states.includes(player.state.status)) {
      resolve();
      return;
    }
    const cleanup = () => {
      clearTimeout(timer);
      player.off('stateChange', onState);
      player.off('error', onError);
    };
    const onState = (_old: AudioPlayerState, next: AudioPlayerState) => {
      if (!states.includes(next.status)) return;
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`player did not enter ${states.join('/')} within ${timeoutMs}ms`));
    }, timeoutMs);
    player.on('stateChange', onState);
    player.on('error', onError);
  });
}

/** Discord's own silence: the 3-byte DTX frame. While the synthesizer falls
 *  behind the wire, the player is fed this instead of nothing — a player
 *  that starves (5 missed frames) detaches from its resource and every
 *  packet written afterwards buffers unheard. Silence keeps it on air. */
const SILENCE_OPUS = Buffer.from([0xf8, 0xff, 0xfe]);

/** One answer's packets on one resource. Wavs join while the player is
 *  already playing (no seam between chunks touches the wire); each wav's
 *  promise settles when its last packet left for the player — played — or
 *  immediately false when a barge kills the answer. flush() says the answer
 *  ended: the stream closes after the last packet and the player returns to
 *  Idle, ready for the next answer as a fresh resource. */
export class PacketBand {
  private queue: Buffer[] = [];
  private segments: Array<{ end: number; resolve: (played: boolean) => void }> = [];
  private pushed = 0;
  private consumed = 0;
  private flushed = false;
  dead = false;
  /** Called the first time the answer dies (a barge): the watcher marks the
   *  whole answer dead so wavs arriving after the interrupt never play. */
  onDead: (() => void) | undefined;

  /** One packet for the player's next tick: real audio when the queue has
   *  it, silence while synthesis catches up, null only once flushed (the
   *  player reads that as the resource ending). */
  pull(silence: Buffer): Buffer | null {
    if (this.dead) return null;
    const p = this.queue.shift();
    if (p !== undefined) {
      this.consumed++;
      while (this.segments.length > 0 && this.segments[0]!.end <= this.consumed) {
        this.segments.shift()!.resolve(true);
      }
      return p;
    }
    return this.flushed ? null : silence;
  }

  /** Add one wav's packets: resolve lands when the wire has taken them all. */
  add(packets: Buffer[], resolve: (played: boolean) => void): void {
    if (this.dead) {
      resolve(false);
      return;
    }
    this.queue.push(...packets);
    this.pushed += packets.length;
    this.segments.push({ end: this.pushed, resolve });
  }

  /** The answer is over: the stream ends after the last packet. */
  flush(): void {
    this.flushed = true;
  }

  get isFlushed(): boolean {
    return this.flushed;
  }

  /** True once flushed and drained: a drainer may stop pulling. */
  drained(): boolean {
    return this.dead || (this.flushed && this.queue.length === 0);
  }

  /** Packets still waiting for the wire (a drainer waits, not spins). */
  hasPending(): boolean {
    return this.queue.length > 0;
  }

  /** Barge: everything unheard dies now, the player stops, the resource ends. */
  kill(): void {
    if (this.dead) return;
    this.dead = true;
    this.queue.length = 0;
    const dying = this.segments.splice(0);
    if (dying.length > 0) this.onDead?.();
    for (const s of dying) s.resolve(false);
  }
}

/** Minimal RIFF walk: PCM s16le only, downmixed to mono. TTS wavs are small
 *  and written by us; anything exotic is refused loudly. */
function parseWav(wav: Buffer, log: VoiceLog): { samples: Int16Array; rate: number } | null {
  try {
    if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE')
      throw new Error('not a RIFF/WAVE file');
    let off = 12;
    let rate = 0;
    let channels = 0;
    let bits = 0;
    let format = 0;
    let data: Buffer | null = null;
    while (off + 8 <= wav.length) {
      const id = wav.toString('ascii', off, off + 4);
      const size = wav.readUInt32LE(off + 4);
      const body = off + 8;
      if (id === 'fmt ') {
        format = wav.readUInt16LE(body);
        channels = wav.readUInt16LE(body + 2);
        rate = wav.readUInt32LE(body + 4);
        bits = wav.readUInt16LE(body + 14);
      } else if (id === 'data') {
        data = wav.subarray(body, body + Math.min(size, wav.length - body));
      }
      off = body + size + (size % 2);
    }
    if (format !== 1) throw new Error(`not PCM (format ${format})`);
    if (bits !== 16) throw new Error(`not s16le (got ${bits} bit)`);
    if (!data || !rate || channels < 1) throw new Error('wav lacks fmt+data');
    const n = Math.floor(data.length / 2 / channels);
    const mono = new Int16Array(n);
    for (let i = 0; i < n; i++) {
      let sum = 0;
      for (let c = 0; c < channels; c++) sum += data.readInt16LE(2 * (i * channels + c));
      mono[i] = Math.round(sum / channels);
    }
    return { samples: mono, rate };
  } catch (error) {
    log.warn('voice.discord.wav-unreadable', { error: String(error) });
    return null;
  }
}

/** Linear interpolation to Discord's 48 kHz (24 kHz TTS doubles exactly;
 *  anything else interpolates — playback pitch, not ASR, forgives this). */
function resample48(x: Int16Array, rate: number): Int16Array {
  if (rate === 48000) return x;
  const out = new Int16Array(Math.floor((x.length * 48000) / rate));
  for (let i = 0; i < out.length; i++) {
    const pos = (i * rate) / 48000;
    const i0 = Math.floor(pos);
    const frac = pos - i0;
    const a = x[i0] ?? 0;
    const b = x[i0 + 1] ?? a;
    out[i] = Math.round(a + (b - a) * frac);
  }
  return out;
}

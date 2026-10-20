/**
 * The voice contract: hearing as a capability. The voice plugin provides the
 * one adapter (models, diarizer, person memory, wake, transcripts); modules
 * that stand in a room — discord today, meet/teams/zoom tomorrow — open a
 * `VoiceRoom` and feed it audio. When no adapter was provided, opening a
 * room fails with `VoiceNotLoaded`: the plugin is optional, the failure is
 * honest, and no ordering ceremony hides which module is missing.
 *
 * Who the speakers are is the room's business, not the contract's: a
 * platform that names its speakers (Discord) says so per utterance; a room
 * that only has mixed audio (a browser tab, a meeting bridge) pushes raw
 * PCM and the adapter does ASR, diarization and person identification from
 * the audio alone — when a diarizer is configured. Without one the cuts
 * come from loudness and the lines carry no name: a guessed name would
 * invent people (ruled 2026-10-14).
 */

/** No voice plugin, no hearing. The fix belongs in the message. */
export class VoiceNotLoaded extends Error {
  constructor() {
    super('voice is not loaded: aivi add @aivi/voice');
    this.name = 'VoiceNotLoaded';
  }
}

export interface RoomOptions {
  /** Platform the room is on (`discord`, `meet`): the origin on
   *  everything it produces, never the package that speaks for it. */
  id: string;
  /** What this room is, for the transcript's source line. */
  label: string;
  /** True when the room will push raw mixed audio through `feed` and let
   *  voice do everything — segmentation, speaker separation, person
   *  identification. Rooms whose platform already demuxes named speakers
   *  (Discord, through `lane()`) leave it out: mixed events are another
   *  room's business. */
  streaming?: boolean;
  /** What this room IS: `call` (default — the conversation, not a record:
   *  closed speech prompts aivi, barge-in lives here) or `meeting` (lines
   *  append; the wake phrase activates, nothing else does). The module that
   *  opens the room declares it (ruled 2026-10-13: mode belongs to the
   *  room, not to the voice block; call is the default because the plain
   *  voice system for a normal session is the common case — and loads the
   *  least). */
  mode?: 'call' | 'meeting';
  /** The quiet after which the room's next exchange gets a FRESH OpenCode
   *  session instead of the resumed one (0: fresh every join; false: the
   *  same session forever). Absent: the voice block's `resumeMinutes` —
   *  the global window. A meeting room may want a shorter memory than a
   *  Discord channel (a call is a call: the next one starts clean). */
  resumeMinutes?: number | false;
  /** Dispatcher pool this room's sessions draw capacity from — a name in
   *  `dispatcher.pools`. Absent: the voice block's `pool`. Openers keep
   *  their categories apart this way: meeting rooms on a big local model,
   *  calls on a snappy one, each with its own seats (operator, 2026-10-15:
   *  voice capacity is per category, like LLM endpoints). */
  pool?: string;
  /** The OpenCode agent the room's sessions run as. The opener names it —
   *  a channel's own agent is the natural filling (a Discord room speaks as
   *  the Discord agent unless told otherwise); absent: `assistant`. */
  agent?: string;
}

/** One finished piece of speech. `speaker` is the platform's own answer —
 *  when it has none, leave it out and the adapter identifies from audio. */
export interface Utterance {
  speaker?: string;
  /** Platform user id, kept with the line when the platform has one. */
  user?: string;
  /** Platform channel/room id, kept with the line when it varies per line. */
  channel?: string;
  /** This speaker is a known person of aivi (a linked account), not a bot or
   *  a stranger: only their words may interrupt a live answer (barge-in). */
  person?: boolean;
  /** 16 kHz mono float PCM. */
  pcm: Float32Array;
}

/** A named speaker's LIVE lane: their audio streams in while they speak and
 *  words come back out as they are heard — the platform (Discord) already
 *  demuxes speakers, so the adapter streams ASR without diarizing. One lane
 *  is one utterance. */
export interface VoiceLane {
  /** Live 16 kHz mono float PCM, in real time, as the platform's packets land. */
  push(pcm: Float32Array): void;
  /** The utterance is over (the platform's own silence rule closed it):
   *  flush the tail, then the line is committed with the streamed text —
   *  or, if no live lane ever came up, batch-transcribed from the buffered
   *  audio. Resolves with the text, or null when the utterance was lost. */
  end(): Promise<string | null>;
  /** Throw the utterance away (too short to be speech): no line, the live
   *  lane is closed unheard. */
  abort(): void;
}

/** A handle on one room. Audio goes in; lines, events and aivi's spoken
 *  replies come out. Everything the handle does that needs a model either
 *  works or says so in the log — a lost utterance is a logged loss. */
export interface VoiceRoom {
  /** Streaming room audio: s16le 16 kHz mono chunks, real time, anonymous.
   *  The adapter streams ASR, identifies, scans for the wake phrase and
   *  appends transcript lines. Diarizes only in meeting mode — call mode
   *  reads voice activity off the waveform. Fire-and-forget by nature. */
  feed(pcm: Buffer): void;
  /** Open a live lane for one named speaker's utterance. In a call room the
   *  first recognized WORD from a linked person is the interruption
   *  (barge-in) — not the speaking start, which carries no content. */
  lane(init: { speaker: string; user: string; person?: boolean; channel?: string }): VoiceLane;
  /** A finished utterance a platform already segmented and named (platforms
   *  that get a live stream per speaker use `lane()` instead): transcribe
   *  it, append the line under that speaker. Resolves with the text, or null
   *  when the utterance was lost. */
  heard(utt: Utterance): Promise<string | null>;
  /** Be the room's mouth: called with a wav whenever aivi's answer should be
   *  spoken there (the room's microphone *is* this audio) — once per audio
   *  chunk, in order; a sentence spoken while it synthesizes lands as
   *  several wavs. Return false when nothing played. A mouth that queues
   *  the audio returns a promise that settles when THIS wav is done with —
   *  played, dropped by a barge, or failed: the room holds the answer's
   *  speaking window open until every chunk settles, and interrupting words
   *  are verified against that window. Resolving at enqueue means aivi
   *  talks through the interruption unheard. `stop` (optional) silences the
   *  mouth NOW — barge-in calls it: the playing answer stops mid-sentence,
   *  nothing new starts (and every queued promise settles). `flush`
   *  (optional) says the answer is over — the room calls it once the last
   *  chunk has been handed over (never on the barge path, where `stop`
   *  already closed everything): a mouth playing one continuous stream per
   *  answer ends its stream here so the player drains back to Idle. Returns
   *  the unregister. */
  mouth(play: (wav: Buffer) => boolean | Promise<boolean>, stop?: () => void, flush?: () => void): () => void;
  /** Stop talking and listen (the conversation interrupting): silence the
   *  playing answer and drop the answers still queued to be spoken. The
   *  interrupting speech arrives as speech and is heard like any other —
   *  call rooms put it to the session, which gets to reconsider. Meeting
   *  rooms are polite: this does nothing there. */
  bargeIn(): void;
  /** Watch what the room produces for display: fusion events
   *  (`{ev:"delta"…}`, `{ev:"line"…}`, `{ev:"session_reset"…}`). */
  onEvent(listener: (event: Record<string, unknown>) => void): () => void;
  stop(): Promise<void>;
}

/** What the voice plugin provides at start — exactly one, host-wide. */
export interface VoiceAdapter {
  room(options: RoomOptions): VoiceRoom;
}

/** The service on `AiviServices`: the provider speaks once, every room
 *  holder asks the same question — is there an adapter, and if so open one. */
export interface Voice {
  provide(adapter: VoiceAdapter): () => void;
  room(options: RoomOptions): VoiceRoom;
}

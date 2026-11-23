/** The voice module: the hearing capability aivi provides.
 *
 *  It provides the one adapter the kit's `Voice` seat holds; modules that
 *  stand in a room (discord today, meet/teams/zoom tomorrow) open rooms
 *  through that seat. Without this plugin loaded, that seat throws
 *  `VoiceNotLoaded` — the dependency check is one honest failure, not an
 *  ordering ritual.
 *
 *  A room hears two kinds of speech: mixed PCM through `feed` (the engine
 *  streams ASR, the diarizer follows speakers, the person memory names them
 *  — the fusion produces clean transcript rows), or finished utterances a
 *  platform already named through `heard` (the batch transcriber words
 *  them). From rows, the mode decides: `call` prompts the room's session
 *  with every line (steering the running turn — the interjection);
 *  `meeting` appends in silence until the wake phrase activates the
 *  session. Sessions are normal OpenCode sessions holding real leases from
 *  `dispatcher.pools`, so voice capacity is a pool like any other.
 *
 *  The streaming engine is the module's: born at the host's first audio,
 *  warm across every meeting (a Discord rejoin never reloads models), ended
 *  only when this module stops.
 *
 *  Voice's own room (`room` in config) is for development: a file/mic fed
 *  straight through the engine.
 */
import { createRequire } from 'node:module';
import type { ToolDescriptor } from '@aivi/core';
import { runTurn } from '@aivi/host';
import { type AiviModule, ToolError } from '@aivi/plugin';
import type { VoiceAdapter } from '@aivi/plugin/voice';
import { BatchEngineRun } from './batch.ts';
import type { VoiceConfig } from './config.ts';
import type { AudioSource, EngineSpec } from './engine.ts';
import { HearingRoom, type RoomDeps, type RoomInit } from './room.ts';
import { SharedEngine } from './shared.ts';
import { VoiceStore } from './store.ts';
import { TtsRun } from './tts.ts';
import { VoiceTurns } from './turns.ts';

const require = createRequire(import.meta.url);
const sherpa = require('sherpa-onnx-node');

const transcriptTool: ToolDescriptor = {
  namespace: 'aivi',
  name: 'voice_transcript',
  description:
    'Read back meeting transcripts: the transcript groups, lines of one group (paginated: last N, then older pages via `before`), or the known voices. `speaker` filters lines to one voice name as shown. Call rooms keep no record — their conversation is the session you are in.',
  input: {
    type: 'object',
    required: ['action'],
    additionalProperties: false,
    properties: {
      action: {
        type: 'string',
        enum: ['transcripts', 'lines', 'speakers'],
        description: 'List transcript groups, read lines of one, or list known voices.',
      },
      transcript: {
        type: 'integer',
        description: 'Transcript id (action lines); default: across all groups.',
      },
      last: {
        type: 'integer',
        minimum: 1,
        maximum: 500,
        description: 'How many lines (default 50).',
      },
      before: {
        type: 'integer',
        description: 'Page older lines: pass the smallest line id you have seen (action lines).',
      },
      speaker: {
        type: 'string',
        description: 'Only lines by this speaker name (action lines).',
      },
    },
  },
};

/** Own a speech process from construction, not only after its ready marker.
 *  Shutdown and a late ready answer transfer that ownership exactly once.
 *  A loaded process that died is not kept as a permanent no: like a failed
 *  load, the next request starts a fresh one. */
function lazySpeechEngine<T extends { start(): Promise<void>; stop(): Promise<void>; readonly alive: boolean }>(
  create: () => T,
  failed: (error: unknown) => void,
) {
  let active: T | null = null;
  let ready = false;
  let starting: Promise<T | null> | null = null;
  let stopped = false;
  const take = () => {
    const run = active;
    active = null;
    ready = false;
    return run;
  };
  const load = async (): Promise<T | null> => {
    try {
      const run = create();
      active = run;
      await run.start();
      if (stopped) {
        // stop() already took the process; readiness cannot return it to a caller.
        return null;
      }
      if (!run.alive) {
        // Ready and gone in one breath: the client said it exited, and a
        // dead process is nothing to hand out.
        take();
        return null;
      }
      ready = true;
      return run;
    } catch (error) {
      await take()?.stop();
      if (!stopped) failed(error);
      return null;
    }
  };
  return {
    get(): Promise<T | null> {
      if (stopped) return Promise.resolve(null);
      const loaded = ready ? active : null;
      if (loaded?.alive) return Promise.resolve(loaded);
      if (loaded) take(); // it died after loading: this request loads its replacement
      starting ??= load().finally(() => {
        starting = null;
      });
      return starting;
    },
    async stop(): Promise<void> {
      stopped = true;
      await take()?.stop();
    },
  };
}

export function createVoiceModule(
  config: VoiceConfig,
  createRoom: (init: RoomInit, deps: RoomDeps) => HearingRoom = (init, deps) => new HearingRoom(init, deps),
): AiviModule {
  return {
    id: 'voice',
    async start(services) {
      const log = services.log.getChild('voice');
      const store = new VoiceStore(services.store, log);
      // Leases voice held across a restart are unverified: their turns died
      // with the process, so the slots go straight back (a voice turn has no
      // ticket to block, unlike a channel turn).
      await VoiceTurns.recover(
        store.roomLeases(),
        id => services.dispatcher.release(id),
        label => store.setRoomLease(label, null),
        log,
      );

      const embedder = config.identity
        ? new sherpa.SpeakerEmbeddingExtractor({
            model: config.identity.model,
            numThreads: 2,
            provider: 'cpu',
          })
        : null;

      services.tools.claim(transcriptTool, async call => {
        const input = call.input as {
          action?: string;
          last?: number;
          speaker?: string;
          transcript?: number;
          before?: number;
        };
        if (input.action === 'transcripts') return { transcripts: store.transcripts(input.last ?? 20) };
        if (input.action === 'speakers') return { speakers: store.speakers() };
        if (input.action === 'lines') {
          return {
            lines: store.readLines({
              ...(input.transcript !== undefined ? { transcript: input.transcript } : {}),
              ...(input.speaker ? { speaker: input.speaker } : {}),
              ...(input.before !== undefined ? { before: input.before } : {}),
              last: input.last ?? 50,
            }),
          };
        }
        throw new ToolError(400, "action must be 'transcripts', 'lines' or 'speakers'");
      });

      // The module's one streaming engine: born at the host's first audio
      // (push or batch, from any room), warm across meetings, ended only by
      // the module stop below. Rooms never own it — walking out of a Discord
      // channel closes the meeting, not the models. The diarizer question is
      // answered ONCE by configuration (`asr.diarModel`), never per room:
      // the engine loads it at startup or announces it has none, and
      // nameless lines are the honest fallback (ruled 2026-10-14).
      const engineSpec: EngineSpec = { ...config.asr };
      const sharedEngine = new SharedEngine(engineSpec, log);

      // Shared lazily: a SEPARATE batch endpoint costs a model load only
      // once a room actually asks. Absent the `stt` block there is no
      // second process at all: the streaming engine answers batch requests
      // in its own process (one engine per host, one set of weights).
      const stt = config.stt
        ? lazySpeechEngine(
            () => new BatchEngineRun(config.stt!, log),
            error => log.warn('voice.stt.start-failed', { error: String(error) }),
          )
        : null;
      const tts = config.tts
        ? lazySpeechEngine(
            () => new TtsRun(config.tts!, log),
            error => log.warn('voice.tts.start-failed', { error: String(error) }),
          )
        : null;

      // The dispatcher's callback namespace, filled once for all rooms: a
      // queue place carries the room it belongs to, and every voice release
      // fans out a retry (a `waiting` refusal holds no dispatcher place of
      // its own — the freed slot of the room that did is its wake-up).
      const seats = new Map<string, VoiceTurns>();
      services.dispatcher.registerCallback('voice', (requestId, lease) => {
        const turns = seats.get(requestId);
        seats.delete(requestId);
        if (turns) turns.fulfill(lease);
        else
          void services.dispatcher
            .release(lease.id)
            .then(r => 'pending' in r && log.warn('turns.lease.pending-kill', { lease: lease.id }))
            .catch(error => log.warn('turns.lease.lost', { error: String(error) }));
      });

      // One adapter serves every room; rooms are tracked so module stop
      // catches each one even if a consumer forgets its own stop. What a
      // room IS (call/meeting) and who it speaks as (agent) comes in with
      // the opener (RoomOptions) — the voice block says neither (ruled
      // 2026-10-13).
      const rooms = new Set<HearingRoom>();
      const baseDeps: Omit<RoomDeps, 'mode' | 'agent'> = {
        wakePhrases: config.wake.phrases,
        engineSpec,
        directory: config.directory,
        model: config.model,
        pool: config.pool,
        resumeMinutes: config.resumeMinutes,
        identity: config.identity,
        embedder,
        store,
        sharedEngine,
        getStt: () => stt?.get() ?? Promise.resolve(null),
        getTts: () => tts?.get() ?? Promise.resolve(null),
        dispatcher: services.dispatcher,
        opencode: services.opencode,
        runTurn: (client, input, options) => runTurn(client, input as never, options as never),
        requestSeat: (requestId, turns) => seats.set(requestId, turns),
        releaseSeat: requestId => {
          seats.delete(requestId);
        },
        capacityMoved: () => {
          for (const room of rooms) room.retryTurns();
          services.wake(); // the scheduler and the channels move with the capacity too
        },
        servicesSignal: services.signal,
        events: services.events,
        log,
      };
      const adapter: VoiceAdapter = {
        room(options) {
          const mode = options.mode ?? 'call';
          // `resumeMinutes` and `pool` are deps, not init: a room may carry
          // its own window and its own capacity, absent means the voice
          // block's (2026-10-14: a Meet is not a Discord channel — the next
          // call deserves a clean start; 2026-10-15: and a meeting category
          // may sit on its own pool)
          const { resumeMinutes, pool, ...init } = options;
          const room = createRoom(
            { ...init, engineInput: { type: 'push' } as AudioSource },
            {
              ...baseDeps,
              mode,
              resumeMinutes: resumeMinutes ?? config.resumeMinutes,
              pool: pool ?? config.pool,
              agent: options.agent ?? 'assistant',
            },
          );
          rooms.add(room);
          return room;
        },
      };
      const unprovide = services.voice.provide(adapter);

      // Voice's own room (development lanes): a file/mic fed straight
      // through its own engine process, declaring its kind like any room.
      let own: HearingRoom | null = null;
      if (config.room) {
        own = createRoom(
          {
            id: 'voice',
            label: config.room.type === 'file' ? config.room.path : `mic:${config.room.device ?? 'default'}`,
            streaming: true,
            engineInput: config.room,
          },
          {
            ...baseDeps,
            mode: config.room.mode,
            agent: 'assistant',
            // Own process, same rule: the diarizer follows the config.
            engineSpec,
          },
        );
        rooms.add(own); // stop catches it like any other room
      }

      return {
        async stop() {
          services.tools.release('aivi_voice_transcript');
          unprovide(); // the seat goes empty first: new rooms cannot be born
          for (const room of rooms) await room.stop(); // running turns finish and release leases
          await sharedEngine.stop(); // the host's engine ends only with the host's voice
          await stt?.stop();
          await tts?.stop();
        },
      };
    },
  };
}

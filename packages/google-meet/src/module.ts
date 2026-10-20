/** The Meet module as `aivi serve` runs it: the meeting lives HERE, because
 *  the voice brain — ASR, diarizer, wake, sessions, TTS, pools — lives in
 *  serve's seat. The module claims two operations and holds one meeting:
 *
 *  - `meet.join` {url}: open a face tab (camera, mic and ears installed by
 *    core), click through Meet's screens, open the room's voice handle, and
 *    wire both directions — heard audio feeds the room, the room's mouth
 *    plays out of the page's microphone. The run succeeds once aivi is in
 *    the call; the meeting itself keeps running, like a Discord connection
 *    outliving its turns.
 *  - `meet.leave`: hang up.
 *
 *  One meeting at a time, said by name. The record (`<state>/meet.json`)
 *  says who holds it; `aivi meet status` reads it from any terminal. */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { ExecutionResult } from '@aivi/core';
import { errorMessage, type FaceTab, openFaceTab, type Run } from '@aivi/core';
import type { AiviModule } from '@aivi/plugin';
import type { VoiceRoom } from '@aivi/plugin/voice';
import type { MeetConfig } from './config.ts';
import { driveJoin, driveLeave } from './meeting.ts';

interface Meeting {
  faceTab: FaceTab;
  room: VoiceRoom;
  url: string;
}

const argsOf = (run: Run): Record<string, unknown> =>
  run.task.kind === 'invocation' ? ((run.task.args as Record<string, unknown> | undefined) ?? {}) : {};

export function createMeetModule(config: MeetConfig): AiviModule {
  return {
    id: 'google-meet',
    async start(services) {
      const log = services.log.getChild('google-meet');
      const home = dirname(services.loaded.path);
      const stateDir = services.loaded.config.stateDirectory;
      const record = join(stateDir, 'meet.json');
      let meeting: Meeting | null = null;
      // after hangup the voice room may still hand queued answers to the
      // mouth for a beat; they must say false at once, not hammer a closed
      // connection every 400 ms (the operator's log, 2026-10-14)
      let dead = false;

      const writeRecord = async (phase: 'joining' | 'in-call', url: string): Promise<void> => {
        await mkdir(stateDir, { recursive: true });
        await writeFile(
          record,
          `${JSON.stringify({ pid: process.pid, url, phase, since: new Date().toISOString() })}\n`,
        );
      };

      const endMeeting = async (): Promise<void> => {
        const current = meeting;
        meeting = null;
        if (current === null) return;
        dead = true;
        // Hang up like a person BEFORE closing the tab: without the click
        // the other side stares at a frozen tile until Meet's media times
        // out (operator, 2026-10-14). A browser that died already throws
        // here; the closes follow regardless.
        await driveLeave(current.faceTab.tab, (msg, extra) => log.info(msg, extra)).catch(() => {});
        await current.room.stop().catch(error => log.warn('meet.room-stop-failed', { error: String(error) }));
        await current.faceTab.close().catch(error => log.warn('meet.tab-close-failed', { error: String(error) }));
        await rm(record, { force: true });
        log.info('meet.left', { url: current.url });
      };

      const handleJoin = async (run: Run): Promise<ExecutionResult> => {
        const { url } = argsOf(run);
        if (typeof url !== 'string' || !/^https?:\/\//.test(url))
          return {
            state: 'failed',
            result: null,
            reason: 'meet.join needs args {url: "https://meet.google.com/…"}',
          };
        if (meeting !== null)
          return {
            state: 'failed',
            result: null,
            reason: `already in a call: ${meeting.url} — meet.leave first`,
          };
        let faceTab: FaceTab | null = null;
        let room: VoiceRoom | null = null;
        try {
          dead = false;
          await writeRecord('joining', url);
          // headless by default (ruled 2026-10-14: the visible window is
          // the DEBUG look, `headless: false` in the block); Meet refused
          // and accepted the headless browser on different hours of the
          // same day, so the window stays one config line away.
          faceTab = await openFaceTab({
            home,
            stateDir,
            url,
            hear: true,
            headless: config.headless,
          });
          // The room goes silent NOW, not at admission: every media
          // element the page plays from here on is pinned to volume 0 the
          // moment it plays (the join chime reached the operator's room
          // because the mute only started after the join, 2026-10-14).
          // Ears stay shut until the call is real.
          await faceTab.setTap(false, true);
          // A browser that dies mid-call (crash, or a hand at the Activity
          // Monitor) ends the meeting at once: `dead` flips synchronously
          // inside endMeeting, so the mouth stops knocking and the record
          // goes honest. Without this the module kept a phantom call and
          // logged CdpErrors for a meeting that no longer existed.
          faceTab.onGone(() => {
            if (meeting === null) return; // the join's own catch handles a mid-join death
            log.warn('meet.browser-died', {
              url,
              hint: 'the meeting is over: state cleared, nothing to leave',
            });
            void endMeeting();
          });
          // The voice plugin is resolved at join, never at start: it is
          // optional, and its absence is one honest failure of THIS run.
          room = services.voice.room({
            id: 'meet',
            label: url,
            streaming: true,
            mode: config.mode,
            ...(config.resumeMinutes !== undefined ? { resumeMinutes: config.resumeMinutes } : {}),
            ...(config.pool !== undefined ? { pool: config.pool } : {}),
            // Everyone in a Meet arrives on ONE mixed stream — the speaker
            // is a fact of the audio, not of the platform: the diarizer
            // (when configured) separates voices and the host binds each
            // slot to a person once, so lines can be named (operator,
            // 2026-10-14: aivi must know who to address, and dreaming
            // needs the attribution on the entry).
            agent: config.agent,
          });
          const joined = await driveJoin(faceTab.tab, {
            name: config.name,
            log: (msg, extra) => log.info(msg, extra),
            joinTimeoutMs: config.joinTimeoutMs,
            askTimeoutMs: config.askTimeoutMs,
          });
          // Ears: what the page plays out loud is the room's mixed audio —
          // and the page's speakers go silent, the operator's room is not
          // the meeting's loudspeaker. The chunk counter is the deafness
          // probe (2026-10-14): `meet.first-audio` proves the tap flows;
          // its absence localizes the fault to the page side, which no
          // amount of code reading could settle.
          let heard = 0;
          faceTab.onAudio(pcm => {
            if (dead) return;
            heard++;
            if (heard === 1)
              log.info('meet.first-audio', {
                bytes: pcm.length,
                hint: 'the tap is flowing',
              });
            else if (heard % 240 === 0) log.info('meet.audio-flow', { chunks: heard });
            room!.feed(pcm);
          });
          // What the face wears right now for the MEETING side: turn
          // states (`thinking`, `tool`) may not stamp on a mouth that is
          // still playing — TTS streams chunk by chunk, so the face says
          // `speaking` from the first chunk's start until the LAST
          // chunk's audio leaves the page (per-chunk flip-flop was the
          // out-of-sync animation the operator saw, 2026-10-14).
          let playing = 0;
          let worn = '';
          const wear = (state: string): void => {
            if (state === worn) return; // words arrive per chunk: one call per CHANGE, not per word
            worn = state;
            void faceTab!.setFaceState(state).catch(() => {});
          };
          room.onEvent(event => {
            if (event.ev === 'delta') {
              // the first word in: a person is talking NOW, so the face
              // listens (the old trigger was `line` — the utterance ALREADY
              // closed, so listening showed after the person was done and
              // read as no listening face at all; the operator's Discord
              // memory was right, the meet wiring had drifted). Aivi's own
              // voice never arrives as deltas: the page's speakers are
              // pinned silent.
              if (playing === 0) wear('listening');
            }
            // the ASR engine's lifecycle, in the meet log: loading/ready/
            // failed tells a deaf room whether the models were ever there
            else if (event.ev === 'engine') log.info('meet.engine-state', { state: event.state });
            else if (event.ev === 'turn' && playing === 0) {
              // the resting face is idle: listening means "words are
              // arriving", not "nothing happens to be arriving"
              const state = event.state;
              if (state === 'thinking' || state === 'tool') wear(state);
              else if (state === 'idle') wear('idle');
            }
          });
          // Mouth: a room answer plays out of the page's microphone; the
          // promise settles when the wav is done with — played, or cut by a
          // barge — which is exactly the contract the room holds its
          // speaking window open for.
          room.mouth(
            async wav => {
              if (dead) return false; // hung up mid-thought: said, not retried
              if (playing === 0) wear('speaking');
              playing++;
              let played = false;
              try {
                if (!dead) played = await faceTab!.speak(wav);
              } finally {
                playing--;
                if (playing === 0 && !dead) wear('idle'); // the answer is spoken: rest, and wait for words
              }
              return played;
            },
            () => {
              if (dead) return;
              void faceTab!.stopSpeaking().catch(() => {});
            },
            () => {
              // one voice stream, played on one page-side timeline: there is
              // no seam to close — each wav's promise IS the answer's end
            },
          );
          meeting = { faceTab, room, url };
          // The ears open only now: nothing heard before it can be answered.
          await faceTab.setTap(true);
          log.info('meet.ears-open', {
            url,
            hint: 'the page plays what aivi hears; its speakers are pinned silent so the room stays quiet',
          });
          await writeRecord('in-call', url);
          log.info('meet.in-call', {
            url,
            viaWaitingRoom: joined.viaWaitingRoom,
          });
          return {
            state: 'succeeded',
            result: { url, viaWaitingRoom: joined.viaWaitingRoom },
          };
        } catch (error) {
          const reason = errorMessage(error);
          log.warn('meet.join-failed', { url, error: reason });
          await room?.stop().catch(() => {});
          await faceTab?.close().catch(() => {});
          await rm(record, { force: true });
          return { state: 'failed', result: null, reason };
        }
      };

      services.tasks.claim('meet.join', async run => handleJoin(run));
      services.tasks.claim('meet.leave', async (): Promise<ExecutionResult> => {
        if (meeting === null) return { state: 'succeeded', result: { left: false } };
        const url = meeting.url;
        await endMeeting();
        return { state: 'succeeded', result: { left: true, url } };
      });

      return {
        async stop() {
          services.tasks.release('meet.join');
          services.tasks.release('meet.leave');
          await endMeeting(); // the meeting does not outlive the host
        },
      };
    },
  };
}

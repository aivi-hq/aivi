/** Named live lanes: one named speaker's streaming utterance. Discord demuxes
 *  speakers, so each lane is a bare diarizer-less session in the shared
 *  engine — the lane IS the speaker. Lane-tagged engine events route here and
 *  never touch the mixed fusion; the first recognized word of a linked
 *  person's lane is the barge-in. The audio is buffered as it arrives (the
 *  batch fallback) and, once the engine joins, streamed live from the top.
 */
import type { Logger } from '@aivi/core';
import type { VoiceLane } from '@aivi/plugin/voice';
import type { EngineEvent, EngineRun } from './engine.ts';
import type { SharedEngine } from './shared.ts';
import { scanWake } from './wake.ts';

/** One named speaker's live utterance, from `lane()` to `end()`/`abort()`. */
interface LaneState {
  id: string;
  speaker: string;
  user: string;
  person: boolean;
  /** Platform channel kept with the line, as `heard` carries it. */
  channel?: string;
  /** Wall clock at open: the line's t0. */
  openedAt: number;
  text: string;
  pcm: Float32Array[];
  pcmLen: number;
  /** The engine holding this lane's live session, once it joined. */
  run: EngineRun | null;
  open: boolean;
  /** The engine said lane_end: the tail deltas are all in. */
  gotEnd: boolean;
  ended: boolean;
  /** Set while `end()` waits for the lane_end event. */
  endWait: (() => void) | null;
}

function concatPcm(chunks: Float32Array[]): Float32Array {
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Float32Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

export interface LanesDeps {
  mode: 'call' | 'meeting';
  wakePhrases: string[];
  label: string;
  log: Logger;
  /** The module's one streaming engine; lanes are sessions inside it. */
  sharedEngine: SharedEngine;
  /** Transcribe one finished stretch (engine first, then `stt` endpoint). */
  transcribe(pcm: Float32Array): Promise<string | null>;
  /** Aivi is producing speech: a lane word now is the interruption. */
  speaking(): boolean;
  /** Stop talking and listen (the room checks mode and life). */
  barge(): void;
  /** The room is closing: lanes do nothing more. */
  stopped(): boolean;
  /** The finished utterance, committed per mode (the room's commit). */
  commit(
    t0: number,
    t1: number,
    speaker: string,
    text: string,
    opts: { wake: string | null; user?: string; person?: boolean; channel?: string },
  ): void;
}

export class LaneBook {
  private readonly deps: LanesDeps;
  private lanes = new Map<string, LaneState>();
  private seq = 0;

  constructor(deps: LanesDeps) {
    this.deps = deps;
  }

  /** One named speaker's live utterance: their platform-demuxed audio
   *  streams into a bare Voxtral session of the shared engine (no diarizer —
   *  the lane IS the speaker), words come back as they are heard, and the
   *  first recognized word from a linked person is the barge-in. The
   *  platform's own silence rule closes the utterance with `end()`. */
  lane(init: { speaker: string; user: string; person?: boolean; channel?: string }): VoiceLane {
    const id = `${this.deps.label}/${++this.seq}`;
    const lane: LaneState = {
      id,
      speaker: init.speaker,
      user: init.user,
      person: init.person === true,
      ...(init.channel !== undefined ? { channel: init.channel } : {}),
      openedAt: Date.now() / 1000,
      text: '',
      pcm: [],
      pcmLen: 0,
      run: null,
      open: false,
      gotEnd: false,
      ended: false,
      endWait: null,
    };
    this.lanes.set(id, lane);
    void this.deps.sharedEngine.ready().then(run => {
      // The engine may have been loading when the person started: join the
      // live lane from the top with the audio buffered so far, live from
      // here on. A lane that already closed needs no engine at all.
      if (!run || lane.ended || lane.open || this.deps.stopped()) return;
      lane.run = run;
      lane.open = true;
      for (const buf of lane.pcm) run.writeLane(id, buf);
    });
    return {
      push: (pcm: Float32Array) => {
        if (lane.ended || this.deps.stopped()) return;
        lane.pcm.push(pcm);
        lane.pcmLen += pcm.length;
        if (lane.open) lane.run!.writeLane(id, pcm);
      },
      abort: () => {
        lane.ended = true;
        this.lanes.delete(id);
        if (lane.open) lane.run!.endLane(id); // the engine flushes; nobody's listening anymore
      },
      end: async () => {
        if (lane.ended || this.deps.stopped()) return null;
        const live = lane.open;
        if (live) {
          lane.run!.endLane(id); // tail first: the last words, then lane_end
          await new Promise<void>(res => {
            lane.endWait = res;
          });
          lane.endWait = null;
        }
        lane.ended = true;
        this.lanes.delete(id);
        let text = lane.text.trim();
        if (!text) {
          // The live lane never said a word (cold engine, dead engine):
          // batch-transcribe the buffered audio — same weights, just not
          // in a hurry. Nothing back is a lost utterance, loudly logged.
          text = ((await this.deps.transcribe(concatPcm(lane.pcm))) ?? '').trim();
          if (!text) {
            this.deps.log.warn('voice.lane.lost', { room: this.deps.label, speaker: lane.speaker });
            return null;
          }
        } else if (live && !lane.gotEnd) {
          this.deps.log.warn('voice.lane.partial', {
            room: this.deps.label,
            speaker: lane.speaker,
            hint: 'the engine died before the tail: the line is what streamed so far',
          });
        }
        const t1 = Date.now() / 1000;
        const wake = this.deps.mode === 'meeting' ? scanWake(text, this.deps.wakePhrases) : null;
        this.deps.commit(lane.openedAt, t1, lane.speaker, text, {
          wake,
          user: lane.user,
          person: lane.person,
          ...(lane.channel !== undefined ? { channel: lane.channel } : {}),
        });
        return text;
      },
    };
  }

  /** An engine event: true when it was lane-tagged (consumed — it belongs to
   *  the room that opened the lane and to no one else, even when this book
   *  no longer holds the lane). */
  event(e: EngineEvent): boolean {
    const laneId = 'lane' in e ? (e as { lane?: string }).lane : undefined;
    if (typeof laneId !== 'string') return false;
    const lane = this.lanes.get(laneId);
    if (lane) this.onLaneEvent(lane, e);
    return true;
  }

  private onLaneEvent(lane: LaneState, e: EngineEvent): void {
    if (e.ev === 'delta') {
      if (lane.text === '') {
        // The number barge-in speed lives and dies by: wall latency from the
        // person's first pushed packet to the first recognized word. Live
        // proof for the logs without reading event timestamps off a page.
        this.deps.log.debug('voice.lane.firstword', {
          room: this.deps.label,
          speaker: lane.speaker,
          ms: Math.round(Date.now() / 1000 - lane.openedAt),
          hint: 'words this late into the utterance; a barge can only be this fast',
        });
      }
      lane.text += e.text;
      // A recognized word from a LINKED person while aivi speaks is the
      // interruption — the whole point of the live lane: barge-in verified
      // on the first word, not on a speaking start or a finished clip.
      if (this.deps.mode === 'call' && lane.person && this.deps.speaking()) this.deps.barge();
    } else if (e.ev === 'lane_end') {
      lane.gotEnd = true;
      lane.endWait?.();
    }
    // session_reset on a lane: the engine restarted that speaker's context
    // mid-utterance; the text keeps accumulating. Nothing for the room to do.
  }

  /** An engine died answers no tails: every lane waiting on one is settled
   *  with what it has (end() calls it partial, not silent). */
  engineDied(): void {
    for (const lane of this.lanes.values()) {
      lane.open = false;
      if (lane.endWait) {
        const res = lane.endWait;
        lane.endWait = null;
        res();
      }
    }
  }

  /** Live lanes close with the room: the engine lane is told, whoever waits
   *  on a tail is settled (their end() returns what streamed). */
  closeAll(): void {
    for (const lane of this.lanes.values()) {
      if (lane.open) lane.run?.endLane(lane.id);
      if (lane.endWait) {
        const res = lane.endWait;
        lane.endWait = null;
        res();
      }
    }
    this.lanes.clear();
  }
}

/** Mixed audio into lines: what the streaming engine says over one anonymous
 *  stream (deltas, act changes, eof) becomes clean transcript rows.
 *
 *  Two systems name a voice, and each does one job (ruled 2026-10-14):
 *  the **diarizer** (in the engine) cuts the stream and labels each stretch
 *  with a slot — slot 3 for the whole meeting, whatever it says; the
 *  **speaker-id** model (the room's `identify`) turns one slot into a
 *  person, ONCE, from the clean middle of that slot's longest stretch —
 *  padding on both sides so no neighbor's audio can poison the voice hash.
 *  The binding lives for the meeting; the person id lives in the database
 *  across meetings.
 *
 *  Without the diarizer (the engine says so in its first `diar` event)
 *  cuts come from loudness alone and a stretch may blend two voices — so
 *  naming it would invent people, and mixed lines carry NO speaker. A
 *  wake hit still cuts the addressed sentence out of the line it was said
 *  in. The room owns one and routes here every engine event that is not
 *  lane-tagged.
 */
import type { Logger } from '@aivi/core';
import type { EngineEvent } from './engine.ts';
import { scanWake } from './wake.ts';

/** A line shorter than this was a breath, not a turn. */
const MIN_LINE_S = 0.2;
/** A slot's stretch must run this long before its middle is hashed for a
 *  person: shorter, and the sample is thin enough to mint fake people. */
const MIN_BIND_S = 2.0;

export interface FusionDeps {
  mode: 'call' | 'meeting';
  wakePhrases: string[];
  label: string;
  log: Logger;
  /** The room's event fan-out: delta/session_reset captions ride it. */
  emit(event: Record<string, unknown>): void;
  /** Aivi is producing speech: words recognized now are the interruption. */
  speaking(): boolean;
  /** Stop talking and listen (call rooms; meeting rooms are checked by the room). */
  barge(): void;
  /** Name the voice in this stretch of the stream, or null when the
   *  speaker-id model has nothing to say. */
  identify(t0: number, t1: number): string | null;
  /** The closed line, acted on per mode (the room's commit). `speaker` is
   *  empty when the voice is not (or cannot be) named. */
  commit(t0: number, t1: number, speaker: string, text: string, wake: string | null): void;
}

export class MixedFusion {
  // The open line: what the streaming engine has said since the last act change.
  private slot = -1;
  private lineStart = 0;
  private lineText = '';
  private wakePhrase: string | null = null;
  private lastPos = 0;
  // The diarizer's truth, from the engine's first `diar` event: without it
  // there are no slots, only "someone / quiet", and no names.
  private diarOn = false;
  // slot -> person, bound once per meeting from clean audio (the diarizer's
  // slots die with the stream; the person ids came from the database).
  private readonly names = new Map<number, string>();
  // slot -> its longest stretch so far [from, to), for the one good hash.
  private readonly longest = new Map<number, [number, number]>();
  private slotStart = 0;

  private readonly deps: FusionDeps;

  constructor(deps: FusionDeps) {
    this.deps = deps;
  }

  /** One mixed-audio engine event; lane-tagged events never reach here — the
   *  room routes those to the lanes. */
  event(e: EngineEvent): void {
    if (e.ev === 'diar') {
      this.diarOn = e.on;
      return;
    }
    if (e.ev === 'delta' || e.ev === 'session_reset') this.deps.emit(e as unknown as Record<string, unknown>);
    if (e.ev === 'delta') {
      // A word recognized while aivi is speaking IS the interruption: it
      // falls silent and listens. A bare act (someone started, no words yet)
      // does not — that is how a sniffle used to silence a whole answer for
      // nothing. The words still land as a line and the session reconsiders.
      if (this.deps.mode === 'call' && this.deps.speaking()) this.deps.barge();
      this.lastPos = e.pos;
      this.lineText += e.text;
      if (this.deps.mode === 'meeting' && !this.wakePhrase) {
        const hit = scanWake(this.lineText, this.deps.wakePhrases);
        if (hit) {
          this.wakePhrase = hit;
          this.closeLine(e.pos, true); // the addressed sentence, cut where it was said
        }
      }
    } else if (e.ev === 'act') {
      if (e.slot === this.slot) return;
      // A LATE LABEL: the diarizer decides about a second behind the audio.
      // When the backstop closed the line and a slot now opens whose start
      // lies inside the pending buffer, those buffered words ARE the turn
      // this label describes — adopt them, do not commit them nameless and
      // start the turn's text over behind the label.
      if (this.slot === -1 && e.slot >= 0 && this.lineText.trim() && e.t <= this.lastPos) {
        this.slot = e.slot;
        this.slotStart = e.t;
        return; // the line stays open; its name arrives when it ends
      }
      // The slot that just finished speaking: keep its longest stretch for
      // the one good hash, and bind it to a person before the line it owns
      // closes — so the first line it spoke can already carry its name.
      if (this.slot >= 0) {
        this.noteStretch(this.slot, this.slotStart, e.t);
        this.bind(this.slot);
      }
      // Close pending text even when the slot is already -1 (a wake cut
      // closed the addressed sentence mid-utterance; what the speaker said
      // after it belongs to a line of its own).
      if (this.slot >= 0 || this.lineText.trim()) this.closeLine(e.t, false);
      // The diarizer says who speaks NOW: the slot changes here, nowhere
      // else. A wake cut is not a speaker change — it keeps its slot so
      // the rest of the addressed utterance stays named.
      this.slot = e.slot;
      if (e.slot >= 0) {
        this.lineStart = e.t;
        this.slotStart = e.t;
      }
    } else if (e.ev === 'eof') {
      if (this.slot >= 0 || this.lineText.trim()) this.closeLine(this.lastPos || this.lineStart, false);
      this.deps.log.info('voice.engine.eof', { room: this.deps.label });
    }
  }

  /** The longest stretch is the one hashed: a slot's brief overlap at a
   *  turn's edge can sit inside a shorter one with the neighbor's audio. */
  private noteStretch(slot: number, from: number, to: number): void {
    if (!this.diarOn || this.names.has(slot)) return;
    const held = this.longest.get(slot);
    if (held === undefined || to - from > held[1] - held[0]) this.longest.set(slot, [from, to]);
  }

  /** slot -> person, once. The middle half of the longest stretch: the
   *  padding is what keeps a neighbor's voice out of the hash. */
  private bind(slot: number): void {
    if (!this.diarOn || this.names.has(slot)) return;
    const held = this.longest.get(slot);
    if (held === undefined || held[1] - held[0] < MIN_BIND_S) return;
    const pad = (held[1] - held[0]) / 4;
    const name = this.deps.identify(held[0] + pad, held[1] - pad);
    if (name === null) return; // the speaker-id model had nothing to say: try again at the next stretch
    this.names.set(slot, name);
    this.deps.log.info('voice.slot-bound', { room: this.deps.label, slot, name });
  }

  private closeLine(t1: number, viaWake: boolean): void {
    const t0 = this.lineStart;
    // Voxtral's realtime stream sprinkles newlines mid-sentence: the
    // transcript line is one clean row, whitespace collapsed at the source.
    const text = this.lineText.replace(/\s+/g, ' ').trim();
    const speaker = (this.diarOn && this.slot >= 0 && this.names.get(this.slot)) || '';
    // A late act must not cut a line before its words' true end: the label
    // carries the audio's time, the buffer holds words that streamed in
    // after that moment. The line ends at the later of the two.
    const end = Math.max(t1, this.lastPos);
    this.lineStart = end; // the line moves on; the SPEAKER does not (that is the act's word)
    this.lineText = '';
    const wake = this.wakePhrase;
    this.wakePhrase = null;
    if (!text || end - t0 < MIN_LINE_S) return;
    this.deps.commit(t0, end, speaker, text, viaWake ? wake : null);
  }
}

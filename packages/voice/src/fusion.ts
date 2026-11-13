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
    switch (e.ev) {
      case 'diar':
        this.diarOn = e.on;
        return;
      case 'delta':
        this.deps.emit(e as unknown as Record<string, unknown>);
        this.delta(e);
        return;
      case 'session_reset':
        this.deps.emit(e as unknown as Record<string, unknown>);
        return;
      case 'act':
        this.activity(e);
        return;
      case 'eof':
        this.finish();
        return;
      case 'lane_end':
        return; // the room routes named lanes elsewhere
    }
  }

  private delta(e: Extract<EngineEvent, { ev: 'delta' }>): void {
    // Words, not a bare act or formatting token, are the interruption.
    const word = /[\p{L}\p{N}]/u.test(e.text);
    if (word && this.deps.mode === 'call' && this.deps.speaking()) this.deps.barge();
    this.lastPos = e.pos;
    this.lineText += e.text;
    if (this.deps.mode === 'meeting') {
      const hit = scanWake(this.lineText, this.deps.wakePhrases);
      if (hit) this.closeLine(e.pos, hit);
    }
  }

  private activity(e: Extract<EngineEvent, { ev: 'act' }>): void {
    if (e.slot === this.slot) return;
    // The diarizer can label text that has already arrived. Adopt that
    // pending line instead of closing it nameless and starting it over.
    if (this.slot === -1 && e.slot >= 0 && this.lineText.trim() && e.t <= this.lastPos) {
      this.slot = e.slot;
      this.slotStart = e.t;
      return;
    }
    if (this.slot >= 0) {
      this.noteStretch(this.slot, this.slotStart, e.t);
      this.bind(this.slot);
    }
    if (this.slot >= 0 || this.lineText.trim()) this.closeLine(e.t);
    // A wake cut keeps its speaker; only an act changes the current slot.
    this.slot = e.slot;
    if (e.slot >= 0) {
      this.lineStart = e.t;
      this.slotStart = e.t;
    }
  }

  private finish(): void {
    const end = this.lastPos || this.lineStart;
    if (this.slot >= 0) {
      this.noteStretch(this.slot, this.slotStart, end);
      this.bind(this.slot);
    }
    if (this.slot >= 0 || this.lineText.trim()) this.closeLine(end);
    this.deps.log.info('voice.engine.eof', { room: this.deps.label });
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
    // Both callers just recorded this slot's stretch. These guards leave
    // only an unbound diarized slot, which noteStretch always records.
    const held = this.longest.get(slot)!;
    if (held[1] - held[0] < MIN_BIND_S) return;
    const pad = (held[1] - held[0]) / 4;
    const name = this.deps.identify(held[0] + pad, held[1] - pad);
    if (name === null) return; // the speaker-id model had nothing to say: try again at the next stretch
    this.names.set(slot, name);
    this.deps.log.info('voice.slot-bound', { room: this.deps.label, slot, name });
  }

  private closeLine(t1: number, wake: string | null = null): void {
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
    if (!text || end - t0 < MIN_LINE_S) return;
    this.deps.commit(t0, end, speaker, text, wake);
  }
}

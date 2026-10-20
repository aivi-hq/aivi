/** Speaking the answer as it is written: mouths, play generations, clause
 *  cutting, and the speaking window that makes barge-in word-verified.
 *  The room owns one and delegates its mouth surface here.
 *
 *  The answer streams off OpenCode's event bus (`session.text.started` /
 *  `.delta`, the same events the channels' progress reads). It cuts at every
 *  clause end — `. , ; : ! ? …` followed by whitespace, and every line break
 *  ("3.5", "2,5", "Mr." survive uncut). A clause goes to the voice at once
 *  when the wire is free — so the FIRST sound waits for one clause, comma
 *  included — and while the voice speaks, later clauses wait and leave as
 *  ONE chunk: the voice gets long natural text, not sentence confetti. The
 *  last block's unspoken tail (no punctuation to cut on) goes out when the
 *  answer ends. A barge raises playGen; clauses buffered or synthesizing
 *  under the old answerGen die, and the model's reconsidered message (a new
 *  id) re-arms the generation so the reconsidered answer is heard.
 */
import type { Logger } from '@aivi/core';
import type { TtsRun } from './tts.ts';
import type { AnswerText } from './turns.ts';

export interface Mouth {
  play: (wav: Buffer) => boolean | Promise<boolean>;
  stop?: () => void;
  flush?: () => void;
}

export interface SpeechDeps {
  label: string;
  log: Logger;
  getTts: () => Promise<TtsRun | null>;
  /** The room's event fan-out: `stop_audio` rides it. */
  emit(event: Record<string, unknown>): void;
}

export class SpeechOut {
  private mouths: Mouth[] = [];
  private warnedMute = false;
  // The wire is ONE voice at a time (ruled 2026-10-13): the answer keeps
  // cutting clauses while the voice speaks, they wait here carrying the
  // answer's generation, and go out as one chunk the moment the wire frees.
  // A barge empties the buffer: text of a dead answer never speaks.
  private speechBusy = false;
  private speakQueue: Array<{ gen: number; text: string }> = [];
  private playGen = 0;
  // Speaking the answer AS it is written. The assistant message currently
  // streaming, its raw text, and how far of it has already gone to a mouth;
  // a new message (the model resumed after a tool, or reconsidered after a
  // barge) flushes the previous block's unspoken tail and re-arms the speech
  // generation so the reconsidered answer is heard. `answerGen` is the play
  // generation this answer speaks under: a barge raises playGen, and every
  // clause still queued or synthesizing sees the mismatch and dies.
  private speakMsg: string | null = null;
  private speakRaw = '';
  private spokenChars = 0;
  private sawText = false;
  private answerGen = 0;
  // Aivi is producing speech into a mouth right now (count > 0: clauses
  // pipeline, so it is a count, not a flag). Recognized words landing while
  // this is true are an interruption (barge-in); the same words while it is
  // false are just the next turn. This is what makes barge-in wait for a
  // WORD — a sniffle that transcribes to nothing never trips it.
  private speaking = false;
  private speakingCount = 0;
  private readonly deps: SpeechDeps;

  constructor(deps: SpeechDeps) {
    this.deps = deps;
  }

  /** Aivi is on the air (words recognized now are interruptions). */
  get isSpeaking(): boolean {
    return this.speaking;
  }

  mouth(play: Mouth['play'], stop?: () => void, flush?: () => void): () => void {
    const m: Mouth = { play, ...(stop ? { stop } : {}), ...(flush ? { flush } : {}) };
    this.mouths.push(m);
    return () => {
      this.mouths = this.mouths.filter(x => x !== m);
    };
  }

  /** Stop talking and listen: silence the playing answer, drop the answers
   *  still queued to be spoken. The interrupting words arrive as speech
   *  through the normal path and the session gets to reconsider. */
  barge(): void {
    this.playGen++; // every clause of the current answer, queued or in flight, now dies at its gen check
    this.speaking = false;
    this.deps.log.debug('voice.reply.barged', {
      room: this.deps.label,
      hint: 'recognized words took the air: the answer is silenced now',
    });
    this.deps.emit({ ev: 'stop_audio' });
    for (const m of this.mouths) {
      try {
        m.stop?.();
      } catch (error) {
        this.deps.log.warn('voice.mouth.stop-failed', { room: this.deps.label, error: String(error) });
      }
    }
  }

  /** One streamed piece of the answer (or its start): cut every finished
   *  clause and feed the voice lane (speak now when free, coalesce while
   *  busy). */
  text(ev: AnswerText): void {
    const id = ev.messageID;
    if (this.speakMsg === null)
      this.answerGen = this.playGen; // first block of this answer
    else if (this.speakMsg !== id) {
      // A different assistant message: the model resumed after a tool, or a
      // barge interrupted the last one and it is reconsidering. Speak the
      // block ending's unspoken tail, then re-arm under the current gen.
      this.flushTail();
      this.answerGen = this.playGen;
      this.speakRaw = '';
      this.spokenChars = 0;
    }
    this.speakMsg = id;
    this.sawText = true;
    if (ev.kind === 'start') return;
    this.speakRaw += ev.delta;
    this.cutClauses();
  }

  /** The answer is finished: if clauses streamed, only the last block's
   *  unspoken tail is new; if nothing streamed (a short answer, or ephemeral
   *  deltas missed), the whole answer goes at once — the pre-streaming path. */
  finish(text: string): void {
    if (this.sawText) this.flushTail();
    else {
      this.answerGen = this.playGen;
      void this.speakNow(text);
    }
    this.speakMsg = null;
    this.speakRaw = '';
    this.spokenChars = 0;
    this.sawText = false;
  }

  private cutClauses(): void {
    const src = this.speakRaw;
    let i = this.spokenChars;
    while (i < src.length) {
      const c = src[i];
      if (c === '\n') {
        // A line break cuts — and must ADVANCE — like every other clause end.
        if (this.feedSpeech(i + 1)) this.spokenChars = i + 1;
        i++;
        continue;
      }
      if (c !== undefined && '.,;:!?…'.includes(c)) {
        let end = i + 1;
        while (end < src.length && '"\'")」』'.includes(src[end]!)) end++;
        const after = end < src.length ? src[end]! : ' ';
        if (after === ' ' || after === '\n' || after === '\t') {
          if (this.feedSpeech(end)) this.spokenChars = end;
          i = end;
          continue;
        }
        i = end; // "3.5", "2,5", "Mr." — not a clause end
        continue;
      }
      i++;
    }
  }

  /** One cut clause: straight to the voice when the wire is free, into the
   *  wait-buffer (carrying the answer's generation) while it speaks. Returns
   *  whether the clause was taken, so the caller advances — too-thin scraps
   *  ("5", "a") are refused and join the next cut. */
  private feedSpeech(end: number): boolean {
    const piece = this.speakRaw.slice(this.spokenChars, end).trim();
    if (piece.replace(/\s+/g, '').length < 2) return false;
    if (this.speechBusy) this.speakQueue.push({ gen: this.answerGen, text: piece });
    else void this.speakNow(piece);
    return true;
  }

  /** The wire came free: everything buffered since leaves as ONE chunk — one
   *  voice request, one long natural stretch of speech. Clauses whose answer
   *  was barged over are dropped, unheard: the reconsidered message writes
   *  its own words. */
  private drainSpeech(): void {
    if (!this.speakQueue.length) return;
    const alive = this.speakQueue.filter(p => p.gen === this.playGen);
    this.speakQueue = [];
    if (alive.length) void this.speakNow(alive.map(p => p.text).join(' '));
  }

  /** Speak whatever of the current block never crossed a clause end — the
   *  final clause "and that is why", with no punctuation to cut on. It joins
   *  the wait-buffer when the voice is busy, exactly like a cut clause. */
  private flushTail(): void {
    const tail = this.speakRaw.slice(this.spokenChars).trim();
    this.spokenChars = this.speakRaw.length;
    if (tail.replace(/\s+/g, '').length === 0) return;
    if (this.speechBusy) this.speakQueue.push({ gen: this.answerGen, text: tail });
    else void this.speakNow(tail);
  }

  /** The wire is one voice at a time: busy from the moment work is taken
   *  (synchronously, before any await — streaming text must see it), and the
   *  buffered clauses of the same answer leave through the finally as the
   *  next chunk. Never two voice requests side by side. */
  private async speakNow(text: string): Promise<void> {
    if (!this.mouths.length) return;
    this.speechBusy = true;
    try {
      await this.speakOne(text);
    } finally {
      this.speechBusy = false;
      this.drainSpeech();
    }
  }

  /** One stretch of text to the voice: the voice speaks WHILE it
   *  synthesizes — wav chunks land and play as they are generated — under
   *  the answer's generation. A barge that raised playGen kills the stretch
   *  where it stands: the playing chunk is stopped, the rest goes unheard. */
  private async speakOne(text: string): Promise<void> {
    if (!this.mouths.length) return;
    const gen = this.answerGen;
    const tts = await this.deps.getTts();
    if (!tts) {
      if (!this.warnedMute) {
        this.warnedMute = true;
        this.deps.log.info('voice.room.mute', {
          room: this.deps.label,
          hint: 'a mouth is waiting but no TTS engine is running (voice.tts unconfigured, or its load failed — see voice.tts.start-failed): answers stay in text',
        });
      }
      return;
    }
    if (gen !== this.playGen) return; // barged before it got the air; the interruption's words go in instead
    let any = false;
    let interrupted = false;
    this.speakingCount++;
    this.speaking = true; // recognized words that land now are an interruption
    // The pump runs ahead of the wire — the generator is pulled while the
    // mouth still plays, so chunks land back to back without a synthesis
    // gap — but each chunk's play promise is kept: the speaking window
    // closes when the last chunk has actually left the mouth (played or
    // dropped by a barge), not when the text was handed over. A mouth that
    // answers with a plain true (the page) drains at once, as before.
    const tails: Array<Promise<void>> = [];
    try {
      for await (const wav of tts.chunks(text)) {
        if (gen !== this.playGen) {
          interrupted = true;
          break; // the generator is abandoned: the rest of this stretch goes unheard
        }
        any = true;
        tails.push(
          Promise.all(
            this.mouths.map(async m => {
              try {
                await m.play(wav);
              } catch (error) {
                this.deps.log.warn('voice.mouth.failed', { room: this.deps.label, error: String(error) });
              }
            }),
          ).then(() => {}),
        );
      }
      // Last chunk handed over: close the mouth's answer. A mouth that plays
      // one continuous band (Discord) needs the end of answer to drain its
      // player back to Idle; the barge path never gets here — its stop
      // already killed the band.
      for (const m of this.mouths) {
        try {
          m.flush?.();
        } catch (error) {
          this.deps.log.warn('voice.mouth.flush-failed', { room: this.deps.label, error: String(error) });
        }
      }
      await Promise.all(tails); // the answer is not over while its audio still plays
    } finally {
      this.speakingCount--;
      if (this.speakingCount === 0) this.speaking = false;
    }
    if (interrupted) this.deps.log.info('voice.reply.interrupted', { room: this.deps.label, chars: text.length });
    else if (!any) this.deps.log.warn('voice.reply.unspoken', { room: this.deps.label, chars: text.length });
  }
}

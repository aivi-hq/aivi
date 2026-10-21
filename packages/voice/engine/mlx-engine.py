#!/usr/bin/env python3
"""Reference voice engine for @aivi/voice: one MLX process for everything the
voice plugin asks of Voxtral — realtime streaming ASR, Nemotron-3
diarization, and batch transcription of finished utterances. No correction
pass: what arrives live is the transcript.

stdin  (JSONL, one event per line):
  {"a":"<b64 s16le 16 kHz mono>"}          mixed streaming audio (page lane)
  {"a":"<b64 ...>","lane":"u1"}            named-lane chunk: one speaker's
                                          live stream (Discord demuxes)
  {"lane":"u1","end":true}                 that speaker's utterance ended:
                                          flush the tail, then answer
  {"id":"t1","a":"<b64 ...>"}             batch request: transcribe this
                                          utterance → {"id":"t1","text":"..."}
stdout JSONL:
  {"ev":"diar","on":true|false}           FIRST event: whether the diarizer
                                          is loaded (mixed lines can only
                                          carry a speaker when true)
  {"ev":"delta","text":"...","pos":s}     voxtral text delta
  {"ev":"delta","text":...,"pos":...,"lane":"u1"}   a lane's delta
  {"ev":"act","t":s,"slot":n}             mixed active speaker changed (-1 = silence)
  {"ev":"session_reset","pos":s}          voxtral context restarted
  {"ev":"lane_end","lane":"u1"}           lane flushed and closed
  {"ev":"eof"}
  {"id":"t1","text":"..."} | {"id":"t1","error":"..."}   batch answer
stderr: status; "engine ready" means the models are loaded and stdin is read.

The diarizer question is answered ONCE, at startup, by configuration
(ruled 2026-10-14): DIAR_MODEL set → Nemotron loads before "engine ready",
and a configured model that will not load fails the engine start LOUDLY —
the host says so; nothing runs half-equipped in silence. DIAR_MODEL unset
→ expected, no diarizer: mixed audio is cut by loudness only and its lines
carry NO speaker, because naming a slice that may blend two voices invents
people. Named lanes never touch the diarizer whatever happens — the
platform (Discord) already says who speaks. The diarizer's slot labels are
for the host to bind to voiceprint-named people, once per slot, and the
slots themselves die with the stream: the person ids are what persist.

Env: VOXTRAL_MODEL overrides the ASR repo; DIAR_MODEL selects (or, unset,
refuses) the diarizer. Requires an environment with mlx-audio installed and
models fetched; @aivi/voice itself never imports python — any engine
speaking this protocol can replace this file.
"""
import base64
import contextlib
import json
import os
import sys

import mlx.core as mx
import numpy as np

mx.set_wired_limit(8 * 1024 * 1024 * 1024)

VOX_MODEL = os.environ.get("VOXTRAL_MODEL", "mlx-community/Voxtral-Mini-4B-Realtime-2602-4bit")
# Unset means NO diarizer — an expected configuration, not a default to
# fetch: mixed lines are cut by loudness and stay nameless (2026-10-14).
DIAR_MODEL = os.environ.get("DIAR_MODEL")
SR = 16000
THRESH = 0.5
# Segment smoothing for the diarizer's read path (2026-10-14, after a live
# meeting showed per-frame argmax flip-flopping slots): the library's own
# post-processing drops segments shorter than MIN_SEG_S and bridges pauses
# shorter than MERGE_GAP_S, so a turn is ONE segment, not a burst of frames.
MIN_SEG_S = 0.5
MERGE_GAP_S = 0.3
# Nemotron's probs stay sticky on the last speaker through silence, so the
# documented act(-1) ("silence") never lands after an utterance — the open
# line waits for the NEXT change (the fusion committed "Hello? Anyone
# there?" as one row). An energy timer closes it: quiet is quiet, said by
# the waveform, not by a model that forgot to let go.
SILENCE_RMS = 0.01  # float full-scale: below this is quiet
SILENCE_CLOSE_S = 0.7  # this long of quiet closes the open line
MAX_LANES = 8  # leak guard: named lanes the host forgot to close


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def new_session(vox):
    # The default streaming config buffers 30.4 s before emitting anything;
    # 480 ms of delay keeps words near-real-time without choppy output.
    return vox.create_streaming_session(temperature=0.0, transcription_delay_ms=480)


class Lane:
    """One named speaker's live stream: a bare Voxtral streaming session, no
    diarizer — the platform (Discord) demuxed the speakers already, so
    who-speaks is a fact of the lane, not a model's job. Words stream out as
    they land; end() closes the session — the model's own right-pad flush
    pushes the delayed tail out — and says lane_end once done."""

    def __init__(self, vox, lane_id):
        self.vox = vox
        self.lane_id = lane_id
        self.session = new_session(vox)
        self.fed = 0

    def feed(self, samples):
        self.fed += len(samples)
        pos = self.fed / SR
        self.session.feed(samples)
        while not self.session.done:
            deltas = self.session.step(max_decode_tokens=16)
            if not deltas:
                break
            for text in deltas:
                if text:
                    emit({"ev": "delta", "text": text, "pos": round(pos, 3), "lane": self.lane_id})
        if self.session.done:
            emit({"ev": "session_reset", "pos": round(pos, 3), "lane": self.lane_id})
            self.session.close()
            self.session = new_session(self.vox)

    def end(self):
        """close() is the session's own tail flush: it appends the model's
        right-pad of silence, which pushes the delayed last words out and
        ends the decode with a final token (done). The tested pattern is
        close-then-step-until-done; feeding our own silence and closing
        afterwards skips that flush and cuts the last words off."""
        eof_pos = self.fed / SR
        self.session.close()
        while not self.session.done:
            for text in self.session.step(max_decode_tokens=16):
                if text:
                    emit({"ev": "delta", "text": text, "pos": round(eof_pos, 3), "lane": self.lane_id})
        emit({"ev": "lane_end", "lane": self.lane_id})


class Streamer:
    """The mixed half: one continuous voxtral session + acts. Created on the
    first mixed chunk. The diarizer was loaded (or refused) at startup by
    configuration; with it, slot changes are speaker changes the host can
    name; without it, the waveform's loudness is the whole act story
    (slot 0 = someone, -1 = quiet) and the lines stay nameless."""

    def __init__(self, vox, diar):
        self.diar = diar
        self.dstate = diar.init_streaming_state() if diar is not None else None
        self.vox = vox
        self.session = new_session(vox)
        self.fed = 0
        self.cur_slot = -2  # force an initial act event
        self.quiet_s = 0.0
        self.tail_dirty = False  # words sit in the model's lookahead, unflushed

    def act(self, slot, t):
        if slot == self.cur_slot:
            return
        emit({"ev": "act", "t": t, "slot": slot})
        self.cur_slot = slot

    def diar_events(self, dres):
        """The diarizer says WHO, once per smoothed segment: a segment start
        opens (or re-opens) that speaker's stretch. It never says silence —
        segments carry no gaps, and it decides ~1 s behind the audio. The
        energy backstop owns WHEN a turn ends: it is the only thing running
        in real time, and it flushes the model's tail before closing."""
        if dres is None:
            return
        for seg in dres.segments:
            self.act(int(seg.speaker), round(float(seg.start), 3))

    def flush_tail(self, pos):
        """Push out the words still sitting in the model's delay window
        BEFORE act(-1) closes the line, so the last words land in the line
        they belong to (real meeting, 2026-10-14). No close(): the session
        STAYS ALIVE across turns. Closing per turn re-detected the language
        from one short utterance and flipped Dutch to English at random —
        one live session keeps its context, like the library's own
        streaming examples. The gate's real quiet (0.7 s) is close to the
        model's window (480 ms delay + a ~10-token tail) but not quite over
        it, so a synthetic quiet goes to the session first: silence decodes
        to nothing, it only pushes the delay window past the last word.
        The diarizer and the energy clock never see this pad — it is the
        session's own private water."""
        self.session.feed(np.zeros(int(0.6 * SR), dtype=np.float32))
        # bounded in the header: 32 short steps drain a turn's delay window
        # many times over; the honest exit is "nothing left to decode"
        for _ in range(32):
            deltas = self.session.step(max_decode_tokens=16)
            if not deltas:
                break
            for text in deltas:
                if text:
                    emit({"ev": "delta", "text": text, "pos": round(pos, 3)})
        self.tail_dirty = False

    def feed(self, samples):
        self.fed += len(samples)
        pos = self.fed / self.session.input_sample_rate

        rms = float(np.sqrt(np.mean(np.square(samples)))) if len(samples) else 0.0
        if self.diar is not None:
            dres, self.dstate = self.diar.feed(
                samples,
                self.dstate,
                threshold=THRESH,
                min_duration=MIN_SEG_S,
                merge_gap=MERGE_GAP_S,
            )
            self.diar_events(dres)

        self.session.feed(samples)
        while not self.session.done:
            deltas = self.session.step(max_decode_tokens=16)
            if not deltas:
                break
            for text in deltas:
                if text:
                    self.tail_dirty = True
                    emit({"ev": "delta", "text": text, "pos": round(pos, 3)})
        if self.session.done:
            emit({"ev": "session_reset", "pos": round(pos, 3)})
            self.session.close()
            self.session = new_session(self.vox)

        # Energy backstop: a spoken word resets the quiet clock; sustained
        # quiet says "silence" even when the diarizer holds onto its answer.
        # Without the diarizer this is the whole act story: 0 = someone,
        # -1 = quiet, and the waveform is the only witness. It runs AFTER
        # this chunk's words have landed, so a closing act never outruns
        # the transcript it is closing.
        if rms >= SILENCE_RMS:
            self.quiet_s = 0.0
            if self.diar is None:
                self.act(0, round(pos, 3))
        else:
            self.quiet_s += len(samples) / SR
            # The tail flush must NOT ride on the slot being open: with the
            # diarizer the slot often closes first (its segments arrive
            # late), and the gate then orphaned the lookahead words into
            # the NEXT utterance — "morgen?" landed 47 s after "in Alkmaar"
            # (real meeting, 2026-10-14). Dirty tail OR open slot.
            if self.quiet_s >= SILENCE_CLOSE_S and (self.cur_slot >= 0 or self.tail_dirty):
                # close the line WITH its tail: the model still holds the
                # last words in its lookahead, and act(-1) tells fusion the
                # line is over NOW — flush them into this line first, or
                # they orphan into the next utterance (2026-10-14)
                self.flush_tail(pos)
                self.act(-1, round(pos, 3))

    def flush(self):
        """Tails: nemotron lookahead, then the session's own close-flush."""
        eof_pos = self.fed / SR
        if self.diar is not None:
            dres, self.dstate = self.diar.feed(
                np.zeros(0, dtype=np.float32),
                self.dstate,
                final=True,
                threshold=THRESH,
                min_duration=MIN_SEG_S,
                merge_gap=MERGE_GAP_S,
            )
            self.diar_events(dres)

        self.session.close()
        while not self.session.done:
            for text in self.session.step(max_decode_tokens=16):
                if text:
                    emit({"ev": "delta", "text": text, "pos": round(eof_pos, 3)})
        if self.cur_slot >= 0:
            self.act(-1, round(eof_pos, 3))


def main():
    from mlx_audio.stt.utils import load as stt_load

    # stdout is the protocol: the library's load banner goes to stderr.
    # The diarizer question is settled HERE, once, by configuration: a
    # configured model that will not load ends the process loudly — the
    # host logs engine.start-failed with this stderr tail. No half-run.
    with contextlib.redirect_stdout(sys.stderr):
        vox = stt_load(VOX_MODEL)
        diar = None
        if DIAR_MODEL is not None:
            sys.stderr.write("diar loading\n")
            sys.stderr.flush()
            from mlx_audio.vad import load as vad_load

            try:
                diar = vad_load(DIAR_MODEL, strict=True)
                # "low" (NVIDIA's standard real-time preset, ~1.04 s of
                # decision lag): the checkpoint default is the OFFLINE
                # preset — what a file test gets and why isolation looked
                # perfect — and "ultra_low" decides on 240 ms chunks against
                # a 2.7 s trained context: live slots flip-flopped (real
                # meeting, 2026-10-14). The lag costs nothing here: the
                # energy backstop closes lines in real time; the diarizer
                # only says WHO, and fusion adopts late labels.
                diar.set_streaming_config("low")
            except Exception as e:
                sys.stderr.write(f"diarizer configured but did not load ({DIAR_MODEL}): {e}\n")
                sys.stderr.flush()
                sys.exit(1)
    sys.stderr.write(
        "engine ready (voxtral loaded"
        + (", diarizer loaded)" if diar is not None else "; no diarizer: mixed lines are nameless)") + "\n"
    )
    sys.stderr.flush()
    emit({"ev": "diar", "on": diar is not None})

    streamer = None
    lanes = {}
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            msg = json.loads(line)
            req_id = msg.get("id")
            lane_id = msg.get("lane")
            if lane_id is not None and msg.get("end"):
                lane = lanes.pop(lane_id, None)
                if lane is not None:
                    lane.end()
                continue
            samples = np.frombuffer(base64.b64decode(msg["a"]), dtype=np.int16).astype(np.float32) / 32768.0
            if req_id is not None:
                # Batch: same weights, no delay constraint, full quality.
                out = vox.generate(mx.array(samples), temperature=0.0)
                emit({"id": req_id, "text": (out.text or "").strip()})
                continue
            if lane_id is not None:
                lane = lanes.get(lane_id)
                if lane is None:
                    while len(lanes) >= MAX_LANES:  # leak guard: the oldest goes
                        _, dead = lanes.pop(next(iter(lanes)))
                        dead.end()
                    lane = lanes[lane_id] = Lane(vox, lane_id)
                lane.feed(samples)
                continue
            if streamer is None:
                streamer = Streamer(vox, diar)
            streamer.feed(samples)
        except Exception as e:  # one bad frame or utterance must never kill the engine
            if req_id is not None:
                emit({"id": req_id, "error": str(e)})
            else:
                sys.stderr.write(f"frame error: {e}\n")
                sys.stderr.flush()

    for lane in lanes.values():
        lane.end()
    if streamer is not None:
        streamer.flush()
    emit({"ev": "eof"})


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Reference TTS engine for @aivi/voice: Voxtral TTS, the voice aivi speaks
with. A bridge plays the returned wav as the room's microphone — that is the
"virtual mic": in a meeting aivi's mic IS this audio.

stdin  (JSONL requests): {"id":"t1","text":"...","voice":"nl_female","stream":true}
stdout (JSONL results):  {"id":"t1","seq":0,"audio":"<base64 wav>","sr":24000,"final":false}
                         ... last chunk carries "final":true ...
                         {"id":"t1","error":"..."}
stderr: status; "tts ready" means the model is loaded.

stream=true speaks AS it synthesizes: Voxtral TTS yields audio chunks while
generating (its own tuned interval — the chunker handles the seams), each
one a complete wav the bridge can play the moment it lands. stream=false (or
absent) is the same protocol with one final chunk: the client has one path.

Env: VOXTRAL_TTS_MODEL overrides the repo. Dutch voices: nl_male, nl_female.
One model, one request at a time (the client serializes).
"""
import base64
import contextlib
import io
import json
import os
import sys
import wave

import mlx.core as mx
import numpy as np

mx.set_wired_limit(8 * 1024 * 1024 * 1024)

TTS_MODEL = os.environ.get("VOXTRAL_TTS_MODEL", "mlx-community/Voxtral-4B-TTS-2603-mlx-6bit")
# Seconds of audio per streamed chunk (the library's streaming_interval). The
# wire costs a small seam at every chunk boundary; a synthesizer slower than
# real time (RTF > 1) cannot sustain 2 s chunks without gaps — bigger chunks
# amortize both. Tuned by measurement, not by taste.
TTS_INTERVAL = float(os.environ.get("VOXTRAL_TTS_INTERVAL", "2.0"))


def main():
    from mlx_audio.tts.utils import load as tts_load

    # stdout is the protocol: the library's load banner goes to stderr.
    with contextlib.redirect_stdout(sys.stderr):
        model = tts_load(TTS_MODEL)
    sr = model.sample_rate
    sys.stderr.write("tts ready (voxtral-tts loaded)\n")
    sys.stderr.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req["id"]
            if req.get("stream"):
                # Speak as it synthesizes: every yielded chunk is a wav on the
                # wire, and the last one (even empty) says the sentence is done.
                seq = 0
                for r in model.generate(
                    text=req["text"], voice=req["voice"], stream=True, streaming_interval=TTS_INTERVAL
                ):
                    final = bool(getattr(r, "is_final_chunk", True))
                    audio = np.asarray(r.audio).flatten()
                    if audio.size == 0 and not final:
                        continue
                    emit({"id": req_id, "seq": seq, "audio": wav_b64(audio, sr), "sr": sr, "final": final})
                    seq += 1
                    if final:
                        break
            else:
                parts = [np.asarray(r.audio).flatten() for r in model.generate(text=req["text"], voice=req["voice"])]
                audio = np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)
                emit({"id": req_id, "seq": 0, "audio": wav_b64(audio, sr), "sr": sr, "final": True})
        except Exception as e:  # one bad sentence must never kill the voice
            emit({"id": req_id, "error": str(e)})


def wav_b64(audio, sr):
    """One chunk, one complete wav: the bridge plays each as it lands."""
    pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype(np.int16).tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm)
    return base64.b64encode(buf.getvalue()).decode()


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()

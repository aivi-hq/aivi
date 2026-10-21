#!/usr/bin/env python3
"""Reference BATCH voice engine for @aivi/voice: offline-quality Voxtral
transcription of whole utterances. No diarizer, no streaming session — the
Discord lane hands over finished utterances already attributed by Discord,
and each one is transcribed at full quality (this is where the realtime
model shines: same weights, no delay constraint).

stdin  (JSONL requests): {"id":"r1","pcm":"<base64 s16le 16 kHz mono>"}
stdout (JSONL results):  {"id":"r1","text":"..."} or {"id":"r1","error":"..."}
stderr: status; "engine ready" means the model is loaded.

Env: VOXTRAL_MODEL overrides the repo. One model, one request at a time
(the client serializes).
"""
import base64
import json
import os
import sys

import mlx.core as mx
import numpy as np

mx.set_wired_limit(8 * 1024 * 1024 * 1024)

VOX_MODEL = os.environ.get("VOXTRAL_MODEL", "mlx-community/Voxtral-Mini-4B-Realtime-2602-4bit")


def main():
    from mlx_audio.stt.utils import load as stt_load

    vox = stt_load(VOX_MODEL)
    sys.stderr.write("engine ready (batch, voxtral loaded)\n")
    sys.stderr.flush()

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req["id"]
            pcm = np.frombuffer(base64.b64decode(req["pcm"]), dtype=np.int16)
            audio = mx.array(pcm.astype(np.float32) / 32768.0)
            out = vox.generate(audio, temperature=0.0)
            emit({"id": req_id, "text": (out.text or "").strip()})
        except Exception as e:  # one bad utterance must never kill the engine
            emit({"id": req_id, "error": str(e)})


def emit(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


if __name__ == "__main__":
    main()

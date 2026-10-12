"""Generate the referee's knockdown count voice lines (one..ten) with Qwen3-TTS
(the model behind flybirdxx/ComfyUI-Qwen-TTS), CPU-only.

All ten numbers are spoken in ONE utterance so the voice is identical across
them, then split on the silences between words.

Run (deps installed to generated-artifacts/qtts, gitignored):
  PYTHONPATH=generated-artifacts/qtts HF_HOME=generated-artifacts/hf \
    python3 script/genRefCountVoice.py
Output: generated-artifacts/refcount/count_01..10.wav (+ full.wav)
"""
import os
import sys

import numpy as np
import soundfile as sf
import torch
import librosa

from qwen_tts import Qwen3TTSModel

OUT = "generated-artifacts/refcount"
MODEL = os.environ.get("QTTS_MODEL", "Qwen/Qwen3-TTS-12Hz-1.7B-VoiceDesign")
WORDS = ["One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten"]
TEXT = " ... ".join(w + "!" for w in WORDS)
INSTRUCT = os.environ.get(
    "QTTS_INSTRUCT",
    "A seasoned middle-aged male boxing referee with a deep, gravelly, authoritative voice, "
    "counting out a knocked-down fighter in a loud arena. Each number is shouted sharply and "
    "emphatically, with a clear pause of about one second between numbers.",
)

os.makedirs(OUT, exist_ok=True)
torch.set_num_threads(os.cpu_count() or 4)
model = Qwen3TTSModel.from_pretrained(MODEL, device_map="cpu", dtype=torch.bfloat16)
seed = int(os.environ.get("QTTS_SEED", "7"))
torch.manual_seed(seed)
wavs, sr = model.generate_voice_design(text=TEXT, instruct=INSTRUCT, language="English")
wav = np.asarray(wavs[0], dtype=np.float32)
sf.write(f"{OUT}/full.wav", wav, sr)
print("full", len(wav) / sr, "s at", sr)

# Split on silence; merge fragments until exactly ten segments remain.
for top_db in (30, 35, 40, 25, 45, 20):
    iv = librosa.effects.split(wav, top_db=top_db, frame_length=1024, hop_length=256)
    segs = [list(x) for x in iv if (x[1] - x[0]) / sr > 0.05]
    while len(segs) > 10:
        gaps = [segs[i + 1][0] - segs[i][1] for i in range(len(segs) - 1)]
        i = int(np.argmin(gaps))
        segs[i][1] = segs[i + 1][1]
        del segs[i + 1]
    if len(segs) == 10:
        break
else:
    print("could not split into 10, got", len(segs))
    sys.exit(1)

pad = int(0.03 * sr)
for n, (a, b) in enumerate(segs, 1):
    clip = wav[max(0, a - pad): min(len(wav), b + pad)].copy()
    fade = min(int(0.01 * sr), len(clip) // 4)
    clip[:fade] *= np.linspace(0, 1, fade)
    clip[-fade:] *= np.linspace(1, 0, fade)
    peak = np.max(np.abs(clip)) or 1.0
    clip = clip / peak * 0.9
    sf.write(f"{OUT}/count_{n:02d}.wav", clip, sr)
    print(n, WORDS[n - 1], round((b - a) / sr, 2), "s")

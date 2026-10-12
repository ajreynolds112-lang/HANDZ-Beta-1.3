"""Referee voice lines in the SAME voice as the knockdown count: Qwen3-TTS Base
voice-clones generated-artifacts/refcount/full.wav (made by genRefCountVoice.py).

Run (deps in generated-artifacts/qtts, gitignored):
  PYTHONPATH=generated-artifacts/qtts HF_HOME=generated-artifacts/hf \
    TMPDIR=generated-artifacts/tmp python3 script/genRefLines.py [name ...]
Output: generated-artifacts/reflines/<name>.wav
"""
import os
import sys

import numpy as np
import soundfile as sf
import torch
import librosa

from qwen_tts import Qwen3TTSModel

OUT = "generated-artifacts/reflines"
MODEL = os.environ.get("QTTS_MODEL", "Qwen/Qwen3-TTS-12Hz-1.7B-Base")
REF_AUDIO = "generated-artifacts/refcount/full.wav"
REF_TEXT = "One! Two! Three! Four! Five! Six! Seven! Eight! Nine! Ten!"
LINES = {
    "ref_over_1": "That's it!",
    "ref_over_2": "It's over!",
    "ref_kd_1": "Okay, good to go? Box!",
    "ref_kd_2": "Look at me. Are you able to continue? Okay! Box!",
    "ref_kd_3_stop": "You gotta show me something, or I'm stopping this fight!",
    "ref_kd_3": "You gotta show me something. If you don't fight back, it's over! Box!",
    "ref_intro": "Protect yourself at all times. Obey my commands. When I say break, you break. Ready? Ready?",
}
names = sys.argv[1:] or list(LINES)

os.makedirs(OUT, exist_ok=True)
torch.set_num_threads(os.cpu_count() or 4)
model = Qwen3TTSModel.from_pretrained(MODEL, device_map="cpu", dtype=torch.bfloat16)
prompt = model.create_voice_clone_prompt(ref_audio=REF_AUDIO, ref_text=REF_TEXT)
torch.manual_seed(int(os.environ.get("QTTS_SEED", "7")))
for name in names:
    wavs, sr = model.generate_voice_clone(text=LINES[name], language="English", voice_clone_prompt=prompt)
    wav = np.asarray(wavs[0], dtype=np.float32)
    wav, _ = librosa.effects.trim(wav, top_db=35)
    pad = int(0.03 * sr)
    wav = np.pad(wav, (pad, pad))
    fade = int(0.01 * sr)
    wav[:fade] *= np.linspace(0, 1, fade)
    wav[-fade:] *= np.linspace(1, 0, fade)
    wav = wav / (np.max(np.abs(wav)) or 1.0) * 0.9
    sf.write(f"{OUT}/{name}.wav", wav, sr)
    print(name, round(len(wav) / sr, 2), "s", flush=True)

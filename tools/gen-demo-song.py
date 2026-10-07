# -*- coding: utf-8 -*-
"""生成 mv-mini 演示曲：24s，Am-F-C-G 四段 6s，钢琴 8 分音符律动 + 三音 pad。
用法（在 kine/ 下）：py\\kine-py\\.venv\\Scripts\\python.exe tools\\gen-demo-song.py
输出：examples/mv-mini/assets/song.wav
"""
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'py' / 'kine-py'))

from kine_py import synth as S  # noqa: E402
from kine_py import wavio  # noqa: E402

SR = 48000
DUR = 24.0
OUT = ROOT / 'examples' / 'mv-mini' / 'assets' / 'song.wav'

n = int(DUR * SR)
song = np.zeros(n, dtype=np.float32)


def add(x: np.ndarray, at: float, g: float = 1.0) -> None:
    off = int(round(at * SR))
    if off >= n:
        return
    end = min(n, off + x.size)
    if end > off:
        song[off:end] += x[: end - off] * g


# ---- pad：Am F C G，每段 6s，三音 + 轻微 detune
chords = [
    (220.00, 261.63, 329.63),  # Am
    (174.61, 220.00, 261.63),  # F
    (130.81, 164.81, 196.00),  # C
    (196.00, 246.94, 293.66),  # G
]
for i, ch in enumerate(chords):
    seg = 6.4
    t = np.arange(int(seg * SR)) / SR
    env = np.minimum(1.0, t / 0.35) * np.minimum(1.0, (seg - t) / 0.35)
    pad = np.zeros(t.size, dtype=np.float32)
    for f0 in ch:
        for det in (-1, 0, 1):
            f = f0 * (1 + det * 0.004)
            pad += (np.sin(2 * np.pi * f * t + det * 1.1) * 0.10 * env).astype(np.float32)
    add(pad, i * 6.0, 0.55)

# ---- 钢琴律动：每段 12 个 8 分音符（0.5s），节拍明确（供 beat 检测）
mel = [0, 4, 7, 4, 0, 4, 9, 7, 5, 9, 12, 9, 7, 5, 4, 2]
for bar in range(4):
    for j in range(12):
        midi = 57 + mel[(bar * 12 + j) % len(mel)]
        f = 440.0 * 2 ** ((midi - 69) / 12)
        x = S.synth('piano_motif', SR, {'notes': [f], 'spacing': 0.0, 'gain': 0.34, 'dur': 1.1, 'chord_at': 999})
        add(x, bar * 6.0 + j * 0.5, 1.0)

peak = float(np.max(np.abs(song)))
song = song / max(1e-9, peak) * 0.82
OUT.parent.mkdir(parents=True, exist_ok=True)
info = wavio.write_wav(str(OUT), song, SR)
print('song written', OUT, info)

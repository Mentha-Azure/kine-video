# 能量包络：STFT 前 10 bin → dB → 0-255，按 fps 帧对齐（等效 AnalyserNode fftSize=256 的口径）
# 用途：beat_delta / 强拍事件参考 / probe 回显。严禁把 energy 当画面提亮（L-AUD-003）。
import numpy as np

GATE = 0.005   # 瞬态门限（振幅尺度）
GAIN = 130.0   # 包络增益
DECAY = 0.80   # 帧间衰减

FFT_N = 256
BINS = (1, 11)  # 跳过 DC，取前 10 bin


def compute_env(samples: np.ndarray, sr: int, fps: float, nframes: int) -> dict:
    """返回 {values: uint8[nframes], max, mean}。"""
    x = np.asarray(samples, dtype=np.float32)
    win = np.blackman(FFT_N).astype(np.float32)
    vals = np.zeros(nframes, dtype=np.float64)
    for i in range(nframes):
        i0 = int(round(i * sr / fps))
        seg = x[i0: i0 + FFT_N]
        if seg.size < FFT_N:
            seg = np.pad(seg, (0, FFT_N - seg.size))
        sp = np.abs(np.fft.rfft(seg * win)) / FFT_N
        mag = float(np.mean(sp[BINS[0]: BINS[1]]))
        db = 20.0 * np.log10(mag + 1e-9)
        v = (db + 90.0) / 90.0 * 255.0
        vals[i] = min(255.0, max(0.0, v))
    out = np.round(vals).astype(np.uint8)
    return {
        'values': out.tolist(),
        'max': int(out.max()) if out.size else 0,
        'mean': float(out.mean()) if out.size else 0.0,
        'fps': fps,
        'nframes': nframes,
    }


def detect_beats(samples: np.ndarray, sr: int, fps: float = 60.0, min_gap: float = 0.12, rel: float = 0.35) -> dict:
    """帧域包络找局部极大（最小间隔 min_gap，相对阈值 rel）。

    常量 GATE/GAIN/DECAY 与源工程口径一致：env[i]=max(peak[i], env[i-1]*DECAY)，
    level=env*GAIN 用于门限；过门后的局部极大为强拍。
    """
    x = np.asarray(samples, dtype=np.float32)
    if x.size == 0:
        return {'beats': [], 'count': 0}
    nframes = int(len(x) / sr * fps)
    hop = sr / fps
    env = np.zeros(nframes, dtype=np.float64)
    peaks = np.zeros(nframes, dtype=np.float64)
    for i in range(nframes):
        i0 = int(round(i * hop))
        i1 = int(round((i + 1) * hop))
        seg = x[i0: max(i1, i0 + 1)]
        peaks[i] = float(np.max(np.abs(seg))) if seg.size else 0.0
    prev = 0.0
    for i in range(nframes):
        env[i] = max(peaks[i], prev * DECAY)
        prev = env[i]
    level = env * GAIN
    gate = GATE / GAIN
    beats = []
    last_t = -1e9
    thresh = max(float(np.max(env)) * rel, gate)
    for i in range(1, nframes - 1):
        if env[i] >= thresh and env[i] >= env[i - 1] and env[i] > env[i + 1]:
            t = i / fps
            if t - last_t >= min_gap:
                beats.append({'t': round(t, 6), 'strength': round(float(level[i]), 4)})
                last_t = t
    return {
        'beats': beats,
        'count': len(beats),
        'gate': GATE,
        'gain': GAIN,
        'decay': DECAY,
        'fps': fps,
    }

# 离线音效合成器（纯函数 sample(n)=f(n,params,rng)，字节级确定）
# 内置 7 种：heartbreak / rain / piano_motif / keyboard / tape / drone / glitch
import numpy as np
from scipy.signal import butter, sosfilt

from .rng import randn, uniform, rng_for

DEFAULT_DUR = {
    'heartbreak': 1.4,
    'rain': 8.0,
    'piano_motif': 3.2,
    'keyboard': 0.9,
    'tape': 4.0,
    'drone': 4.0,
    'glitch': 0.06,
}


def _sos(kind: str, cutoff: float, sr: int, order: int = 2):
    nyq = sr / 2.0
    wn = min(max(cutoff / nyq, 1e-4), 0.99)
    return butter(order, wn, btype=kind, output='sos')


def lowpass(x: np.ndarray, cutoff: float, sr: int, order: int = 2) -> np.ndarray:
    return sosfilt(_sos('low', cutoff, sr, order), x).astype(np.float32)


def highpass(x: np.ndarray, cutoff: float, sr: int, order: int = 2) -> np.ndarray:
    return sosfilt(_sos('high', cutoff, sr, order), x).astype(np.float32)


def _norm(x: np.ndarray, peak: float = 0.9) -> np.ndarray:
    m = float(np.max(np.abs(x))) if x.size else 0.0
    if m < 1e-9:
        return x.astype(np.float32)
    return (x * (peak / m)).astype(np.float32)


def _sine(t: np.ndarray, f: np.ndarray | float) -> np.ndarray:
    return np.sin(2.0 * np.pi * f * t)


def synth(name: str, sr: int, params: dict, seed: int = 7) -> np.ndarray:
    dur = float(params.get('dur') or DEFAULT_DUR.get(name, 1.0))
    n = max(1, int(round(dur * sr)))
    t = np.arange(n, dtype=np.float64) / sr
    ch = f'sfx.{name}'

    if name == 'heartbreak':
        # 噪声爆 + 快速衰减的低频重击（GATE .005 / GAIN 130 / DECAY .80 口径由 env 层使用）
        thump = _sine(t, 52.0 * (1.0 - 0.25 * np.minimum(t, 1.0))) * np.exp(-t / 0.18)
        burst = lowpass(randn(ch + '.burst', n), 900, sr) * np.exp(-t / 0.055)
        body = _sine(t, 182.0) * np.exp(-t / 0.10) * 0.18
        x = 0.85 * thump + 0.45 * burst + body
        return _norm(x, 0.9)

    if name == 'rain':
        # LP900 白噪床 + 确定性雨滴
        white = randn(ch + '.bed', n)
        bed = lowpass(white, 900, sr) * 0.30
        drops_per_s = float(params.get('drops_per_sec') or 24.0)
        nd = int(dur * drops_per_s)
        g = rng_for(ch + '.drops')
        times = np.sort(g.uniform(0.0, dur, nd))
        drop_len = int(0.012 * sr)
        tl = np.arange(drop_len, dtype=np.float64) / sr
        click_shape = np.exp(-tl / 0.008)
        for t0 in times:
            i0 = int(t0 * sr)
            if i0 + drop_len >= n:
                continue
            click = highpass(randn(ch + f'.d{i0}', drop_len), 2000, sr) * click_shape
            bed[i0: i0 + drop_len] += click * 0.5
        return _norm(bed * float(params.get('bed_gain') or 1.0), 0.85)

    if name == 'piano_motif':
        # 加性合成：基音+泛音+指数衰减；可选结尾弦乐解决和弦
        notes = params.get('notes') or [261.63, 329.63, 392.0, 523.25]
        spacing = float(params.get('spacing') or 0.42)
        gain = float(params.get('gain') or 0.5)
        x = np.zeros(n, dtype=np.float64)
        harms = [(1.0, 1.10), (2.0, 0.55), (3.0, 0.28), (4.0, 0.14), (5.0, 0.08)]
        for k, f in enumerate(notes):
            t0 = k * spacing
            i0 = int(t0 * sr)
            if i0 >= n:
                break
            tt = t[i0:] - t0
            env = (1.0 - np.exp(-tt / 0.004)) * np.exp(-tt / 1.1)
            sig = np.zeros_like(tt)
            for h, a in harms:
                if f * h < sr * 0.45:
                    sig += a * _sine(tt, f * h)
            x[i0:] += sig * env * gain
        chord = params.get('chord')
        if chord:
            ca = float(params.get('chord_at') or (dur - 1.2))
            i0 = int(ca * sr)
            if 0 <= i0 < n:
                tt = t[i0:] - ca
                env = (1.0 - np.exp(-tt / 0.02)) * np.exp(-tt / 1.6)
                sig = np.zeros_like(tt)
                for k, f in enumerate(chord):
                    det = 1.0 + (0.0012 if k % 2 else -0.0012)
                    sig += _sine(tt, f * det) * 0.5
                x[i0:] += sig * env * gain
        x = _norm(x, 0.85)
        # gain 旋钮：只调「归一化后」整体幅度（默认 0.5 时字节不变；修复历史死旋钮）
        return x * min(1.0, max(0.0, gain / 0.5))

    if name == 'keyboard':
        # 打字短 click 序列；周期与视觉 type_period 同源
        period = float(params.get('period') or 0.12)
        count = int(params.get('count') or max(1, int(dur / period)))
        x = np.zeros(n, dtype=np.float64)
        click_len = int(0.02 * sr)
        tl = np.arange(click_len, dtype=np.float64) / sr
        for k in range(count):
            t0 = 0.04 + k * period
            i0 = int(t0 * sr)
            if i0 + click_len >= n:
                break
            click = highpass(randn(ch + f'.k{k}', click_len), 3000, sr) * np.exp(-tl / 0.006)
            thock = _sine(tl, 160.0) * np.exp(-tl / 0.02) * 0.3
            x[i0: i0 + click_len] += (click * 0.8 + thock)
        return _norm(x, 0.75)

    if name == 'tape':
        # 噪声床 + LFO 走带晃动 + 高频嘶声
        white = lowpass(randn(ch + '.bed', n), 400, sr)
        wow = 1.0 + 0.06 * np.sin(2.0 * np.pi * 0.3 * t)
        hiss = highpass(randn(ch + '.hiss', n), 4000, sr) * 0.03
        return _norm(white * wow * 0.8 + hiss, 0.6)

    if name == 'drone':
        # 低频漂移床（逐幕 drone_levels 在混音侧应用）
        base = float(params.get('freq') or 55.0)
        x = (
            _sine(t, base) * 0.6
            + _sine(t, base * 1.005) * 0.4
            + _sine(t, base * 2.0) * 0.25
        )
        x = lowpass(x, 300, sr) * (0.8 + 0.2 * np.sin(2.0 * np.pi * 0.13 * t))
        x += lowpass(randn(ch + '.n', n), 300, sr) * 0.15
        return _norm(x, 0.75)

    if name == 'glitch':
        # 位短噪声（≤2 帧宽）+ 蓝色高频成分
        rate = int(params.get('rate') or 8000)
        hold = max(1, sr // rate)
        vals = randn(ch + '.bits', n // hold + 2)
        sh = np.repeat(vals, hold)[:n]
        x = highpass(sh, 600, sr)
        blue = _sine(t, float(params.get('blue_freq') or 2600.0)) * np.exp(-t / 0.02) * 0.3
        x = np.round(x * 8.0) / 8.0  # 量化
        return _norm(x * 0.9 + blue, 0.8)

    raise ValueError(f'未知音效：{name}')

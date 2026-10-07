# 混音：song 路（cut_from 截断 + fade_out 余弦）+ sfx 路（总线增益 + 末段 0.4s 同步淡出）+ 全路等比 limit
import numpy as np

from .synth import synth
from .wavio import read_wav, to_mono, write_wav

TAIL_FADE = 0.4  # 收尾同步淡出时长（只作用于 sfx 路与整体收尾，禁止硬砍 mix 总路）


def cosine_fade(n: int, sr: int, dur: float) -> np.ndarray:
    """(1+cos)/2 从 1 到 0 的窗口，长度 dur*sr。"""
    m = max(1, int(round(dur * sr)))
    p = np.arange(min(m, n), dtype=np.float64) / max(1, m - 1)
    return ((1.0 + np.cos(np.pi * p)) / 2.0).astype(np.float32)


def build_sfx_track(events: list, sr: int, total_sec: float, seed: int = 7, bus_gains: dict | None = None, tail_fade: float = TAIL_FADE) -> np.ndarray:
    """events: [{id,sfx,at,gain,bus,params}] → 总线求和后的 sfx 轨（已含末段淡出）。"""
    n = int(round(total_sec * sr))
    bus_gains = bus_gains or {}
    buses: dict[str, np.ndarray] = {}
    for ev in events:
        x = synth(ev['sfx'], sr, ev.get('params') or {}, seed=seed)
        x = x * float(ev.get('gain') or 1.0)
        off = int(round(float(ev['at']) * sr))
        if off >= n:
            continue
        bus = str(ev.get('bus') or 'hits')
        buf = buses.get(bus)
        if buf is None:
            buf = np.zeros(n, dtype=np.float32)
            buses[bus] = buf
        end = min(n, off + x.size)
        if end > off:
            buf[off:end] += x[: end - off].astype(np.float32)
    total = np.zeros(n, dtype=np.float32)
    for bus, buf in buses.items():
        total += buf * float(bus_gains.get(bus, 1.0))
    # 末段同步淡出（不断）
    fade_n = min(int(tail_fade * sr), n)
    if fade_n > 0:
        total[n - fade_n:] *= cosine_fade(fade_n, sr, tail_fade)
    return total


def run_mix(
    music_path: str | None,
    duration: float,
    out: str,
    sfx_path: str | None = None,
    gain: float = 1.0,
    fade_out: dict | None = None,
    cut_from: float | None = None,
    limit_dbfs: float = -1.0,
    sr: int = 48000,
) -> dict:
    # 以音乐采样率为准（原曲原速，永不重采样整体变速）
    song = None
    if music_path:
        x, sr = read_wav(music_path)
        song = to_mono(x)
    n = int(round(duration * sr))
    buf = np.zeros(n, dtype=np.float32)
    if song is not None:
        m = min(n, song.size)
        buf[:m] += song[:m] * float(gain)
        if fade_out:
            at = float(fade_out.get('at', 0.0))
            dur = float(fade_out.get('dur', 0.4))
            i0 = int(round(at * sr))
            if i0 < n:
                f = cosine_fade(n - i0, sr, dur)
                buf[i0: i0 + f.size] *= f
        if cut_from is not None:
            ic = int(round(float(cut_from) * sr))
            if 0 <= ic < n:
                buf[ic:] = 0.0
    if sfx_path:
        sx, ssr = read_wav(sfx_path)
        s = to_mono(sx)
        if ssr != sr:
            from scipy.signal import resample_poly
            from math import gcd
            g = gcd(ssr, sr)
            s = resample_poly(s, sr // g, ssr // g).astype(np.float32)
        m = min(n, s.size)
        buf[:m] += s[:m]
    peak_before = float(np.max(np.abs(buf))) if buf.size else 0.0
    limit_lin = 10.0 ** (limit_dbfs / 20.0)
    limited = False
    if peak_before > limit_lin and peak_before > 0:
        buf *= (limit_lin / peak_before)
        limited = True
    info = write_wav(out, buf, sr)
    peak_after = info['peak']
    return {
        'file': out,
        'sr': sr,
        'frames': info['frames'],
        'peakBeforeDbfs': _dbfs(peak_before),
        'peakAfterDbfs': _dbfs(peak_after),
        'limited': limited,
        'limitDbfs': limit_dbfs,
    }


# 完全静音时的 dBFS 地板值。禁止返回 ±inf/nan：python json.dumps 会将其序列化为
# 非标准常量（-Infinity），Node 端 JSON.parse 失败丢弃该协议行 → 请求挂死到超时。
SILENT_DBFS = -200.0


def _dbfs(x: float) -> float:
    if x <= 1e-9:
        return SILENT_DBFS
    return round(20.0 * float(np.log10(x)), 3)


def audio_stats(samples: np.ndarray, sr: int, window: float = 0.1) -> dict:
    """0.1s 窗 RMS 曲线 + 峰值 + cumenergy 99.9% 时刻 + 尾部峰值。"""
    x = np.asarray(samples, dtype=np.float64)
    n = x.size
    w = max(1, int(round(window * sr)))
    nw = n // w
    rms = np.zeros(nw)
    for i in range(nw):
        seg = x[i * w: (i + 1) * w]
        rms[i] = np.sqrt(np.mean(seg ** 2))
    times = np.arange(nw) * window
    energy = rms ** 2
    cum = np.cumsum(energy)
    t999 = None
    if cum.size and cum[-1] > 0:
        idx = int(np.searchsorted(cum, 0.999 * cum[-1]))
        t999 = float(times[min(idx, nw - 1)])
    tail_n = min(int(0.2 * sr), n)
    tail_peak = float(np.max(np.abs(x[n - tail_n:]))) if tail_n else 0.0
    peak = float(np.max(np.abs(x))) if n else 0.0
    return {
        'rmsCurve': [{'t': round(float(t), 3), 'dbfs': _dbfs(float(r))} for t, r in zip(times, rms)],
        'peakDbfs': _dbfs(peak),
        'rmsDbfs': _dbfs(float(np.sqrt(np.mean(x ** 2))) if n else 0.0),
        't99_9': t999,
        'tailPeakDbfs': _dbfs(tail_peak),
        'duration': n / sr,
    }


def window_levels(samples: np.ndarray, sr: int, windows: list) -> list:
    x = np.asarray(samples, dtype=np.float64)
    out = []
    for w in windows:
        t0 = float(w[0]) if isinstance(w, (list, tuple)) else float(w['t0'])
        t1 = float(w[1]) if isinstance(w, (list, tuple)) else float(w['t1'])
        i0 = max(0, int(round(t0 * sr)))
        i1 = min(x.size, int(round(t1 * sr)))
        seg = x[i0:i1]
        if seg.size == 0:
            out.append({'t0': t0, 't1': t1, 'peakDbfs': SILENT_DBFS, 'rmsDbfs': SILENT_DBFS})
            continue
        out.append({
            't0': t0,
            't1': t1,
            'peakDbfs': _dbfs(float(np.max(np.abs(seg)))),
            'rmsDbfs': _dbfs(float(np.sqrt(np.mean(seg ** 2)))),
        })
    return out

# WAV 读写（PCM 16/24/32/f32 支持；写固定 PCM16，字节级确定）
import wave
import numpy as np


def _to_float(raw: bytes, sampwidth: int, n_frames: int) -> np.ndarray:
    if sampwidth == 2:
        x = np.frombuffer(raw, dtype='<i2').astype(np.float32) / 32768.0
    elif sampwidth == 3:
        b = np.frombuffer(raw, dtype=np.uint8).reshape(-1, 3).astype(np.int32)
        v = b[:, 0] | (b[:, 1] << 8) | (b[:, 2] << 16)
        v = np.where(v >= 0x800000, v - 0x1000000, v).astype(np.float32)
        x = v / 8388608.0
    elif sampwidth == 4:
        x = np.frombuffer(raw, dtype='<i4').astype(np.float32) / 2147483648.0
    else:
        raise ValueError(f'不支持的位宽：{sampwidth * 8}')
    return x[: n_frames]


def read_wav(path: str) -> tuple:
    """返回 (samples float32[-1,1] (n,ch), sample_rate)。兼容 float32 WAV。"""
    with wave.open(path, 'rb') as w:
        ch = w.getnchannels()
        sw = w.getsampwidth()
        sr = w.getframerate()
        n = w.getnframes()
        raw = w.readframes(n)
        comptype = w.getcomptype()
        if comptype != 'NONE':
            raise ValueError(f'压缩 WAV 不支持：{comptype}')
        if sw == 4:
            # 可能是 PCM32 或 FLOAT32；用舍入启发式区分不可靠，按头部 fmt 判断
            # wave 模块不暴露 format tag，回退读原始块
            fmt = _read_fmt_tag(path)
            if fmt == 3:
                x = np.frombuffer(raw, dtype='<f4').astype(np.float32)[: n * ch]
            else:
                x = _to_float(raw, sw, n * ch)
        else:
            x = _to_float(raw, sw, n * ch)
    x = x.reshape(-1, ch)
    return x, sr


def _read_fmt_tag(path: str) -> int:
    with open(path, 'rb') as f:
        data = f.read(64)
    # RIFF/WAVE 头后依次块；找 fmt 块
    i = 12
    while i + 8 <= len(data):
        cid = data[i: i + 4]
        size = int.from_bytes(data[i + 4: i + 8], 'little')
        if cid == b'fmt ':
            return int.from_bytes(data[i + 8: i + 10], 'little')
        i += 8 + size + (size & 1)
    return 1


def to_mono(x: np.ndarray) -> np.ndarray:
    if x.ndim == 1:
        return x
    if x.shape[1] == 1:
        return x[:, 0]
    return x.mean(axis=1)


def write_wav(path: str, samples: np.ndarray, sr: int) -> dict:
    """写 PCM16 WAV。返回 {frames, peak, rms}。samples: float32 [-1,1] mono。"""
    x = np.clip(np.asarray(samples, dtype=np.float32), -1.0, 1.0)
    pcm = np.round(x * 32767.0).astype('<i2')
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())
    peak = float(np.max(np.abs(x))) if x.size else 0.0
    rms = float(np.sqrt(np.mean(x.astype(np.float64) ** 2))) if x.size else 0.0
    return {'frames': int(x.size), 'peak': peak, 'rms': rms, 'sr': sr}

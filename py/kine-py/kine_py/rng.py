# 确定性随机：字符串通道 → PCG64 生成器（跨进程/跨运行字节一致）
import numpy as np

_OFFSET = np.uint64(14695981039346656037)
_PRIME = np.uint64(1099511628211)
_MASK = np.uint64(0xFFFFFFFFFFFFFFFF)


def fnv1a64(s: str) -> int:
    h = _OFFSET
    for b in s.encode('utf-8'):
        h = (h ^ np.uint64(b)) * _PRIME & _MASK
    return int(h)


def rng_for(channel: str) -> np.random.Generator:
    return np.random.Generator(np.random.PCG64(fnv1a64(channel)))


def uniform(channel: str, n: int) -> np.ndarray:
    return rng_for(channel).uniform(0.0, 1.0, n).astype(np.float32)


def randn(channel: str, n: int) -> np.ndarray:
    return rng_for(channel).standard_normal(n).astype(np.float32)

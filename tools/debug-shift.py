"""调试：估计两帧之间的主导水平位移（整数搜索最小 L1），用于验证甩镜/位移转场"""
import sys
import numpy as np
from PIL import Image

a = np.asarray(Image.open(sys.argv[1]).convert('L')).astype(np.float32)
b = np.asarray(Image.open(sys.argv[2]).convert('L')).astype(np.float32)
# 文本行条带（y 880-935）与全屏两处
strips = {'text(y880-935)': (slice(880, 935), slice(0, 1920)),
          'hex(y220-600)': (slice(220, 600), slice(1000, 1700)),
          'full': (slice(0, 1080), slice(0, 1920))}
for name, (ys, xs) in strips.items():
    A = a[ys, xs]
    best = None
    for dx in range(-400, 401, 1):
        B = b[ys, xs]
        if dx >= 0:
            d = np.abs(A[:, dx:] - B[:, :B.shape[1] - dx]).mean()
        else:
            d = np.abs(A[:, :dx] - B[:, -dx:]).mean()
        if best is None or d < best[1]:
            best = (dx, d)
    # 零位移参考
    d0 = np.abs(A - B).mean()
    print(f'{name}: best dx={best[0]:+d} (L1={best[1]:.2f}) vs dx0 L1={d0:.2f}')

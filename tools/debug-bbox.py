"""调试：两帧差异的精确包围盒与行/列投影（直接脚本，非 sidecar）"""
import sys
import numpy as np
from PIL import Image

a = np.asarray(Image.open(sys.argv[1]).convert('RGB')).astype(np.int16)
b = np.asarray(Image.open(sys.argv[2]).convert('RGB')).astype(np.int16)
d = np.abs(a - b).max(axis=2)
mask = d > 8
print('diff ratio', mask.mean())
ys, xs = np.where(mask)
if len(ys):
    print('bbox x', xs.min(), xs.max(), 'y', ys.min(), ys.max())
# 每 108px 行带的占比
H, W = mask.shape
for y0 in range(0, H, 108):
    row = mask[y0:y0 + 108]
    print(f'y{y0:4d}-{y0+108:4d}', f'{row.mean()*100:6.2f}%', end='  ')
    for x0 in range(0, W, 384):
        print(f'{row[:, x0:x0+384].mean()*100:5.1f}', end=' ')
    print()

# 像素度量（PIL + numpy，纯函数；口径 RGB 0-255，不做色彩管理）
# density / frame_diff / edge_band / black_level / transition_spike / 拼图与网格诊断
import numpy as np
from PIL import Image, ImageDraw


def load_rgb(path: str) -> np.ndarray:
    im = Image.open(path).convert('RGB')
    return np.asarray(im, dtype=np.uint8)


def gray(x: np.ndarray) -> np.ndarray:
    return (0.299 * x[:, :, 0] + 0.587 * x[:, :, 1] + 0.114 * x[:, :, 2]).astype(np.float32)


def _grid_ratios(mask: np.ndarray, cols: int = 5, rows: int = 5) -> list:
    h, w = mask.shape
    out = []
    for r in range(rows):
        y0, y1 = h * r // rows, h * (r + 1) // rows
        for c in range(cols):
            x0, x1 = w * c // cols, w * (c + 1) // cols
            cell = mask[y0:y1, x0:x1]
            out.append(round(float(cell.mean()) if cell.size else 0.0, 5))
    return out


def density(path: str, lit: float = 40.0, invert: bool = False) -> dict:
    """内容密度：dark=灰度>40 像素占比；light(invert)=灰度<215 像素占比（浅底深画，v5）。"""
    x = load_rgb(path)
    g = gray(x)
    mask = g < (255.0 - lit) if invert else g > lit
    ratio = float(mask.mean())
    # 背景电平（dark：最暗 30% 像素；light：最亮 30%）
    flat = g.reshape(-1)
    k = max(1, int(flat.size * 0.30))
    idx = np.argpartition(flat, -k)[-k:] if invert else np.argpartition(flat, k)[:k]
    px = x.reshape(-1, 3)[idx]
    bg = [round(float(px[:, i].mean()), 2) for i in range(3)]
    # 5x5 网格热点 top3
    ratios = _grid_ratios(mask.astype(np.float32))
    order = np.argsort(ratios)[::-1][:3]
    hotspots = [{'row': int(i // 5), 'col': int(i % 5), 'ratio': ratios[i]} for i in order]
    return {'value': round(ratio, 6), 'litPixels': int(mask.sum()), 'total': int(mask.size), 'backgroundRgb': bg, 'hotspots': hotspots}


def frame_diff(path_a: str, path_b: str, eps: float = 8.0) -> dict:
    """帧间差：|Δ|>8 的像素占比（相隔 0.4s 时 <4% 判静态，由断言层解释）。"""
    a = load_rgb(path_a).astype(np.int16)
    b = load_rgb(path_b).astype(np.int16)
    d = np.abs(a - b).max(axis=2).astype(np.float32)
    mask = d > eps
    ratio = float(mask.mean())
    return {'value': round(ratio, 6), 'grid': _grid_ratios(mask.astype(np.float32))}


def edge_band(path: str, band: int = 34, lit: float = 40.0, invert: bool = False) -> dict:
    """最外 band px 环带内容占比（≤0.6 由断言层判定，检测贴边 HUD 被切）；light(invert) 以暗像素为内容。"""
    x = load_rgb(path)
    g = gray(x)
    h, w = g.shape
    b = min(band, h // 3, w // 3)
    mask = g < (255.0 - lit) if invert else g > lit
    top = mask[:b, :]
    bot = mask[-b:, :]
    left = mask[:, :b]
    right = mask[:, -b:]
    band_area = top.size + bot.size + left.size + right.size
    band_lit = int(top.sum() + bot.sum() + left.sum() + right.sum())
    ratio = band_lit / band_area if band_area else 0.0
    return {
        'value': round(float(ratio), 6),
        'band': b,
        'sides': {
            'top': round(float(top.mean()) if top.size else 0.0, 6),
            'bottom': round(float(bot.mean()) if bot.size else 0.0, 6),
            'left': round(float(left.mean()) if left.size else 0.0, 6),
            'right': round(float(right.mean()) if right.size else 0.0, 6),
        },
    }


def black_level(path: str, pick: str = 'dark') -> dict:
    """背景电平：dark=最暗 30% RGB 均值（黑电平 6-9 健康）；light=最亮 30%（白电平，浅色模式期望 ~235-252）。"""
    x = load_rgb(path)
    g = gray(x)
    flat = g.reshape(-1)
    k = max(1, int(flat.size * 0.30))
    idx = np.argpartition(flat, -k)[-k:] if pick == 'light' else np.argpartition(flat, k)[:k]
    px = x.reshape(-1, 3)[idx]
    rgb = [round(float(px[:, i].mean()), 3) for i in range(3)]
    return {'value': round(float(np.mean(rgb)), 3), 'rgb': rgb, 'maxChannel': round(max(rgb), 3)}


def transition_spike(paths: list, eps: float = 8.0, factor: float = 2.2, window: int = 3) -> dict:
    """转场孤立跳变：d_i > factor × 邻域均值（±window，排除自身）即命中。"""
    diffs = []
    prev = None
    for p in paths:
        cur = load_rgb(p).astype(np.int16)
        if prev is not None:
            d = np.abs(cur - prev).max(axis=2).astype(np.float32)
            diffs.append(float((d > eps).mean()))
        prev = cur
    hits = []
    for i, d in enumerate(diffs):
        nb = [diffs[j] for j in range(max(0, i - window), min(len(diffs), i + window + 1)) if j != i]
        if not nb:
            continue
        m = float(np.mean(nb))
        if m > 0 and d > factor * m:
            hits.append({'index': i, 'from': i, 'to': i + 1, 'ratio': round(d, 6), 'neighborhoodMean': round(m, 6)})
    return {'value': len(hits), 'diffs': [round(x, 6) for x in diffs], 'hits': hits}


def montage(paths: list, out: str, cols: int = 3, cell: int = 320, labels: list | None = None) -> dict:
    """接触表/拼图（诊断用，不作密度判据）。"""
    n = len(paths)
    if n == 0:
        raise ValueError('montage 无输入帧')
    rows = (n + cols - 1) // cols
    canvas = Image.new('RGB', (cols * cell, rows * cell), (10, 10, 14))
    d = ImageDraw.Draw(canvas)
    for i, p in enumerate(paths):
        im = Image.open(p).convert('RGB').resize((cell, cell), Image.LANCZOS)
        x0 = (i % cols) * cell
        y0 = (i // cols) * cell
        canvas.paste(im, (x0, y0))
        label = labels[i] if labels and i < len(labels) else str(i)
        d.rectangle([x0 + 2, y0 + 2, x0 + 2 + 10 * len(label), y0 + 16], fill=(0, 0, 0))
        d.text((x0 + 4, y0 + 4), label, fill=(255, 46, 63))
    canvas.save(out)
    return {'file': out, 'cols': cols, 'rows': rows, 'cell': cell, 'count': n}


def grid_overlay(path: str, out: str, cols: int = 5, rows: int = 5, highlights: list | None = None) -> dict:
    """在帧上叠加 5x5 网格（失败报告用），可高亮热点 cell。"""
    im = Image.open(path).convert('RGB')
    w, h = im.size
    d = ImageDraw.Draw(im)
    for c in range(1, cols):
        x = w * c // cols
        d.line([(x, 0), (x, h)], fill=(255, 46, 63), width=1)
    for r in range(1, rows):
        y = h * r // rows
        d.line([(0, y), (w, y)], fill=(255, 46, 63), width=1)
    for hl in highlights or []:
        r = int(hl.get('row', 0))
        c = int(hl.get('col', 0))
        d.rectangle([w * c // cols, h * r // rows, w * (c + 1) // cols, h * (r + 1) // rows], outline=(77, 163, 255), width=3)
    im.save(out)
    return {'file': out}

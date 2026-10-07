// @kine/runtime — 后处理（暗角/扫描线/白闪；永远贴在镜头变换之外，整屏绘制）
import { rgba } from './theme';
import type { ResolvedTheme } from './theme';
import type { PostState } from '@kine/dsl';

export function drawPost(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  theme: ResolvedTheme,
  post: PostState,
  mul?: { vignette?: number; scanline?: number; flash?: number },
): void {
  const mv = mul?.vignette ?? 1;
  const ms = mul?.scanline ?? 1;
  const mf = mul?.flash ?? 1;

  // 暗角
  const k = Math.max(0, Math.min(0.90, post.vignette * mv));
  if (k > 0.002) {
    const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.34, W / 2, H / 2, Math.max(W, H) * 0.72);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(1, `rgba(0,0,0,${k.toFixed(4)})`);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
  }

  // 扫描线（硬上限 0.12）
  const sl = Math.max(0, Math.min(0.12, post.scanline * ms));
  if (sl > 0.002) {
    ctx.fillStyle = rgba('#000000', sl * 0.55);
    const step = 3;
    for (let y = 0; y < H; y += step) ctx.fillRect(0, y, W, 1);
  }

  // 白闪（峰值 ≤ max_alpha）
  const fl = Math.max(0, post.flash * mf);
  if (fl > 0.001) {
    ctx.fillStyle = rgba(theme.text, fl);
    ctx.fillRect(0, 0, W, H);
  }
}

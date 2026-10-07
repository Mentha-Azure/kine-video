// @kine/runtime — Fx 层与幕级 effects（scanlines/vignette/grain/chroma/redbar/pulse）
//   光效 alpha ≤ 0.20（守黑电平）；chroma 仅用第二强调色且 ≤2 帧窗口（参数窗口由调用方保证）
import type { Rng } from '@kine/dsl';
import { rgba } from './theme';
import type { ResolvedTheme } from './theme';

export interface FxArgs {
  lt: number;
  T: number;
  W: number;
  H: number;
  theme: ResolvedTheme;
  rng: Rng;
  frame: number;
  channel: string;
}

const pNum = (params: Record<string, unknown>, key: string, d: number): number => {
  const v = params[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : d;
};

export function drawFx(ctx: CanvasRenderingContext2D, fx: string, params: Record<string, unknown>, a: FxArgs): void {
  const { W, H, theme, T } = a;
  switch (fx) {
    case 'scanlines': {
      const alpha = Math.min(0.2, pNum(params, 'alpha', 0.06));
      const step = Math.max(2, pNum(params, 'step', 3));
      ctx.fillStyle = rgba('#000000', alpha);
      for (let y = 0; y < H; y += step) ctx.fillRect(0, y, W, 1);
      return;
    }
    case 'vignette': {
      const k = Math.min(0.9, pNum(params, 'k', 0.35));
      const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.32, W / 2, H / 2, Math.max(W, H) * 0.72);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, `rgba(0,0,0,${k})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      return;
    }
    case 'grain': {
      const count = Math.min(1200, Math.max(0, pNum(params, 'count', 260))) | 0;
      const alpha = Math.min(0.2, pNum(params, 'alpha', 0.06));
      const size = Math.max(1, pNum(params, 'size', 1.5));
      ctx.fillStyle = rgba(theme.text, alpha);
      for (let i = 0; i < count; i++) {
        const seed = a.frame * count + i;
        const x = a.rng(a.channel + '.gx', seed) * W;
        const y = a.rng(a.channel + '.gy', seed) * H;
        ctx.fillRect(x, y, size, size);
      }
      return;
    }
    case 'chroma': {
      // 色差：整幅切片位移（用第二强调色 + accent，alpha 低）
      const slices = Math.max(1, Math.min(14, pNum(params, 'slices', 6))) | 0;
      const off = Math.max(1, pNum(params, 'offset', 3));
      const src = ctx.canvas;
      for (let i = 0; i < slices; i++) {
        const seed = a.frame * 7 + i * 13;
        const y = Math.floor(a.rng(a.channel + '.cy', seed) * H);
        const h = Math.max(2, Math.floor((0.01 + 0.05 * a.rng(a.channel + '.ch', seed)) * H));
        const y2 = Math.min(y, H - h);
        ctx.save();
        ctx.globalCompositeOperation = 'lighter';
        ctx.globalAlpha = 0.10;
        ctx.drawImage(src, 0, y2, W, h, off, y2, W, h);
        ctx.globalAlpha = 0.08;
        ctx.drawImage(src, 0, y2, W, h, -off, y2, W, h);
        ctx.restore();
      }
      // 蓝色提示线（≤2 帧窗口由调用方保证，这里只画一根细线）
      ctx.fillStyle = rgba(theme.accent2, 0.14);
      ctx.fillRect(0, (a.frame * 53) % H, W, 1);
      return;
    }
    case 'redbar': {
      const period = Math.max(0.4, pNum(params, 'period', 2.4));
      const width = Math.max(6, pNum(params, 'width', 0.045) * W);
      const alpha = Math.min(0.2, pNum(params, 'alpha', 0.16));
      const ph = (T % period) / period;
      const x = -width + (W + 2 * width) * ph;
      ctx.fillStyle = rgba(theme.accent, alpha);
      ctx.fillRect(x, 0, width, H);
      ctx.fillStyle = rgba(theme.text, alpha * 0.5);
      ctx.fillRect(x + width * 0.5, 0, Math.max(1, width * 0.06), H);
      return;
    }
    case 'pulse': {
      const period = Math.max(0.3, pNum(params, 'period', 1.2));
      const inset = Math.max(0, pNum(params, 'inset', 14));
      const ph = (T % period) / period;
      const wave = Math.sin(Math.PI * 2 * ph);
      const alpha = Math.min(0.2, pNum(params, 'alpha', 0.06) * (0.5 + 0.5 * wave));
      ctx.strokeStyle = rgba(theme.text, alpha);
      ctx.lineWidth = Math.max(1, 2 * (theme.S / 1080));
      ctx.strokeRect(inset, inset, W - 2 * inset, H - 2 * inset);
      return;
    }
    default:
      return;
  }
}

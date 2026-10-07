// @kine/widgets — 共享绘制工具（纯函数，禁 shadowBlur/滤镜/全局副作用）
import { rgba, type WidgetDrawCtx } from '@kine/runtime';

export const clamp = (x: number, a: number, b: number): number => Math.min(b, Math.max(a, x));
export const lerp = (a: number, b: number, u: number): number => a + (b - a) * u;
export const frac = (x: number): number => x - Math.floor(x);
export const smooth = (u: number): number => {
  const x = clamp(u, 0, 1);
  return x * x * (3 - 2 * x);
};

/** 周期性相位 [0,1) */
export const phase = (t: number, period: number): number => frac(t / Math.max(0.001, period));

/** 字体串（等宽纪律：直接用主题字体族；fontScale 全局字级系数在此统一放大） */
export function font(c: WidgetDrawCtx, size: number, weight = 400): string {
  return `${weight} ${(size * c.theme.fontScale).toFixed(2)}px ${c.theme.font}`;
}

/** 主文字色（含 alpha） */
export function textColor(c: WidgetDrawCtx, alpha = 1): string {
  return rgba(c.theme.text, alpha);
}

/** 本地坐标盒内布局：把 [0..w]×[0..h] 映射到 padding 内的网格 */
export interface Grid {
  x: (i: number) => number;
  y: (i: number) => number;
  cw: number;
  ch: number;
}

export function gridOf(w: number, h: number, cols: number, rows: number, pad = 0): Grid {
  const cw = (w - pad * 2) / cols;
  const ch = (h - pad * 2) / rows;
  return { x: (i) => pad + i * cw, y: (i) => pad + i * ch, cw, ch };
}

/** 圆角矩形路径（兼容性手绘，不用 roundRect） */
export function rr(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rad = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rad, y);
  ctx.lineTo(x + w - rad, y);
  ctx.arcTo(x + w, y, x + w, y + rad, rad);
  ctx.lineTo(x + w, y + h - rad);
  ctx.arcTo(x + w, y + h, x + w - rad, y + h, rad);
  ctx.lineTo(x + rad, y + h);
  ctx.arcTo(x, y + h, x, y + h - rad, rad);
  ctx.lineTo(x, y + rad);
  ctx.arcTo(x, y, x + rad, y, rad);
  ctx.closePath();
}

/** 确定性字符序列（供 hex/符号流使用） */
const HEXD = '0123456789ABCDEF';
const SYMS = '@#$%&*+=<>/\\|{}[]();:~^!?';

export function hexByte(v: number): string {
  const x = Math.floor(clamp(v, 0, 1) * 255.999);
  return HEXD[(x >> 4) & 15] + HEXD[x & 15];
}

export function symChar(v: number): string {
  return SYMS[Math.floor(clamp(v, 0, 0.9999) * SYMS.length)];
}

/** 文本淡出条带（数字读数用）：返回 [0,1] 变化时的闪烁透明度 */
export function tickBlink(t: number, rate: number): number {
  const f = frac(t * rate);
  return f < 0.12 ? 1 - f / 0.12 : 1;
}

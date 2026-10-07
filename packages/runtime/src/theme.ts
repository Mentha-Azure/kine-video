// @kine/runtime — 主题解析与色彩工具
import type { ThemeSpecT } from '@kine/dsl';

export interface ResolvedTheme {
  bg: [string, string];
  text: string;
  textDim: string;
  accent: string;
  accent2: string;
  accent2MaxFrames: number;
  font: string;
  fontScale: number;
  fontBase: number;
  post: ThemeSpecT['post'];
  /** 排版基准 S = min(W,H) */
  S: number;
  W: number;
  H: number;
}

export function resolveTheme(theme: ThemeSpecT, W: number, H: number): ResolvedTheme {
  return {
    bg: [theme.bg[0], theme.bg[1]],
    text: theme.text,
    textDim: theme.text_dim,
    accent: theme.accent,
    accent2: theme.accent_secondary.color,
    accent2MaxFrames: theme.accent_secondary.max_frames,
    font: theme.font.family,
    fontScale: theme.font.scale,
    fontBase: theme.font.base,
    post: theme.post,
    S: Math.min(W, H),
    W,
    H,
  };
}

/** #rrggbb → [r,g,b] */
export function hexRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

/** #rrggbb + alpha → rgba() 串 */
export function rgba(hex: string, a: number): string {
  const [r, g, b] = hexRgb(hex);
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a))})`;
}

/** 两色线性混合（用于渐变加深） */
export function mixHex(a: string, b: string, t: number): string {
  const [r1, g1, b1] = hexRgb(a);
  const [r2, g2, b2] = hexRgb(b);
  const f = (x: number, y: number) => Math.round(x + (y - x) * Math.max(0, Math.min(1, t)));
  return `#${[f(r1, r2), f(g1, g2), f(b1, b2)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

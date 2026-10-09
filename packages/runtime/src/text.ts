// @kine/runtime — 文本层（打字机；type_period 秒/字符）
import { rgba } from './theme';
import type { ResolvedTheme } from './theme';
import type { TextLayerT } from '@kine/dsl';

export interface TextDrawResult {
  box: { x: number; y: number; w: number; h: number };
  visibleChars: number;
  state: string;
  measure: Record<string, number>;
}

const smooth = (x: number) => {
  const c = Math.max(0, Math.min(1, x));
  return c * c * (3 - 2 * c);
};

// v4：文本插值（确定性；第 N 帧 = f(N)）——支持 {frame} {t} {T} {lt}，可带格式如 {t:.2f}；含 '{' 才进入插值（旧工程零变化）
export interface TextInterpEnv {
  frame: number;
  t: number;
  T: number;
  lt: number;
}

const INTERP_RE = /\{(frame|t|T|lt)(?::\.([0-9])f)?\}/g;

export function interpolateText(content: string, env: TextInterpEnv): string {
  if (!content.includes('{')) return content;
  return content.replace(INTERP_RE, (_m, key: string, digits?: string) => {
    const d = digits === undefined ? 2 : Number(digits);
    if (key === 'frame') return String(Math.max(0, Math.round(env.frame)));
    const v = key === 't' ? env.t : key === 'T' ? env.T : env.lt;
    return v.toFixed(d);
  });
}

/**
 * 在局部坐标绘制文本（调用方已 translate 到锚点）。
 * - centerX=true：整块文本在锚点处水平居中（place.anchor=center）
 * - 否则按 layer.style.align 相对锚点对齐（left/center/right 均相对锚点）
 */
export function drawTextLayer(
  ctx: CanvasRenderingContext2D,
  layer: TextLayerT,
  lt: number,
  theme: ResolvedTheme,
  boxW: number,
  opts?: { centerX?: boolean; frame?: number; t?: number; T?: number },
): TextDrawResult {
  const ds = theme.S / 1080;
  const px = (layer.style.size || 1) * theme.fontBase * theme.fontScale * ds * 1.06;
  ctx.font = `${layer.style.weight} ${px}px ${theme.font}`;
  ctx.textBaseline = 'top';
  const color = layer.style.color ?? theme.text;

  const content = interpolateText(layer.content, {
    frame: opts?.frame ?? 0,
    t: opts?.t ?? 0,
    T: opts?.T ?? 0,
    lt,
  });
  const total = content.length;
  let visible = total;
  let typing = false;
  if (layer.type_period > 0) {
    visible = Math.min(total, Math.floor(lt / layer.type_period));
    typing = visible < total;
  }
  const text = content.slice(0, visible);

  const maxW = layer.style.max_width ? layer.style.max_width * ds : boxW;
  const lineH = px * 1.4;
  const lines: string[] = [];
  if (layer.style.max_width) {
    let cur = '';
    for (const chg of text) {
      const test = cur + chg;
      if (ctx.measureText(test).width > maxW && cur.length > 0) {
        lines.push(cur);
        cur = chg;
      } else cur = test;
    }
    lines.push(cur);
  } else {
    lines.push(...text.split('\n'));
  }

  let lineW = 0;
  for (const l of lines) lineW = Math.max(lineW, ctx.measureText(l).width);
  const blockW = lineW;

  const lineX = (lw: number): number => {
    if (opts?.centerX) return -blockW / 2;
    const align = layer.style.align;
    if (align === 'center') return -blockW / 2;
    if (align === 'right') return -blockW;
    return 0;
  };
  const innerAlign = opts?.centerX ? 'left' : layer.style.align;
  const innerX = (lw: number): number => {
    if (innerAlign === 'center') return (blockW - lw) / 2;
    if (innerAlign === 'right') return blockW - lw;
    return 0;
  };

  ctx.fillStyle = color;
  for (let i = 0; i < lines.length; i++) {
    const lw = ctx.measureText(lines[i]).width;
    ctx.fillText(lines[i], lineX(lw) + innerX(lw), i * lineH);
  }
  let cursorW = 0;
  if (typing) {
    const lastW = ctx.measureText(lines[lines.length - 1]).width;
    const blink = 0.5 + 0.5 * Math.sin(Math.PI * 2 * (lt * 1.4));
    ctx.globalAlpha = 0.35 + 0.5 * blink;
    ctx.fillText('▍', lineX(lastW) + innerX(lastW) + lastW + px * 0.08, (lines.length - 1) * lineH);
    cursorW = px * 0.7;
    ctx.globalAlpha = 1;
  }

  const boxX = opts?.centerX ? -blockW / 2 : lineX(blockW);
  const state = typing ? 'typing' : 'done';
  return {
    box: { x: boxX, y: 0, w: blockW + cursorW, h: lines.length * lineH },
    visibleChars: visible,
    state,
    measure: {
      text_period: layer.type_period,
      chars_visible: visible,
      chars_total: total,
      line_height: +lineH.toFixed(2),
    },
  };
}

export { smooth, rgba };

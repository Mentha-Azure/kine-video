// @kine/runtime — widget 注册表与绘制契约
//   契约（03 文档 §3.7）：draw 必须是 (ctx, t, props, theme, rng) 的纯函数——
//   同一 (t, props, seed) 任意次调用结果一致；禁止 Math.random / Date.now / 累积状态。
import type { ResolvedTheme } from './theme';
import type { Rng } from '@kine/dsl';

export interface WidgetEnv {
  /** 画布宽高 */
  W: number;
  H: number;
  /** 排版基准 S=min(W,H) */
  S: number;
  /** 帧号（成片帧号，0-based；供 rng 索引） */
  frame: number;
  /** deviceScale = S/1080，widget 的“设计像素”统一乘它 */
  ds: number;
}

export interface WidgetProbe {
  state?: string;
  measure?: Record<string, number>;
}

export interface WidgetDrawCtx {
  ctx: CanvasRenderingContext2D;
  /** 图层 id（widget 内部 rng 通道命名用，保证实例级确定性） */
  id: string;
  /** 幕内动画时钟 lt（秒） */
  t: number;
  props: Record<string, unknown>;
  theme: ResolvedTheme;
  rng: Rng;
  env: WidgetEnv;
  /** 本 widget 的绘制盒（局部坐标 0,0 为左上角） */
  w: number;
  h: number;
  report(p: WidgetProbe): void;
}

export interface WidgetDef {
  name: string;
  /** 设计尺寸（1080p 基准像素）；place.w/h 缺省时使用 */
  defaultSize: { w: number; h: number };
  draw(c: WidgetDrawCtx): void;
}

const registry = new Map<string, WidgetDef>();

export function registerWidget(def: WidgetDef): void {
  registry.set(def.name, def);
}

export function getWidget(name: string): WidgetDef | undefined {
  return registry.get(name);
}

export function listWidgets(): string[] {
  return [...registry.keys()].sort();
}

/** props 取值工具（带类型收敛，widget 内部统一走它） */
export function P(props: Record<string, unknown>, key: string, fallback: number): number;
export function P(props: Record<string, unknown>, key: string, fallback: string): string;
export function P(props: Record<string, unknown>, key: string, fallback: number | string): number | string;
export function P(props: Record<string, unknown>, key: string, fallback: number | string | boolean): number | string | boolean {
  const v = props[key];
  if (v === undefined || v === null) return fallback;
  return v as number | string | boolean;
}

export function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

export function str(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

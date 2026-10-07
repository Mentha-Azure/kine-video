// @kine/runtime — 浏览器侧类型（与 @kine/dsl 的 KineIR 结构一致；type-only 引用，不进 bundle）
import type { KineIR, CompiledScene, CompiledShot } from '@kine/dsl';

export type { KineIR, CompiledScene, CompiledShot };

/** 元素探针（实测包围盒 + 可量参照物） */
export interface ProbeElement {
  id: string;
  kind: string;
  widget?: string;
  /** 屏坐标包围盒（已应用镜头变换） */
  box: { x: number; y: number; w: number; h: number };
  alpha: number;
  state?: string;
  measure?: Record<string, number>;
}

export interface ProbeResult {
  t: number;
  T: number;
  frame: number;
  scene: { id: string; name?: string; index: number; lt: number };
  camera: {
    z1: number; dx: number; dy: number; roll: number; tw: number;
    mot: number; beatPhase: number; flash2: number;
  };
  post: { vignette: number; scanline: number; flash: number };
  transition: { kind: number; name: string; variant: number; d: number } | null;
  elements: ProbeElement[];
  effects: { fx: string; active: boolean }[];
}

export interface FrameAssets {
  /** src → 已解码图像（image 图层用） */
  images?: Map<string, TexImageSource>;
  /** src → 视频元素（video 图层用；seek 语义非确定，仅 best-effort） */
  videos?: Map<string, HTMLVideoElement>;
}

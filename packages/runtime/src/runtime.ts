// @kine/runtime — window.__kine 契约实现（04 文档 §4.1）
//   jump(T)：由 T 全量重算（jump 前重置叠加态，不依赖上一帧）
//   probe(T)：实测元素包围盒/状态/可量参照物
//   stateHash(T)：帧语义状态 hash（缓存与回归用，非像素 hash）
import { hash64 } from '@kine/dsl/rand';
import type { KineIR } from '@kine/dsl';
import { drawFrame, type FrameReport } from './compositor';
import type { FrameAssets, ProbeElement, ProbeResult } from './types';

export interface KineRuntime {
  readonly canvas: HTMLCanvasElement;
  load(ir: KineIR, opts?: { assets?: FrameAssets }): void;
  getIR(): KineIR | null;
  jump(T: number): FrameReport;
  probe(T: number): ProbeResult & { report: FrameReport };
  stateHash(T: number): string;
  setSeed(seed: number): void;
  /** 已加载资产（渲染管线预加载后注入） */
  assets: FrameAssets;
}

interface RuntimeState {
  ir: KineIR | null;
  seed: number | null;
  debugEl: HTMLElement | null;
}

export function createRuntime(canvas: HTMLCanvasElement, opts?: { debug?: boolean }): KineRuntime {
  let st: RuntimeState = { ir: null, seed: null, debugEl: null };
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('2d context unavailable');

  const state: KineRuntime = {
    canvas,
    assets: {},
    load(ir, o) {
      st.ir = ir;
      st.seed = null;
      if (canvas.width !== ir.output.width || canvas.height !== ir.output.height) {
        canvas.width = ir.output.width;
        canvas.height = ir.output.height;
      }
      if (o?.assets) state.assets = o.assets;
      if (opts?.debug) {
        if (!st.debugEl) {
          st.debugEl = document.createElement('div');
          st.debugEl.id = 'kine-readout';
          st.debugEl.style.cssText = 'position:fixed;left:8px;bottom:8px;font:12px/1.4 monospace;color:#8a8a92;background:rgba(0,0,0,.55);padding:2px 6px;z-index:9;pointer-events:none';
          if (typeof document.body !== 'undefined') document.body.appendChild(st.debugEl);
        }
      }
    },
    getIR() {
      return st.ir;
    },
    setSeed(seed) {
      st.seed = seed;
    },
    jump(T) {
      if (!st.ir) throw new Error('runtime not loaded: call load(ir) first');
      // jump 先重置叠加态（坑 8.6：旧 DOM/叠加残留）
      if (st.debugEl) st.debugEl.textContent = '';
      const report = drawFrame(ctx, { ir: st.ir, T, assets: state.assets, seed: st.seed ?? undefined });
      if (st.debugEl) {
        st.debugEl.textContent = `t=${report.t.toFixed(3)} T=${report.T.toFixed(3)} frame=${report.frame} scene=${report.scene.id} lt=${report.scene.lt.toFixed(3)}`;
      }
      return report;
    },
    probe(T) {
      if (!st.ir) throw new Error('runtime not loaded: call load(ir) first');
      const elements: ProbeElement[] = [];
      const report = drawFrame(ctx, { ir: st.ir, T, assets: state.assets, collect: (el) => elements.push(el), seed: st.seed ?? undefined });
      return {
        t: report.t,
        T: report.T,
        frame: report.frame,
        scene: { id: report.scene.id, name: report.scene.name, index: report.scene.index, lt: report.scene.lt },
        camera: {
          z1: report.camera.z1, dx: report.camera.dx, dy: report.camera.dy, roll: report.camera.roll,
          tw: report.camera.tw, mot: report.camera.mot, beatPhase: report.camera.beatPhase, flash2: report.camera.flash2,
        },
        post: report.post,
        transition: report.transition,
        elements,
        effects: report.effects,
        report,
      };
    },
    stateHash(T) {
      if (!st.ir) throw new Error('runtime not loaded: call load(ir) first');
      const elements: ProbeElement[] = [];
      const report = drawFrame(ctx, { ir: st.ir, T, assets: state.assets, collect: (el) => elements.push(el), seed: st.seed ?? undefined });
      const r = (x: number, n = 5) => +x.toFixed(n);
      const canon = JSON.stringify({
        t: r(report.t, 6),
        T: r(report.T, 6),
        f: report.frame,
        s: report.scene.id,
        lt: r(report.scene.lt, 6),
        si: report.shotIndex,
        cam: [r(report.camera.z1, 6), r(report.camera.dx, 4), r(report.camera.dy, 4), r(report.camera.roll, 5), r(report.camera.flash2, 5), r(report.camera.mot, 5)],
        tr: report.transition ? [report.transition.kind, report.transition.variant, r(report.transition.d, 4)] : null,
        post: [r(report.post.vignette, 4), r(report.post.scanline, 4), r(report.post.flash, 5)],
        el: elements.map((e) => [e.id, r(e.box.x, 2), r(e.box.y, 2), r(e.box.w, 2), r(e.box.h, 2), r(e.alpha, 3), e.state ?? '', e.measure ? Object.entries(e.measure).sort().map(([k, v]) => `${k}=${typeof v === 'number' ? r(v, 4) : v}`).join(',') : '']),
      });
      return hash64(canon);
    },
  };
  return state;
}

export { drawFrame } from './compositor';
export type { FrameReport } from './compositor';
export type { ProbeElement, ProbeResult, FrameAssets } from './types';

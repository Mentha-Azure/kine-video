// @kine/runtime — 合成分帧器：第 N 帧 = f(N)。jump(T) 由此全量重算，实现 L-PURE-002。
//   绘制顺序（04 文档）：bg → save → 镜头变换 → 远层粒子 → 内容层 → 近层粒子 → restore → 幕头 fx → 后处理
import { TtoT, sceneAtT, sceneLt } from '@kine/dsl/time';
import { cameraAt, postAt, type CameraState, type PostState } from '@kine/dsl/camera';
import { makeRng, type Rng } from '@kine/dsl/rand';
import type { KineIR, CompiledScene, LayerSpecT } from '@kine/dsl';
import { resolveTheme, rgba, type ResolvedTheme } from './theme';
import { getWidget } from './widgets-api';
import { drawParticles } from './particles';
import { drawTextLayer } from './text';
import { drawFx } from './effects';
import { drawTransition, type TransitionView } from './transitions';
import { drawPost } from './post';
import type { FrameAssets, ProbeElement } from './types';

export interface DrawFrameOptions {
  ir: KineIR;
  T: number;
  assets?: FrameAssets;
  /** 元素探针收集器（仅记录“新视图”的元素） */
  collect?: (el: ProbeElement) => void;
  /** seed 覆盖（默认 ir.project.seed） */
  seed?: number;
}

export interface FrameReport {
  t: number;
  T: number;
  frame: number;
  seg: string;
  scene: { id: string; name?: string; index: number; lt: number };
  camera: CameraState;
  post: PostState;
  transition: { kind: number; name: string; variant: number; d: number } | null;
  effects: { fx: string; active: boolean }[];
  shotIndex: number;
  layerCount: number;
}

const EPS = 1e-9;
const HEAD_FX_DUR = 0.24;

// 转场用的两张离屏快照（复用，避免 GC 抖动）
let scratchA: HTMLCanvasElement | null = null;
let scratchB: HTMLCanvasElement | null = null;
let scratchACtx: CanvasRenderingContext2D | null = null;
let scratchBCtx: CanvasRenderingContext2D | null = null;

function getScratch(W: number, H: number): [HTMLCanvasElement, CanvasRenderingContext2D, HTMLCanvasElement, CanvasRenderingContext2D] {
  if (!scratchA || scratchA.width !== W || scratchA.height !== H) {
    scratchA = document.createElement('canvas');
    scratchA.width = W;
    scratchA.height = H;
    scratchACtx = scratchA.getContext('2d');
    scratchB = document.createElement('canvas');
    scratchB.width = W;
    scratchB.height = H;
    scratchBCtx = scratchB.getContext('2d');
  }
  return [scratchA!, scratchACtx!, scratchB!, scratchBCtx!];
}

function smooth(x: number): number {
  const c = Math.max(0, Math.min(1, x));
  return c * c * (3 - 2 * c);
}

/** 图层不透明度（window + fade_in/out） */
export function layerOpacity(layer: LayerSpecT, lt: number, sceneDur: number): number {
  const [w0, w1] = layer.window ?? [0, sceneDur];
  if (lt < w0 - EPS || lt > w1 + EPS) return 0;
  let a = 1;
  if (layer.fade_in > 0) a *= smooth((lt - w0) / layer.fade_in);
  if (layer.fade_out > 0) a *= smooth((w1 - lt) / layer.fade_out);
  return Math.max(0, Math.min(1, a));
}

interface ViewArgs {
  scene: CompiledScene;
  layers: LayerSpecT[];
  lt: number;
  cam: CameraState;
  theme: ResolvedTheme;
  rng: Rng;
  assets?: FrameAssets;
  frame: number;
  T: number;
  collect?: (el: ProbeElement) => void;
  W: number;
  H: number;
}

function drawView(ctx: CanvasRenderingContext2D, v: ViewArgs): void {
  const { W, H, theme, cam, lt } = v;
  const ds = theme.S / 1080;
  ctx.save();
  ctx.translate(W / 2 + cam.dx * ds, H / 2 + cam.dy * ds);
  ctx.rotate((cam.roll * Math.PI) / 180);
  ctx.scale(cam.z1, cam.z1);
  ctx.translate(-W / 2, -H / 2);

  for (const layer of v.layers) {
    if (layer.kind === 'particles' && layer.depth === 'far') {
      const a = layerOpacity(layer, lt, v.scene.dur);
      if (a <= 0.004) continue;
      ctx.globalAlpha = a;
      ctx.save();
      drawParticles(ctx, layer, { T: v.T, theme, rng: v.rng, W, H });
      ctx.restore();
      ctx.globalAlpha = 1;
    }
  }

  for (const layer of v.layers) {
    if (layer.kind === 'particles') continue;
    drawLayer(ctx, layer, v);
  }

  for (const layer of v.layers) {
    if (layer.kind === 'particles' && layer.depth === 'near') {
      const a = layerOpacity(layer, lt, v.scene.dur);
      if (a <= 0.004) continue;
      ctx.globalAlpha = a;
      ctx.save();
      drawParticles(ctx, layer, { T: v.T, theme, rng: v.rng, W, H });
      ctx.restore();
      ctx.globalAlpha = 1;
    }
  }

  ctx.restore();
}

function recordBox(
  ctx: CanvasRenderingContext2D,
  collect: ((el: ProbeElement) => void) | undefined,
  el: Omit<ProbeElement, 'box'>,
  local: { x: number; y: number; w: number; h: number },
): void {
  if (!collect) return;
  const m = ctx.getTransform();
  const xs: number[] = [];
  const ys: number[] = [];
  for (const [px, py] of [[local.x, local.y], [local.x + local.w, local.y], [local.x, local.y + local.h], [local.x + local.w, local.y + local.h]]) {
    xs.push(m.a * px + m.c * py + m.e);
    ys.push(m.b * px + m.d * py + m.f);
  }
  const x = Math.min(...xs), y = Math.min(...ys);
  collect({ ...el, box: { x: +x.toFixed(2), y: +y.toFixed(2), w: +(Math.max(...xs) - x).toFixed(2), h: +(Math.max(...ys) - y).toFixed(2) } });
}

function drawLayer(ctx: CanvasRenderingContext2D, layer: LayerSpecT, v: ViewArgs): void {
  const { theme, lt, W, H } = v;
  const ds = theme.S / 1080;
  const alpha = layerOpacity(layer, lt, v.scene.dur);
  if (alpha <= 0.004) return;

  switch (layer.kind) {
    case 'widget': {
      const def = getWidget(layer.widget);
      const pw = layer.place.w != null ? layer.place.w * ds : undefined;
      const ph = layer.place.h != null ? layer.place.h * ds : undefined;
      const bw = pw ?? (def?.defaultSize.w ?? 320) * ds;
      const bh = ph ?? (def?.defaultSize.h ?? 200) * ds;
      const ox = layer.place.anchor === 'center' ? layer.place.x * ds - bw / 2 : layer.place.x * ds;
      const oy = layer.place.anchor === 'center' ? layer.place.y * ds - bh / 2 : layer.place.y * ds;
      ctx.save();
      ctx.translate(ox, oy);
      ctx.globalAlpha = alpha;
      let state: string | undefined = def ? undefined : 'unknown-widget';
      let measure: Record<string, number> | undefined;
      if (def) {
        def.draw({
          ctx,
          id: layer.id,
          t: lt,
          props: layer.props,
          theme,
          rng: v.rng,
          env: { W, H, S: theme.S, frame: v.frame, ds },
          w: bw,
          h: bh,
          report: (p) => {
            if (p.state !== undefined) state = p.state;
            if (p.measure !== undefined) measure = p.measure;
          },
        });
      } else {
        ctx.strokeStyle = rgba(theme.accent, 0.6);
        ctx.lineWidth = 2;
        ctx.strokeRect(0, 0, bw, bh);
        ctx.fillStyle = rgba(theme.textDim, 0.8);
        ctx.font = `${14 * ds}px ${theme.font}`;
        ctx.fillText(`? ${layer.widget}`, 8 * ds, 20 * ds);
      }
      recordBox(ctx, v.collect, { id: layer.id, kind: 'widget', widget: layer.widget, alpha: +alpha.toFixed(4), state, measure }, { x: 0, y: 0, w: bw, h: bh });
      ctx.restore();
      return;
    }
    case 'text': {
      const bw = (layer.place.w ?? layer.style.max_width ?? (W * 0.6) / ds) * ds;
      const centerX = layer.place.anchor === 'center';
      ctx.save();
      ctx.translate(layer.place.x * ds, layer.place.y * ds);
      ctx.globalAlpha = alpha;
      const res = drawTextLayer(ctx, layer, lt, theme, bw, { centerX });
      recordBox(
        ctx,
        v.collect,
        { id: layer.id, kind: 'text', alpha: +alpha.toFixed(4), state: res.state, measure: res.measure },
        { x: res.box.x, y: 0, w: res.box.w, h: res.box.h },
      );
      ctx.restore();
      return;
    }
    case 'image':
    case 'video': {
      const src = layer.src;
      const img = layer.kind === 'image' ? v.assets?.images?.get(src) : v.assets?.videos?.get(src);
      const place = layer.place;
      const natural: { w: number; h: number } = img
        ? { w: (img as { naturalWidth?: number; videoWidth?: number; width?: number }).naturalWidth ?? (img as { videoWidth?: number }).videoWidth ?? (img as { width: number }).width ?? 640,
            h: (img as { naturalHeight?: number; videoHeight?: number; height?: number }).naturalHeight ?? (img as { videoHeight?: number }).videoHeight ?? (img as { height: number }).height ?? 360 }
        : { w: 640, h: 360 };
      const bw = (place.w ?? natural.w) * ds;
      const bh = (place.h ?? natural.h) * ds;
      const ox = place.anchor === 'center' ? place.x * ds - bw / 2 : place.x * ds;
      const oy = place.anchor === 'center' ? place.y * ds - bh / 2 : place.y * ds;
      ctx.save();
      ctx.translate(ox, oy);
      ctx.globalAlpha = alpha;
      let state = 'ok';
      if (!img) {
        state = 'missing-asset';
        ctx.strokeStyle = rgba(theme.accent, 0.5);
        ctx.lineWidth = 2;
        ctx.strokeRect(0, 0, bw, bh);
        ctx.fillStyle = rgba(theme.textDim, 0.8);
        ctx.font = `${16 * ds}px ${theme.font}`;
        ctx.fillText(`missing: ${src}`, 8 * ds, 24 * ds);
      } else {
        const scale = layer.fit === 'cover' ? Math.max(bw / natural.w, bh / natural.h) : Math.min(bw / natural.w, bh / natural.h);
        const dw = natural.w * scale;
        const dh = natural.h * scale;
        ctx.drawImage(img as CanvasImageSource, (bw - dw) / 2, (bh - dh) / 2, dw, dh);
        if (layer.kind === 'video') state = 'video-seek';
      }
      recordBox(ctx, v.collect, { id: layer.id, kind: layer.kind, alpha: +alpha.toFixed(4), state }, { x: 0, y: 0, w: bw, h: bh });
      ctx.restore();
      return;
    }
    case 'fx': {
      ctx.save();
      ctx.globalAlpha = alpha;
      drawFx(ctx, layer.fx, layer.params, {
        lt,
        T: v.T,
        W, H, theme, rng: v.rng, frame: v.frame,
        channel: `fx.${layer.id}`,
      });
      ctx.restore();
      return;
    }
    default:
      return;
  }
}

export function drawFrame(ctx: CanvasRenderingContext2D, o: DrawFrameOptions): FrameReport {
  const { ir } = o;
  const W = ir.output.width;
  const H = ir.output.height;
  const map = ir.time.map;
  const theme = resolveTheme(ir.theme, W, H);
  const seed = o.seed ?? ir.project.seed;
  const rng = makeRng(seed);

  const T = Math.max(0, Math.min(map.durationT, o.T));
  const t = Math.max(0, Math.min(map.duration, TtoT(map, T)));
  const frame = Math.max(0, Math.min(map.frames - 1, Math.round(t * map.fps)));
  const timeScene = sceneAtT(map, T);
  let sceneIndex = ir.scenes.findIndex((s) => s.id === timeScene.id);
  if (sceneIndex < 0) sceneIndex = ir.scenes.length - 1;
  const scene = ir.scenes[sceneIndex];
  const lt = Math.max(0, Math.min(scene.dur, sceneLt(timeScene, T)));

  // 镜头定位（先于相机：镜头 camera_override 决定当前相机）
  const shots = scene.shots;
  let shotIndex = -1;
  if (shots.length > 0) {
    shotIndex = shots.length - 1;
    for (let i = 0; i < shots.length; i++) {
      if (lt < shots[i].lt1 - EPS) { shotIndex = i; break; }
    }
  }
  const curShot = shotIndex >= 0 ? shots[shotIndex] : null;
  const cam = cameraAt(curShot?.camera ?? scene.camera, { T, lt, seed, S: theme.S });

  // 背景
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  const bg = ctx.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, theme.bg[0]);
  bg.addColorStop(1, theme.bg[1]);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();

  // 转场
  let transition: TransitionView | null = null;
  if (curShot && curShot.transition && curShot.transition.dur > 0 && shotIndex > 0 && lt < curShot.lt0 + curShot.transition.dur + EPS) {
    const d = Math.max(0, Math.min(1, (lt - curShot.lt0) / curShot.transition.dur));
    transition = { kind: curShot.transition.kind, name: curShot.transition.name, variant: curShot.transition.variant, d };
  }

  const layersOf = (shot: typeof curShot): LayerSpecT[] => {
    if (!shot || !shot.on) return scene.layers;
    return scene.layers.filter((l) => shot.on!.includes(l.id));
  };

  if (transition) {
    const prevShot = shots[shotIndex - 1];
    const [scrA, scrACtx, scrB, scrBCtx] = getScratch(W, H);
    const ltOld = Math.max(prevShot.lt0, prevShot.lt1 - 1e-3);
    const camOld = cameraAt(prevShot.camera, { T: prevShot.T1 - 1e-3, lt: ltOld, seed, S: theme.S });
    scrACtx.setTransform(1, 0, 0, 1, 0, 0);
    scrACtx.globalAlpha = 1;
    scrACtx.fillStyle = theme.bg[0];
    scrACtx.fillRect(0, 0, W, H);
    drawView(scrACtx, { scene, layers: layersOf(prevShot), lt: ltOld, cam: camOld, theme, rng, assets: o.assets, frame, T: prevShot.T1 - 1e-3, W, H });
    scrBCtx.setTransform(1, 0, 0, 1, 0, 0);
    scrBCtx.globalAlpha = 1;
    scrBCtx.fillStyle = theme.bg[0];
    scrBCtx.fillRect(0, 0, W, H);
    drawView(scrBCtx, { scene, layers: layersOf(curShot), lt, cam, theme, rng, assets: o.assets, frame, T, collect: o.collect, W, H });
    drawTransition(ctx, scrA, scrB, transition, theme, W, H);
  } else {
    drawView(ctx, { scene, layers: layersOf(curShot), lt, cam, theme, rng, assets: o.assets, frame, T, collect: o.collect, W, H });
  }

  // 幕级 effects
  const effects: { fx: string; active: boolean }[] = [];
  for (const ef of scene.effects) {
    const [w0, w1] = ef.window ?? [0, scene.dur];
    const active = lt >= w0 - EPS && lt <= w1 + EPS;
    effects.push({ fx: ef.fx, active });
    if (active) {
      ctx.save();
      drawFx(ctx, ef.fx, ef.params ?? {}, { lt, T, W, H, theme, rng, frame, channel: `fx.scene.${scene.id}.${ef.fx}` });
      ctx.restore();
    }
  }

  // 幕头 fx（红条白闪 0.24s，统一在幕边界）
  let headFlash = 0;
  if (sceneIndex > 0 && lt < HEAD_FX_DUR) {
    const p = lt / HEAD_FX_DUR;
    const ease = 1 - Math.pow(1 - p, 3);
    const barW = Math.max(10, W * 0.014);
    const x = -barW * 2 + (W + 4 * barW) * ease;
    ctx.save();
    ctx.fillStyle = rgba(theme.accent, 0.55 * (1 - p) * (1 - p));
    ctx.fillRect(x - barW / 2, 0, barW, H);
    ctx.fillStyle = rgba(theme.text, 0.6 * (1 - p) * (1 - p));
    ctx.fillRect(x + barW * 0.4, 0, Math.max(1, barW * 0.12), H);
    ctx.restore();
    headFlash = Math.pow(1 - p, 2);
  }

  // 后处理（永远贴屏）
  const post = postAt(cam, theme, headFlash);
  drawPost(ctx, W, H, theme, post, scene.post);

  return {
    t: +t.toFixed(6),
    T: +T.toFixed(6),
    frame,
    seg: map.segments.find((s) => T < s.T1 - EPS && T >= s.T0 - EPS)?.id ?? map.segments[map.segments.length - 1].id,
    scene: { id: scene.id, name: scene.name, index: sceneIndex, lt: +lt.toFixed(6) },
    camera: cam,
    post,
    transition: transition ? { kind: transition.kind, name: transition.name, variant: transition.variant, d: +transition.d.toFixed(4) } : null,
    effects,
    shotIndex,
    layerCount: layersOf(curShot).length,
  };
}

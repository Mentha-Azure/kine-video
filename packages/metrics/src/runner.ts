// 指标执行器：scope 解析 → 帧采样 → 调 kine-py/解析复算 → MetricResult；断言引擎 runAsserts
import type { KineIR, AssertPlanEntry } from '@kine/dsl';
import { pointAt, sceneAtTByTime, TtoT } from '@kine/dsl/time';
import { pyDensity, pyFrameDiff, pyEdgeBand, pyBlackLevel, pyTransitionSpike } from './pixel';
import { computeCamJitter } from './camera';
import { audioStatsOf, windowLevelsOf, beatsOf, computeBeatDelta, type AudioStatsData, type WindowLevel } from './audio';
import { metricDef } from './definition';
import { parseExpect, checkExpect } from './expect';

export interface MetricScope { scene?: string; range?: [number, number]; at?: string | number; step?: number }

export interface FrameProvider {
  /** 保证给定帧的 PNG 就绪，返回 frame → png 路径 */
  ensure(frames: number[]): Promise<Map<number, string>>;
}

export interface MetricInputs {
  ir: KineIR;
  frames?: FrameProvider;
  mixWav?: string;
  musicWav?: string;
  /** 报告资源输出目录（网格图等）；可选 */
  artifactsDir?: string;
}

export interface MetricResult {
  metric: string;
  scope: MetricScope | null;
  value: number | null;
  unit: string;
  agg: { min: number; max: number };
  extras: Record<string, unknown>;
  sample: { frames: number[]; step?: number };
  interpretation: string;
  facts: string[];
}

const PAIR_STEP_S = 0.4;
const DENSE_STEP_S = 0.1;

// ------------------------------------------------------------ scope 采样
function sceneFrames(ir: KineIR, sceneId: string): { f0: number; f1: number } {
  const sc = ir.time.map.scenes.find((s) => s.id === sceneId);
  if (!sc) throw new Error(`scope.scene 引用了不存在的幕 "${sceneId}"（可用：${ir.time.map.scenes.map((s) => s.id).join(', ')}）`);
  return { f0: sc.frame0, f1: sc.frame1 };
}

function pctFrame(f0: number, f1: number, pct: number): number {
  return Math.min(f1 - 1, f0 + Math.round(pct * (f1 - f0 - 1)));
}

/** 单帧采样：at（秒或 "62%"）/ scene / range(0.4s 步进) / 默认全片每幕 62% */
export function sampleFrames(ir: KineIR, scope: MetricScope | null): { frames: number[]; step?: number } {
  const map = ir.time.map;
  const fps = map.fps;
  const total = map.frames;
  if (scope?.at !== undefined) {
    if (typeof scope.at === 'string') {
      const m = /^([\d.]+)%$/.exec(scope.at.trim());
      if (!m) throw new Error(`scope.at 无法解析: "${scope.at}"（支持 "62%" 或秒数）`);
      const pct = Number(m[1]) / 100;
      if (scope.scene) {
        const { f0, f1 } = sceneFrames(ir, scope.scene);
        return { frames: [pctFrame(f0, f1, pct)] };
      }
      const f = Math.min(total - 1, Math.max(0, Math.round(pct * (total - 1))));
      return { frames: [f] };
    }
    const f = pointAt(map, scope.at).frame;
    return { frames: [Math.min(total - 1, Math.max(0, f))] };
  }
  if (scope?.scene) {
    const { f0, f1 } = sceneFrames(ir, scope.scene);
    return { frames: [pctFrame(f0, f1, 0.62)] };
  }
  if (scope?.range) {
    const [a, b] = scope.range;
    const step = scope.step !== undefined && scope.step > 0 ? scope.step : PAIR_STEP_S;
    const frames: number[] = [];
    for (let t = a; t < b - 1e-9; t += step) {
      const f = pointAt(map, t).frame;
      if (f >= 0 && f < total && !frames.includes(f)) frames.push(f);
    }
    if (frames.length === 0) frames.push(Math.min(total - 1, pointAt(map, a).frame));
    return { frames, step };
  }
  // 默认：全片抽样 = 每幕 62% 处
  const frames = ir.time.map.scenes.map((s) => pctFrame(s.frame0, s.frame1, 0.62));
  return { frames };
}

/** 密采样（转场窗口）：各边界 ±0.45s，0.1s 步进；按窗口分组（避免窗口间大间隔产生假跳变） */
export function denseWindows(ir: KineIR, scope: MetricScope | null): number[][] {
  const map = ir.time.map;
  const fps = map.fps;
  const total = map.frames;
  const half = Math.round(0.45 * fps);
  const step = Math.round(DENSE_STEP_S * fps);

  let boundaries: number[] = [];
  if (scope?.at !== undefined) {
    const t = typeof scope.at === 'number' ? scope.at : pointAt(map, Number(String(scope.at).replace('%', '')) / 100 * map.duration).t;
    const f = pointAt(map, t).frame;
    boundaries = [f];
  } else {
    for (const s of map.scenes) if (s.frame0 > 0) boundaries.push(s.frame0);
    for (const s of ir.scenes) for (const sh of s.shots) if (sh.index > 0) boundaries.push(sh.frame0);
    for (const b of map.breaks) boundaries.push(b.frame);
  }
  if (scope?.range) {
    const f0 = pointAt(map, scope.range[0]).frame;
    const f1 = pointAt(map, scope.range[1]).frame;
    boundaries = boundaries.filter((b) => b >= f0 && b <= f1);
  } else if (scope?.scene) {
    const { f0, f1 } = sceneFrames(ir, scope.scene);
    boundaries = boundaries.filter((b) => b >= f0 - half && b <= f1 + half);
  }
  boundaries = [...new Set(boundaries)].sort((a, b) => a - b);

  const windows: number[][] = [];
  for (const b of boundaries) {
    const w: number[] = [];
    for (let f = b - half; f <= b + half; f += step) {
      if (f >= 0 && f < total) w.push(f);
    }
    if (w.length >= 3) windows.push(w);
  }
  return windows;
}

// ------------------------------------------------------------ 单指标执行
function fmtPct(v: number): string { return `${(v * 100).toFixed(2)}%`; }
function fmtDb(v: number): string { return `${v.toFixed(1)}dB`; }

async function runDensity(ir: KineIR, scope: MetricScope | null, inputs: MetricInputs): Promise<MetricResult> {
  const { frames } = sampleFrames(ir, scope);
  if (!inputs.frames) throw new Error('density 需要 FrameProvider（inputs.frames）');
  const files = await inputs.frames.ensure(frames);
  const values: { frame: number; value: number; backgroundRgb: [number, number, number]; hotspots: unknown }[] = [];
  for (const f of frames) {
    const p = files.get(f);
    if (!p) throw new Error(`帧 ${f} 的 PNG 未提供`);
    const d = await pyDensity(p);
    values.push({ frame: f, value: d.value, backgroundRgb: d.backgroundRgb, hotspots: d.hotspots });
  }
  const sorted = [...values].sort((a, b) => a.value - b.value);
  const worst = sorted[0];
  const vmin = sorted[0].value;
  const vmax = sorted[sorted.length - 1].value;
  const facts = [
    `density 最差 ${fmtPct(vmin)} @f${worst.frame}`,
    `采样 ${values.length} 帧（${frames.join(', ')}）`,
    `最差帧背景 RGB(${worst.backgroundRgb.map((x) => x.toFixed(1)).join(', ')})`,
  ];
  const interp = `密度 ${fmtPct(vmin)}（阈值 ≥0.90%）。${vmin >= 0.009 ? '内容存在感正常。' : '偏空——黑屏/画面过空，检查该帧元素是否被裁掉或 alpha 过低。'} 热点 top：${JSON.stringify(worst.hotspots).slice(0, 120)}`;
  return {
    metric: 'density', scope, value: vmin, unit: 'ratio',
    agg: { min: vmin, max: vmax },
    extras: { perFrame: values, hotspots: worst.hotspots },
    sample: { frames }, interpretation: interp, facts,
  };
}

async function runFrameDiff(ir: KineIR, scope: MetricScope | null, inputs: MetricInputs): Promise<MetricResult> {
  const map = ir.time.map;
  const { frames, step } = sampleFrames(ir, scope);
  const offset = Math.round(PAIR_STEP_S * map.fps);
  const pairs: [number, number][] = frames.map((f) => {
    let b = f + offset;
    if (b >= map.frames) b = f - offset;
    return [f, b] as [number, number];
  }).filter(([a, b]) => a >= 0 && b >= 0 && a < map.frames && b < map.frames);
  if (!inputs.frames) throw new Error('frame_diff 需要 FrameProvider（inputs.frames）');
  const all = [...new Set(pairs.flat())];
  const files = await inputs.frames.ensure(all);
  const values = [];
  for (const [a, b] of pairs) {
    const pa = files.get(a); const pb = files.get(b);
    if (!pa || !pb) throw new Error(`帧 ${a}/${b} 的 PNG 未提供`);
    const d = await pyFrameDiff(pa, pb);
    values.push({ a, b, value: d.value, grid: d.grid });
  }
  const vmin = values.reduce((m, x) => Math.min(m, x.value), 1);
  const vmax = values.reduce((m, x) => Math.max(m, x.value), 0);
  const worst = values.find((x) => x.value === vmin)!;
  const staticPairs = values.filter((x) => x.value < 0.04);
  const facts = [
    `frame_diff 最差 ${fmtPct(vmin)}（间隔 0.4s 帧对 f${worst.a}↔f${worst.b}）`,
    `静态帧对 ${staticPairs.length}/${values.length}`,
  ];
  const interp = `${vmin >= 0.04 ? '画面持续运动，非静态。' : '存在静态帧对（<4%）：该时段缺结构性运动，考虑增加 widget 运动或粒子推进。'} 网格定位：分散=内容推进 / 集中=真有动 / 全无=静态。`;
  return {
    metric: 'frame_diff', scope, value: vmin, unit: 'ratio',
    agg: { min: vmin, max: vmax },
    extras: { pairs: values, staticPairs: staticPairs.map((x) => [x.a, x.b]) },
    sample: { frames, step }, interpretation: interp, facts,
  };
}

async function runStaticRatio(ir: KineIR, scope: MetricScope | null, inputs: MetricInputs): Promise<MetricResult> {
  const fd = await runFrameDiff(ir, scope, inputs);
  const pairs = fd.extras.pairs as { value: number }[];
  const share = pairs.length ? pairs.filter((p) => p.value < 0.04).length / pairs.length : 0;
  return {
    metric: 'static_ratio', scope, value: share, unit: 'ratio',
    agg: { min: share, max: share },
    extras: { pairs: pairs.length },
    sample: fd.sample, interpretation: `静态占比 ${fmtPct(share)}（≤30% 可调）。`, facts: [`静态帧对占比 ${fmtPct(share)}（样本 ${pairs.length}）`],
  };
}

async function runEdgeBand(ir: KineIR, scope: MetricScope | null, inputs: MetricInputs): Promise<MetricResult> {
  const { frames } = sampleFrames(ir, scope);
  if (!inputs.frames) throw new Error('edge_band 需要 FrameProvider（inputs.frames）');
  const files = await inputs.frames.ensure(frames);
  const values = [];
  for (const f of frames) {
    const p = files.get(f);
    if (!p) throw new Error(`帧 ${f} 的 PNG 未提供`);
    const d = await pyEdgeBand(p);
    values.push({ frame: f, value: d.value, sides: d.sides });
  }
  const vmax = values.reduce((m, x) => Math.max(m, x.value), 0);
  const vmin = values.reduce((m, x) => Math.min(m, x.value), 1);
  const worst = values.find((x) => x.value === vmax)!;
  const interp = `${vmax <= 0.6 ? '边缘带干净（≤0.6）。' : '边缘带内容过多：贴边 HUD 可能被裁（L-HUD-001：贴边一律 max(96, W*0.095) 起排）。'} 最差四边：${JSON.stringify(worst.sides)}`;
  return {
    metric: 'edge_band', scope, value: vmax, unit: 'ratio',
    agg: { min: vmin, max: vmax },
    extras: { perFrame: values },
    sample: { frames }, interpretation: interp, facts: [`edge_band 最差 ${vmax.toFixed(4)} @f${worst.frame}`],
  };
}

async function runBlackLevel(ir: KineIR, scope: MetricScope | null, inputs: MetricInputs): Promise<MetricResult> {
  const { frames } = sampleFrames(ir, scope);
  if (!inputs.frames) throw new Error('black_level 需要 FrameProvider（inputs.frames）');
  const files = await inputs.frames.ensure(frames);
  const values = [];
  for (const f of frames) {
    const p = files.get(f);
    if (!p) throw new Error(`帧 ${f} 的 PNG 未提供`);
    const d = await pyBlackLevel(p);
    values.push({ frame: f, value: d.value, rgb: d.rgb, maxChannel: d.maxChannel });
  }
  const vmin = values.reduce((m, x) => Math.min(m, x.value), Infinity);
  const vmax = values.reduce((m, x) => Math.max(m, x.value), -Infinity);
  const worst = values.find((x) => x.value === vmax)!;
  const interp = `黑电平 ${vmin.toFixed(2)}..${vmax.toFixed(2)}（健康 6..9）。${vmax > 9 ? '偏灰/白纱：检查 flash 与后处理 alpha、背景渐变（发灰根因）。' : vmin < 6 ? '偏死黑：检查背景色与暗角过强。' : '正常。'} 最大帧 RGB(${worst.rgb.map((x) => x.toFixed(1)).join(', ')})`;
  return {
    metric: 'black_level', scope, value: vmax, unit: 'level',
    agg: { min: vmin, max: vmax },
    extras: { perFrame: values },
    sample: { frames }, interpretation: interp, facts: [`black_level 范围 ${vmin.toFixed(2)}..${vmax.toFixed(2)}（样本 ${values.length}）`],
  };
}

async function runCamJitter(ir: KineIR, scope: MetricScope | null, _inputs: MetricInputs): Promise<MetricResult> {
  const d = computeCamJitter(ir, { sceneId: scope?.scene });
  const facts = [
    `水平 p50 ${d.hP50.toFixed(2)}px / p90 ${d.hP90.toFixed(2)}px / p99 ${d.hP99.toFixed(2)}px / max ${d.hMax.toFixed(2)}px`,
    `滚转 p99 ${d.rollP99.toFixed(4)}° / max ${d.rollMax.toFixed(4)}°`,
    `>4px 帧 ${d.over4}/${d.frames}`,
  ];
  const pass = d.hP99 <= 2 && d.rollP99 <= 0.01;
  return {
    metric: 'cam_jitter', scope, value: d.hP99, unit: 'px',
    agg: { min: d.hP50, max: d.hMax },
    extras: { ...d },
    sample: { frames: d.samples.map((s) => s.frame) },
    interpretation: `${pass ? '抖动合格（p99 水平≤2px、滚转≤0.01°）。' : '抖动超限：检查 L-CAM-001（连续函数、频率≤5Hz、幅度≤基准/4）。'} 解析复算（非相位相关）。`,
    facts,
  };
}

export type DesignClass = 'scene-head' | 'shot-transition' | 'shot-cut' | 'beat-flash';

/** 设计内边界（成片秒）：幕头装置 / 镜头转场窗口 / 硬切瞬间 / 声明强拍白闪 —— 这些位置的快速变化是设计内行为，不应计为孤立跳变 */
export function designedSpans(ir: KineIR): { label: DesignClass; span: [number, number] }[] {
  const spans: { label: DesignClass; span: [number, number] }[] = [];
  const beatSpans: { label: DesignClass; span: [number, number] }[] = [];
  const themeFlashMax = ir.theme.post.flash.max_alpha;
  const fps = ir.time.map.fps;
  ir.scenes.forEach((s, i) => {
    // 法定幕头装置：红条+白闪 0.24s（仅 scene index>0）
    if (i > 0) spans.push({ label: 'scene-head', span: [s.t0 - 1e-4, s.t0 + 0.34] });
    for (const sh of s.shots) {
      if (sh.index <= 0) continue; // 首镜头无转场
      if (sh.transition) {
        // 转场占用镜头开头 dur 秒（lt 空间），换算为成片秒：按镜头内时间占比折算
        // 转场在 lt 空间持续 transition.dur；映射回成片秒：ΔT = Δlt / (rate × accelFactor)
        // （不能用 (t1-t0) 比例换算：accel 钐位/末镜头尾部延展会高估窗口）
        // 转场在 lt 空间占 dur 秒；精确映射回成片秒：ltEnd=min(lt0+td,lt1,s.dur) → TEnd=T0+ltEnd/(rate×accelFactor) → tEnd=TtoT(TEnd)
        const rateAcc = (s.rate > 0 ? s.rate : 1) * (s.accelFactor || 1);
        const td = sh.transition.dur;
        const ltEnd = Math.min(sh.lt0 + td, sh.lt1, s.dur);
        const TEnd = s.T0 + ltEnd / (rateAcc > 0 ? rateAcc : 1);
        const tEnd = TtoT(ir.time.map, Math.min(TEnd, s.T1));
        spans.push({ label: 'shot-transition', span: [sh.t0 - 1e-4, tEnd + 0.08] });
      } else {
        // 未声明转场 = 设计内硬切（单帧对孤立变化）
        spans.push({ label: 'shot-cut', span: [sh.t0 - 0.12, sh.t0 + 0.12] });
      }
    }
    // —— beat-flash 豁免（v3 P1-3）：bpm 声明的强拍驱动 flash² 周期性阶跃（camera.flash2 1e-4→1.0、
    // post.flash≈5e-2），帧对跨越拍点即命中——属设计内装置；仅当白闪全局开启且本幕未禁用时豁免。
    // 顺序优先级：幕头→镜头→强拍（拍点 span 最后推入，避免抢占更广的幕头/转场窗口）。
    const sceneFlashOn = (s.post?.flash ?? 1) > 0;
    if (themeFlashMax > 0 && sceneFlashOn) {
      const cams = s.shots.length > 0
        ? s.shots.map((sh) => ({ bpm: sh.camera.bpm, off: sh.camera.beat_offset, T0: sh.T0, T1: sh.T1 }))
        : [{ bpm: s.camera.bpm, off: s.camera.beat_offset, T0: s.T0, T1: s.T1 }];
      const half = 0.5 / fps;
      for (const cam of cams) {
        const bpm = cam.bpm ?? 0;
        if (!(bpm > 0)) continue;
        const period = 60 / bpm;
        const kFrom = Math.ceil((cam.T0 + cam.off) / period - 1e-9);
        const kTo = Math.floor((cam.T1 + cam.off) / period + 1e-9);
        for (let k = kFrom; k <= kTo; k++) {
          const Tk = k * period - cam.off;
          if (Tk < cam.T0 - 1e-9 || Tk > cam.T1 + 1e-9) continue;
          const tk = TtoT(ir.time.map, Tk);
          beatSpans.push({ label: 'beat-flash', span: [tk - half, tk + half] });
        }
      }
    }
  });
  spans.push(...beatSpans);
  return spans;
}

/** 帧对 [f0,f1] 落在设计内边界→返回类名；否则 null */
export function classifyDesign(ir: KineIR, f0: number, f1: number): DesignClass | null {
  const fps = ir.time.map.fps;
  const a = f0 / fps;
  const b = f1 / fps;
  for (const d of designedSpans(ir)) {
    if (b >= d.span[0] && a <= d.span[1]) return d.label;
  }
  return null;
}

async function runTransitionSpike(ir: KineIR, scope: MetricScope | null, inputs: MetricInputs): Promise<MetricResult> {
  if (!inputs.frames) throw new Error('transition_spike 需要 FrameProvider（inputs.frames）');
  const windows = denseWindows(ir, scope);
  let hits = 0;
  const ignored: Record<DesignClass, number> = { 'scene-head': 0, 'shot-transition': 0, 'shot-cut': 0, 'beat-flash': 0 };
  const hitFrames: number[] = [];
  const ignoredFrames: number[] = [];
  const diffs: number[] = [];
  const framesAll: number[] = [];
  for (const w of windows) {
    const files = await inputs.frames.ensure(w);
    const paths = w.map((f) => files.get(f)!).filter(Boolean);
    if (paths.length < 3) continue;
    const r = await pyTransitionSpike(paths);
    for (const h of r.hits) {
      const f0 = w[h.from] ?? w[0];
      const f1 = w[h.to] ?? f0;
      const cls = classifyDesign(ir, f0, f1);
      if (cls) {
        ignored[cls] += 1;
        ignoredFrames.push(f1);
      } else {
        hits += 1;
        hitFrames.push(f1);
      }
    }
    diffs.push(...r.diffs);
    framesAll.push(...w);
  }
  const ignoredTotal = ignored['scene-head'] + ignored['shot-transition'] + ignored['shot-cut'] + ignored['beat-flash'];
  const facts = [
    `转场窗口 ${windows.length} 个，命中孤立跳变 ${hits}`,
    ignoredTotal > 0
      ? `设计内边界另豁免 ${ignoredTotal} 处（幕头装置 ${ignored['scene-head']}｜镜头转场 ${ignored['shot-transition']}｜硬切 ${ignored['shot-cut']}｜强拍白闪 ${ignored['beat-flash']}）`
      : null,
  ].filter(Boolean) as string[];
  return {
    metric: 'transition_spike', scope, value: hits, unit: 'count',
    agg: { min: 0, max: hits },
    extras: { windows: windows.length, diffs, hitFrames, ignored, ignoredFrames },
    sample: { frames: framesAll },
    interpretation: hits === 0 ? '无孤立跳变（健康；设计内边界—幕头/镜头转场/硬切/强拍白闪—不计）。' : '存在孤立跳变：疑似卡顿/闪回——A 遮罩方向 1-p、B/C/D 位移缩放须收回（ov=1+.15*(1-d)）。',
    facts,
  };
}

async function runAudioRms(ir: KineIR, scope: MetricScope | null, inputs: MetricInputs): Promise<MetricResult> {
  if (!inputs.mixWav) throw new Error('audio_rms 需要 mixWav（成品混音）');
  const stats = await audioStatsOf(inputs.mixWav);
  let levels: WindowLevel[];
  if (scope?.range) {
    const [a, b] = scope.range;
    levels = await windowLevelsOf(inputs.mixWav, [{ t0: a, t1: b }]);
  } else if (scope?.scene) {
    const sc = ir.time.map.scenes.find((s) => s.id === scope.scene);
    if (!sc) throw new Error(`不存在幕 "${scope.scene}"`);
    levels = await windowLevelsOf(inputs.mixWav, [{ t0: sc.t0, t1: sc.t1 }]);
  } else {
    levels = await windowLevelsOf(inputs.mixWav, [{ t0: 0, t1: stats.duration }]);
  }
  const peak = Math.max(...levels.map((l) => l.peakDbfs));
  const peakMin = Math.min(...levels.map((l) => l.peakDbfs));
  const facts = [`峰值 ${fmtDb(peak)}（${scope?.range ? `[${scope.range[0]}, ${scope.range[1]}]` : scope?.scene ?? '全片'}）`, `整体 peak ${fmtDb(stats.peakDbfs)}`];
  return {
    metric: 'audio_rms', scope, value: peak, unit: 'dB',
    agg: { min: peakMin, max: peak },
    extras: { levels, stats },
    sample: { frames: [] },
    interpretation: `区间峰值 ${fmtDb(peak)}。${peak > -20 ? '音乐存在感达标（>-20dB）。' : '过低：检查 music gain / cut_from 是否砍多了。'}`,
    facts,
  };
}

async function runAudioCumEnergy(_ir: KineIR, scope: MetricScope | null, inputs: MetricInputs): Promise<MetricResult> {
  if (!inputs.mixWav) throw new Error('audio_cumenergy 需要 mixWav');
  const stats: AudioStatsData = await audioStatsOf(inputs.mixWav);
  return {
    metric: 'audio_cumenergy', scope, value: stats.t99_9, unit: 's',
    agg: { min: stats.t99_9, max: stats.t99_9 },
    extras: { stats },
    sample: { frames: [] },
    interpretation: `RMS² 累积能量 99.9% 时刻 = ${stats.t99_9.toFixed(3)}s（「最后一声」定位）。尾部峰值 ${fmtDb(stats.tailPeakDbfs)}。`,
    facts: [`t99.9 = ${stats.t99_9.toFixed(3)}s`, `尾部 0.2s 峰值 ${fmtDb(stats.tailPeakDbfs)}`],
  };
}

async function runBeatDelta(ir: KineIR, scope: MetricScope | null, inputs: MetricInputs): Promise<MetricResult> {
  if (!inputs.musicWav) throw new Error('beat_delta 需要 musicWav（原曲）');
  const b = await beatsOf(inputs.musicWav, ir.output.fps);
  const events = ir.audioPlan.sfxEvents.map((e) => ({ at: e.at, sfx: e.sfx as string }));
  const d = computeBeatDelta(b.beats.map((x) => x.t), events);
  const facts = [
    `重拍 ${d.beats} 个 / 音效事件 ${d.events} 个 / 配对 ${d.matched.length} 对`,
    `max |Δ| = ${d.maxAbsMs.toFixed(1)}ms`,
  ];
  return {
    metric: 'beat_delta', scope, value: d.maxAbsMs, unit: 'ms',
    agg: { min: 0, max: d.maxAbsMs },
    extras: { ...d, beats: b.beats },
    sample: { frames: [] },
    interpretation: `卡点偏差最大 ${d.maxAbsMs.toFixed(1)}ms（≤60ms）。${d.maxAbsMs <= 60 ? '卡点合格。' : '存在明显偏差：对齐事件 at 或检查瞬态检测。'}`,
    facts,
  };
}

// ------------------------------------------------------------ 公开 API
export async function runMetric(name: string, scope: MetricScope | null, inputs: MetricInputs): Promise<MetricResult> {
  const def = metricDef(name);
  switch (def.name) {
    case 'density': return runDensity(inputs.ir, scope, inputs);
    case 'frame_diff': return runFrameDiff(inputs.ir, scope, inputs);
    case 'static_ratio': return runStaticRatio(inputs.ir, scope, inputs);
    case 'edge_band': return runEdgeBand(inputs.ir, scope, inputs);
    case 'black_level': return runBlackLevel(inputs.ir, scope, inputs);
    case 'cam_jitter': return runCamJitter(inputs.ir, scope, inputs);
    case 'transition_spike': return runTransitionSpike(inputs.ir, scope, inputs);
    case 'audio_rms': return runAudioRms(inputs.ir, scope, inputs);
    case 'audio_cumenergy': return runAudioCumEnergy(inputs.ir, scope, inputs);
    case 'beat_delta': return runBeatDelta(inputs.ir, scope, inputs);
    default: throw new Error(`指标 ${name} 尚未实现`);
  }
}

// ------------------------------------------------------------ 断言引擎
export interface AssertResult {
  id: string;
  metric: string;
  scope: MetricScope | null;
  expect: string;
  severity: 'error' | 'warn';
  verdict: 'PASS' | 'FAIL' | 'SKIP';
  value: number | null;
  unit: string;
  display: string;
  facts: string[];
  message: string;
  sample: { frames: number[] };
  interpretation?: string;
}

export interface AssertReport {
  results: AssertResult[];
  passCount: number;
  failCount: number;
  skipCount: number;
  ok: boolean;
  markdown: string;
  json: { results: AssertResult[]; passCount: number; failCount: number; skipCount: number; ok: boolean };
}

function displayValue(metric: string, value: number | null): string {
  if (value === null) return '—';
  if (['density', 'frame_diff', 'static_ratio', 'edge_band'].includes(metric)) return `${(value * 100).toFixed(2)}%`;
  if (metric === 'cam_jitter') return `${value.toFixed(2)}px`;
  if (metric === 'black_level') return value.toFixed(2);
  if (metric === 'audio_rms') return `${value.toFixed(1)}dB`;
  if (metric === 'audio_cumenergy') return `${value.toFixed(3)}s`;
  if (metric === 'beat_delta') return `${value.toFixed(1)}ms`;
  return String(value);
}

/** v4：期望值展示——比例指标补百分数解读（反馈：edge_band 阈值 0.6 无单位，PASS/FAIL 时看不出依据） */
function displayExpect(metric: string, raw: string): string {
  try {
    const p = parseExpect(raw);
    const ratio = ['density', 'frame_diff', 'static_ratio', 'edge_band'].includes(metric);
    if (!ratio) return raw;
    if (p.op === 'in' && p.range) return `${raw}（比例 ${(p.range[0] * 100).toFixed(1)}%–${(p.range[1] * 100).toFixed(1)}%）`;
    if (typeof p.threshold === 'number') return `${raw}（比例 ${p.op} ${(p.threshold * 100).toFixed(2)}%）`;
  } catch {
    /* 解析失败原样展示 */
  }
  return raw;
}

export async function runAsserts(
  ir: KineIR,
  inputs: MetricInputs,
  opts: { onlyId?: string; step?: number } = {},
): Promise<AssertReport> {
  const cache = new Map<string, MetricResult>();
  const results: AssertResult[] = [];
  for (const entry of ir.assertPlan as AssertPlanEntry[]) {
    if (opts.onlyId && entry.id !== opts.onlyId) continue;
    const baseScope = (entry.scope ?? null) as MetricScope | null;
    // 缺陷 #7：采样密度可配置——断言级 step 注入（仅 range 类采样生效）
    const scope = opts.step && opts.step > 0 ? ({ ...(baseScope ?? {}), step: opts.step } as MetricScope) : baseScope;
    const parsed = parseExpect(entry.expect);
    const key = `${entry.metric}|${JSON.stringify(scope)}`;
    let m: MetricResult;
    try {
      if (cache.has(key)) {
        m = cache.get(key)!;
      } else {
        m = await runMetric(entry.metric, scope, inputs);
        cache.set(key, m);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const skip = /需要 (FrameProvider|mixWav|musicWav)/.test(msg);
      results.push({
        id: entry.id, metric: entry.metric, scope, expect: entry.expect, severity: entry.severity,
        verdict: skip ? 'SKIP' : 'FAIL', value: null, unit: metricDef(entry.metric).unit, display: '—',
        facts: [], message: skip ? `跳过：${msg}` : `执行失败：${msg}`,
        sample: { frames: [] },
      });
      continue;
    }
    // 按断言 op 选最坏代表值
    let v = m.value ?? 0;
    if (parsed.op === '>=' || parsed.op === '>') v = m.agg.min;
    else if (parsed.op === '<=' || parsed.op === '<') v = m.agg.max;
    const pass = checkExpect(parsed, v, { min: m.agg.min, max: m.agg.max });
    results.push({
      id: entry.id, metric: entry.metric, scope, expect: entry.expect, severity: entry.severity,
      verdict: pass ? 'PASS' : 'FAIL',
      value: v, unit: m.unit, display: displayValue(entry.metric, v),
      facts: m.facts, message: pass ? `通过（实测 ${displayValue(entry.metric, v)}，期望 ${displayExpect(entry.metric, entry.expect)}）` : `未达期望（实测 ${displayValue(entry.metric, v)}，期望 ${displayExpect(entry.metric, entry.expect)}）`,
      sample: { frames: m.sample.frames.slice(0, 24) },
      interpretation: m.interpretation,
    });
  }
  const passCount = results.filter((r) => r.verdict === 'PASS').length;
  const failCount = results.filter((r) => r.verdict === 'FAIL').length;
  const skipCount = results.filter((r) => r.verdict === 'SKIP').length;
  const ok = failCount === 0;
  const lines = [
    '| 断言 | 指标 | scope | 期望 | 实测 | 判定 |',
    '|---|---|---|---|---|---|',
    ...results.map((r) => `| ${r.id} | ${r.metric} | ${r.scope ? JSON.stringify(r.scope) : '全片'} | ${displayExpect(r.metric, r.expect)} | ${r.display} | ${r.verdict === 'PASS' ? '✅ PASS' : r.verdict === 'FAIL' ? '❌ FAIL' : '⏭ SKIP'} |`),
    '',
    `汇总：PASS ${passCount} / FAIL ${failCount} / SKIP ${skipCount}`,
  ];
  return {
    results, passCount, failCount, skipCount, ok,
    markdown: lines.join('\n'),
    json: { results, passCount, failCount, skipCount, ok },
  };
}

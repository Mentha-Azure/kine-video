// @kine/dsl — 三种时钟与时间对照表
//   成片时钟 t: 0 → output.duration（唯一对外口径，单位：秒）
//   渲染时钟 T: 0 → Σ scenes.dur（分段线性映射 T = f(t)）
//   动画时钟 lt: 0 → scene.dur（幕内，rate/accel 应用后）
import type { PaceSpecT, ProjectSpecT, SceneSpecT } from './schema';
import { err, type Issue } from './errors';

export interface TimeSeg {
  id: string;
  /** t 区间 [t0, t1) */
  t0: number;
  t1: number;
  ratio: number;
  /** T 区间 [T0, T1) */
  T0: number;
  T1: number;
  frame0: number;
  frame1: number;
}

export interface TimeScene {
  id: string;
  T0: number;
  T1: number;
  t0: number;
  t1: number;
  frame0: number;
  frame1: number;
  dur: number;
  rate: number;
  accel: 'none' | 'cut';
  /** accel=cut 时的压缩系数（未裁剪）；none 时 =1 */
  accelFactor: number;
}

export interface TimeMap {
  fps: number;
  /** 成片时长（秒） */
  duration: number;
  /** 渲染总时长（秒） = Σ scenes.dur */
  durationT: number;
  /** 成片总帧数 = round(duration*fps) */
  frames: number;
  segments: TimeSeg[];
  breaks: { frame: number; t: number; T: number }[];
  scenes: TimeScene[];
}

export interface TimePoint {
  t: number;
  T: number;
  frame: number;
  /** 所在 pace 段 */
  seg: string;
  /** 所在幕（t 落在幕区间内才给出） */
  scene?: string;
}

const EPS = 1e-9;

export function buildTimeMap(opts: {
  fps: number;
  duration: number;
  pace: PaceSpecT;
  scenes: Pick<SceneSpecT, 'id' | 'dur' | 'rate' | 'accel' | 'shots'>[];
  maxAcc?: number;
}): { map: TimeMap; issues: Issue[] } {
  const { fps, duration, pace, scenes } = opts;
  const maxAcc = opts.maxAcc ?? 1.62;
  const issues: Issue[] = [];

  // ---- pace 校验
  const segs = pace.segments;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const prev = i === 0 ? 0 : segs[i - 1].until;
    if (!(s.until > prev + EPS)) {
      issues.push({
        code: 'E-TIME-002',
        severity: 'error',
        message: `pace.segments[${i}] "${s.id}".until=${s.until} 必须严格大于前一段 until=${prev}`,
        where: { path: `pace.segments[${i}].until` },
        facts: [`until=${s.until}`, `prev=${prev}`],
        hints: ['pace.until 必须严格递增且末项等于 output.duration'],
      });
    }
    if (!(s.ratio > 0)) {
      issues.push({ code: 'E-TIME-002', severity: 'error', message: `pace.segments[${i}].ratio 必须 > 0`, where: { path: `pace.segments[${i}].ratio` } });
    }
  }
  const lastUntil = segs[segs.length - 1]?.until ?? 0;
  if (Math.abs(lastUntil - duration) > 1e-6) {
    issues.push({
      code: 'E-TIME-002',
      severity: 'error',
      message: `pace 末段 until=${lastUntil} 必须等于 output.duration=${duration}`,
      where: { path: `pace.segments[${segs.length - 1}].until` },
      facts: [`until=${lastUntil}`, `duration=${duration}`],
      hints: [`把末段 until 改为 ${duration}`],
    });
  }

  // ---- 构建 segments（t 空间）
  const segments: TimeSeg[] = [];
  let Tacc = 0;
  for (let i = 0; i < segs.length; i++) {
    const s = segs[i];
    const t0 = i === 0 ? 0 : segs[i - 1].until;
    const t1 = Math.min(s.until, duration);
    const len = Math.max(0, t1 - t0) * s.ratio;
    segments.push({
      id: s.id,
      t0,
      t1: s.until,
      ratio: s.ratio,
      T0: Tacc,
      T1: Tacc + len,
      frame0: Math.round(t0 * fps),
      frame1: Math.round(t1 * fps),
    });
    Tacc += len;
  }
  const durationT = Tacc;

  // ---- 映射函数（只用 segments 数组，闭包免重复查找）
  const segAtT = (t: number): TimeSeg => {
    for (let i = 0; i < segments.length; i++) {
      if (t < segments[i].t1 - EPS) return segments[i];
    }
    return segments[segments.length - 1];
  };
  const segAtRender = (T: number): TimeSeg => {
    for (let i = 0; i < segments.length; i++) {
      if (T < segments[i].T1 - EPS) return segments[i];
    }
    return segments[segments.length - 1];
  };

  const tToT = (t: number): number => {
    const c = Math.min(Math.max(t, 0), duration);
    const seg = segAtT(c);
    return seg.T0 + (c - seg.t0) * seg.ratio;
  };
  const TToT = (T: number): number => {
    const seg = segAtRender(T);
    return seg.t0 + (T - seg.T0) / seg.ratio;
  };

  // ---- 幕（T 空间顺序排布）
  const frameCount = Math.round(duration * fps);
  const timeScenes: TimeScene[] = [];
  let tacc = 0;
  for (let i = 0; i < scenes.length; i++) {
    const s = scenes[i];
    const T0 = tacc;
    const T1 = tacc + s.dur;
    tacc = T1;
    const t0 = T0 === 0 ? 0 : TToT(T0);
    const t1 = TToT(T1);
    const shotCount = s.shots?.length ?? 0;
    // cutLen = 镜头平均时长；无镜头时为全幕（系数 1）
    const cutLen = shotCount > 0 ? s.dur / shotCount : s.dur;
    const accelFactor = s.accel === 'cut' ? Math.min(s.dur / cutLen, maxAcc) : 1;
    timeScenes.push({
      id: s.id,
      T0,
      T1,
      t0,
      t1,
      frame0: Math.round(t0 * fps),
      frame1: Math.round(t1 * fps),
      dur: s.dur,
      rate: s.rate,
      accel: s.accel,
      accelFactor,
    });
  }
  // 帧边界对齐：幕 frame1 == 下一幕 frame0；末幕 frame1 == frames
  for (let i = 0; i < timeScenes.length - 1; i++) {
    const mid = Math.round((timeScenes[i].frame1 + timeScenes[i + 1].frame0) / 2);
    const drift = Math.abs(timeScenes[i].frame1 - timeScenes[i + 1].frame0);
    if (drift > 1) {
      issues.push({
        code: 'E-TIME-001',
        severity: 'error',
        message: `幕 "${timeScenes[i].id}" 与 "${timeScenes[i + 1].id}" 帧边界漂移 ${drift} 帧（>1）`,
        where: { scene: timeScenes[i].id },
        facts: [`frame1=${timeScenes[i].frame1}`, `next.frame0=${timeScenes[i + 1].frame0}`],
        hints: ['检查 pace.ratio 与 scenes.dur 在边界处的乘积是否为整帧'],
      });
    }
    timeScenes[i].frame1 = mid;
    timeScenes[i + 1].frame0 = mid;
  }
  const lastScene = timeScenes[timeScenes.length - 1];
  if (lastScene) {
    const drift = Math.abs(lastScene.frame1 - frameCount);
    if (drift > 1) {
      issues.push({
        code: 'E-TIME-001',
        severity: 'error',
        message: `总时长相乘不一致：t(Σ scenes.dur)=${TToT(durationT).toFixed(6)}s vs output.duration=${duration}s（偏差 ${Math.abs(TToT(durationT) - duration).toFixed(6)}s > 1 帧）`,
        where: { path: 'output.duration' },
        facts: [
          `期望 t(Σdur) 与 duration 偏差 ≤ ${(1 / fps).toFixed(4)}s`,
          `实际偏差 ${Math.abs(TToT(durationT) - duration).toFixed(6)}s`,
          `Σ scenes.dur = ${durationT.toFixed(6)}s（渲染秒）`,
        ],
        hints: [
          '缓动方案：调整最后一个 pace.ratio，使 Σ(dur_i*ratio_i) == output.duration',
          `当前需要 Σ(dur*ratio) = ${duration}（见 kine map --t ${duration}）`,
        ],
      });
    }
    lastScene.frame1 = frameCount;
  }

  // ---- breaks（pace 断点，供分片）
  const breaks: { frame: number; t: number; T: number }[] = [];
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i];
    breaks.push({ frame: seg.frame1, t: seg.t1, T: seg.T1 });
  }

  const map: TimeMap = {
    fps,
    duration,
    durationT,
    frames: frameCount,
    segments,
    breaks,
    scenes: timeScenes,
  };
  return { map, issues };
}

// ---------------------------------------------------------------- 查询
export function pointAt(map: TimeMap, t: number): TimePoint {
  const c = Math.min(Math.max(t, 0), map.duration);
  let seg = map.segments[map.segments.length - 1];
  for (const s of map.segments) {
    if (c < s.t1 - EPS) { seg = s; break; }
  }
  const T = seg.T0 + (c - seg.t0) * seg.ratio;
  const scene = map.scenes.find((s) => T >= s.T0 - EPS && T < s.T1 - EPS) ?? map.scenes[map.scenes.length - 1];
  return { t: c, T, frame: Math.round(c * map.fps), seg: seg.id, scene: scene?.id };
}

export function pointAtFrame(map: TimeMap, frame: number): TimePoint {
  const f = Math.min(Math.max(frame, 0), map.frames - 1);
  return pointAt(map, f / map.fps);
}

export function TtoT(map: TimeMap, T: number): number {
  const seg = map.segments.find((s) => T < s.T1 - EPS) ?? map.segments[map.segments.length - 1];
  return seg.t0 + (T - seg.T0) / seg.ratio;
}

export function tToT(map: TimeMap, t: number): number {
  const seg = map.segments.find((s) => t < s.t1 - EPS) ?? map.segments[map.segments.length - 1];
  return seg.T0 + (t - seg.t0) * seg.ratio;
}

export function sceneAtT(map: TimeMap, T: number): TimeScene {
  return map.scenes.find((s) => T >= s.T0 - EPS && T < s.T1 - EPS) ?? map.scenes[map.scenes.length - 1];
}

export function sceneAtTByTime(map: TimeMap, t: number): TimeScene {
  const pt = pointAt(map, t);
  return sceneAtT(map, pt.T);
}

/** 幕内动画时钟 lt（含 accel 压缩） */
export function sceneLt(scene: TimeScene, T: number): number {
  const x = (T - scene.T0) * scene.rate;
  if (scene.accel === 'cut') return Math.min(x * scene.accelFactor, scene.dur);
  return x;
}

/** 幕头冲击：+0.038·exp(-lt/0.15) */
export function headImpact(lt: number): number {
  return 0.038 * Math.exp(-Math.max(lt, 0) / 0.15);
}

export function assertTimeMap(map: TimeMap): void {
  if (!(map.frames > 0)) {
    throw err({ code: 'E-TIME-001', severity: 'error', message: '总帧数为 0，检查 output.duration 与 fps' });
  }
}

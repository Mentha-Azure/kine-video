// @kine/dsl — 编译：spec → IR（含 map/deps/audioPlan/assertPlan），specHash 为缓存与回归根键
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { sha256, hashValue } from './hash';
import { buildTimeMap, TtoT, sceneLt, type TimeMap, type TimeScene } from './time';
import type { Issue } from './errors';
import type {
  AssertSpecT, CameraSpecT, LayerSpecT, ProjectSpecT, SceneSpecT,
} from './schema';
import { TRANSITION_NAMES } from './schema';
import { buildDeps, type DepEdge, type DepNode } from './deps';
import { kineHomeDir, parseLibraryRef, resolveLibraryRefLite } from './library';
import { applyPalette, canonicalTheme, resolvePalette } from './palette';

export const SYNTH_VERSION = 'kine-synth/2';

/** IR 哈希方案版本：任何改变 IR 规范形式的改动必须 bump（跨版本 specHash 不可比；首次 render 会全量重渲，属预期） */
export const HASH_SCHEME = 'kine-hash/1';
/** 渲染行为版本：runtime/widgets 像素输出发生变化的改动必须 bump（帧缓存根键之一） */
export const RENDER_VERSION = 'kine-render/1';

// ---------------------------------------------------------------- types
export interface CompiledShot {
  index: number;
  /** 幕内动画时钟区间 lt */
  lt0: number;
  lt1: number;
  T0: number;
  T1: number;
  t0: number;
  t1: number;
  frame0: number;
  frame1: number;
  transition: { kind: number; name: string; variant: number; dur: number } | null;
  /** 该镜头可见图层 id；null = 全幕 */
  on: string[] | null;
  camera: CameraSpecT;
}

export interface CompiledScene {
  id: string;
  act?: string;
  name?: string;
  dur: number;
  rate: number;
  accel: 'none' | 'cut';
  accelFactor: number;
  T0: number;
  T1: number;
  t0: number;
  t1: number;
  frame0: number;
  frame1: number;
  camera: CameraSpecT;
  layers: LayerSpecT[];
  shots: CompiledShot[];
  effects: SceneSpecT['effects'];
  post: SceneSpecT['post'];
  audio: { id: string; at: number; t: number; sfx: string; gain: number; bus: string; params: Record<string, unknown> }[];
  asserts: AssertSpecT[];
}

export interface AudioPlan {
  music: {
    file: string;
    absPath: string;
    exists: boolean;
    gain: number;
    fadeOut: { at: number; dur: number; shape: 'cosine' } | null;
    cutFrom: number | null;
    contentHash: string;
  } | null;
  buses: { id: string; gain: number }[];
  synth: 'offline' | 'record';
  sfxEvents: SfxEventResolved[];
  duration: number;
  frames: number;
  fps: number;
  droneLevels: number[] | null;
  /** sfx 路末段同步淡出时长（秒；audio.tail_fade。L-AUD-002：只砍 sfx 路与整体收尾） */
  tailFade: number;
}

export interface SfxEventResolved {
  id: string;
  sfx: string;
  /** 成片秒（混音时的唯一口径） */
  at: number;
  gain: number;
  bus: string;
  params: Record<string, unknown>;
  source: string;
  declaredClock: 'output' | 'render' | 'scene';
}

export interface AssertPlanEntry extends AssertSpecT {
  source: string;
  scope: AssertSpecT['scope'];
}

export interface KineIR {
  schema: 'kine/1';
  specHash: string;
  project: ProjectSpecT['project'];
  output: ProjectSpecT['output'];
  pace: ProjectSpecT['pace'];
  theme: ProjectSpecT['theme'];
  render: ProjectSpecT['render'];
  scenes: CompiledScene[];
  audioPlan: AudioPlan;
  assertPlan: AssertPlanEntry[];
  time: { map: TimeMap };
  hashes: {
    themeHash: string;
    paceHash: string;
    timePlanHash: string;
    sfxPlanHash: string;
    musicHash: string;
    /** 帧内容相关哈希（排除 audioPlan/assertPlan）：帧与分片缓存的根键（音频改动不重渲帧） */
    visualHash: string;
  };
  deps: { nodes: DepNode[]; edges: DepEdge[] };
}

export interface CompileResult {
  ir: KineIR;
  issues: Issue[];
}

// ---------------------------------------------------------------- helpers
const TRANSITION_DUR_MAX = 0.55;

function resolveTransition(t: SceneSpecT['shots'][number]['transition'] | undefined, index: number): CompiledShot['transition'] {
  if (!t) return null;
  const kind = typeof t.kind === 'number' ? t.kind : TRANSITION_NAMES.indexOf(t.kind);
  const name = TRANSITION_NAMES[kind] ?? 'wipe_redbar';
  let variant = 0;
  if (typeof t.variant === 'number') variant = t.variant;
  else if (typeof t.variant === 'string') {
    const v = t.variant.toLowerCase();
    if (['rl', 'bt', 'out', 'reverse'].includes(v)) variant = 1;
    else variant = 0;
  } else variant = index % 2;
  return { kind, name, variant, dur: 0 };
}

function mergeCamera(base: CameraSpecT, over?: Partial<CameraSpecT>): CameraSpecT {
  return over ? { ...base, ...over } : { ...base };
}

function hashFile(absPath: string): string {
  try {
    if (!existsSync(absPath)) return 'missing';
    const buf = readFileSync(absPath);
    return sha256(buf).slice(0, 16);
  } catch {
    return 'unreadable';
  }
}

/** lt → T 的反函数（含 accel 语义） */
export function ltToT(scene: Pick<TimeScene, 'T0' | 'T1' | 'dur' | 'rate' | 'accel' | 'accelFactor'>, lt: number): number {
  if (scene.accel === 'cut') {
    if (lt >= scene.dur) return scene.T1;
    const x = lt / (scene.accelFactor || 1);
    return scene.T0 + x / scene.rate;
  }
  return scene.T0 + lt / scene.rate;
}

// ---------------------------------------------------------------- compile
export function compile(spec: ProjectSpecT, opts?: { projectDir?: string }): CompileResult {
  const issues: Issue[] = [];
  const fps = spec.output.fps;
  const projectDir = opts?.projectDir ?? process.cwd();

  // ---- 时间映射
  const { map, issues: timeIssues } = buildTimeMap({
    fps,
    duration: spec.output.duration,
    pace: spec.pace,
    scenes: spec.scenes,
    maxAcc: spec.render.max_acc,
  });
  issues.push(...timeIssues);

  // ---- 幕编译
  const scenes: CompiledScene[] = spec.scenes.map((s, si) => {
    const ts = map.scenes[si];
    // shots 分区（lt 空间）
    const shots: CompiledShot[] = [];
    let ltacc = 0;
    let shotIssue: Issue | null = null;
    if (s.shots.length > 0) {
      const sumShots = s.shots.reduce((a, sh) => a + sh.dur, 0);
      if (Math.abs(sumShots - s.dur) > 2 / fps) {
        shotIssue = {
          code: 'E-TIME-002',
          severity: 'error',
          message: `幕 "${s.id}" shots.dur 合计=${sumShots.toFixed(4)}s，与 scene.dur=${s.dur}s 偏差超过 2 帧`,
          where: { scene: s.id, path: `scenes[${s.id}].shots` },
          facts: [`Σ shots.dur=${sumShots.toFixed(4)}s`, `scene.dur=${s.dur}s`],
          hints: ['镜头时长之和必须等于幕时长（±2 帧）'],
        };
      }
    }
    s.shots.forEach((sh, i) => {
      const lt0 = ltacc;
      const lt1 = ltacc + sh.dur;
      ltacc = lt1;
      const T0 = ltToT(ts, lt0);
      const T1 = ltToT(ts, lt1);
      const prev = i > 0 ? s.shots[i - 1] : null;
      let trans = resolveTransition(sh.transition, i);
      if (trans && i > 0) {
        const td = Math.min(TRANSITION_DUR_MAX, 0.35 * sh.dur, prev!.dur);
        trans = { ...trans, dur: td };
      } else if (trans && i === 0) {
        trans = null; // 首镜头无入场转场（幕边界由统一 #fx 处理）
      }
      shots.push({
        index: i,
        lt0,
        lt1,
        T0,
        T1,
        t0: TtoT(map, T0),
        t1: TtoT(map, T1),
        frame0: Math.round(TtoT(map, T0) * fps),
        frame1: Math.round(TtoT(map, T1) * fps),
        transition: trans,
        on: sh.on ?? null,
        camera: mergeCamera(s.camera, sh.camera_override),
      });
    });
    if (shotIssue) issues.push(shotIssue);

    // 幕内 sfx（lt → T → t）
    const audio = s.audio.map((ev, i) => {
      const T = ltToT(ts, ev.at);
      return {
        id: `${s.id}#${i}`,
        at: ev.at,
        t: TtoT(map, T),
        sfx: ev.sfx,
        gain: ev.gain,
        bus: ev.bus,
        params: ev.params,
      };
    });

    return {
      id: s.id,
      act: s.act,
      name: s.name,
      dur: s.dur,
      rate: s.rate,
      accel: s.accel,
      accelFactor: ts.accelFactor,
      T0: ts.T0,
      T1: ts.T1,
      t0: ts.t0,
      t1: ts.t1,
      frame0: ts.frame0,
      frame1: ts.frame1,
      camera: s.camera,
      layers: s.layers,
      shots,
      effects: s.effects,
      post: s.post,
      audio,
      asserts: s.asserts,
    };
  });

  // ---- 音频计划
  const rawAudio = spec.audio;
  let music: AudioPlan['music'] = null;
  if (rawAudio.music) {
    // library:// 引用：解析到库 blob（内容寻址；contentHash=条目 sha256）；本地路径照旧
    let abs: string;
    let contentHash: string;
    let exists = true;
    const libRef = parseLibraryRef(rawAudio.music.file);
    if (libRef) {
      const res = resolveLibraryRefLite(rawAudio.music.file, kineHomeDir());
      if ('error' in res) {
        issues.push({
          code: res.error.code,
          severity: 'error',
          message: `audio.music.file 库引用解析失败：${res.error.message}`,
          where: { file: '', path: 'audio.music.file' },
          hints: ['kine library list --kind music 查看已入库音乐；或改用工程内相对路径'],
        });
        abs = '';
        contentHash = 'unresolved';
        exists = false;
      } else {
        abs = res.file ?? '';
        contentHash = res.entry.sha256 ?? 'unhashed';
        exists = Boolean(res.file);
      }
    } else {
      abs = isAbsolute(rawAudio.music.file) ? rawAudio.music.file : resolve(projectDir, rawAudio.music.file);
      contentHash = hashFile(abs);
      exists = existsSync(abs);
    }
    music = {
      file: rawAudio.music.file,
      absPath: abs,
      exists,
      gain: rawAudio.music.gain,
      fadeOut: rawAudio.music.fade_out ?? null,
      cutFrom: rawAudio.music.cut_from ?? null,
      contentHash,
    };
  }
  const sfxEvents: SfxEventResolved[] = rawAudio.sfx.events.map((ev, i) => {
    const at = ev.clock === 'render' ? TtoT(map, ev.at) : ev.at;
    return {
      id: `ev${i}`,
      sfx: ev.sfx,
      at,
      gain: ev.gain,
      bus: ev.bus,
      params: ev.params,
      source: 'global',
      declaredClock: ev.clock,
    };
  });
  for (const sc of scenes) {
    for (const ev of sc.audio) {
      sfxEvents.push({
        id: `ev_${sc.id}_${ev.id.split('#')[1]}`,
        sfx: ev.sfx,
        at: ev.t,
        gain: ev.gain,
        bus: ev.bus,
        params: ev.params,
        source: `scene:${sc.id}`,
        declaredClock: 'scene',
      });
    }
  }
  sfxEvents.sort((a, b) => a.at - b.at);
  const audioPlan: AudioPlan = {
    music,
    buses: rawAudio.sfx.buses,
    synth: rawAudio.sfx.synth,
    sfxEvents,
    duration: spec.output.duration,
    frames: map.frames,
    fps,
    droneLevels: rawAudio.drone_levels ?? null,
    tailFade: rawAudio.tail_fade,
  };

  // ---- 断言计划
  const assertPlan: AssertPlanEntry[] = [
    ...spec.asserts.map((a) => ({ ...a, source: 'global' })),
    ...scenes.flatMap((sc) => sc.asserts.map((a) => ({
      ...a,
      source: `scene:${sc.id}`,
      scope: { ...a.scope, scene: a.scope.scene ?? sc.id },
    }))),
  ];

  // ---- 风格档案（theme.profile / theme.palette）：解析 palette → 有效主题
  let effectiveTheme = spec.theme;
  if (spec.theme.palette !== undefined && spec.theme.profile !== 'core') {
    const pr = resolvePalette(spec.theme.palette, kineHomeDir());
    if (pr.ok) {
      effectiveTheme = applyPalette(spec.theme, pr.palette);
    } else {
      issues.push({
        code: pr.error.code,
        severity: 'error',
        message: `theme.palette 解析失败：${pr.error.message}`,
        where: { file: '', path: 'theme.palette' },
        hints: ['kine library list --kind palette 查看已注册色板；或改用内置 "core"'],
      });
    }
  }
  const hashTheme = canonicalTheme(effectiveTheme);

  // ---- 视觉资产内容哈希（library:// 条目 sha 或本地文件内容；空则不进入哈希输入——旧工程字节级兼容）
  const assets: { ref: string; sha256: string | null }[] = [];
  for (const sc of spec.scenes) {
    for (const layer of sc.layers) {
      if (layer.kind !== 'image' && layer.kind !== 'video') continue;
      const src = layer.src;
      const libRef = parseLibraryRef(src);
      if (libRef) {
        const res = resolveLibraryRefLite(src, kineHomeDir());
        assets.push({ ref: src, sha256: 'error' in res ? null : (res.entry.sha256 ?? null) });
      } else {
        const abs = isAbsolute(src) ? src : resolve(projectDir, src);
        assets.push({ ref: src, sha256: existsSync(abs) ? hashFile(abs) : null });
      }
    }
  }
  const assetsInput = assets.length > 0 ? assets : undefined;

  // ---- hashes
  const themeHash = hashValue(hashTheme);
  const paceHash = hashValue({ duration: spec.output.duration, pace: spec.pace });
  const timePlanHash = hashValue({ duration: spec.output.duration, fps, pace: spec.pace, durs: spec.scenes.map((s) => s.dur) });
  const sfxPlanHash = hashValue({ synth: rawAudio.sfx.synth, synthVersion: SYNTH_VERSION, events: sfxEvents.map((e) => ({ sfx: e.sfx, at: e.at, gain: e.gain, bus: e.bus, params: e.params })), buses: rawAudio.sfx.buses, drone: audioPlan.droneLevels, tailFade: rawAudio.tail_fade });
  const musicHash = music ? `${music.contentHash}:${music.gain}:${JSON.stringify(music.fadeOut)}:${music.cutFrom}` : 'none';

  // specHash 输入净化：absPath/exists 是位置/环境派生事实，不得进入工程身份（拷贝工程/换目录后哈希必须一致）
  let hashMusic: unknown = null;
  if (audioPlan.music) {
    const { absPath: _absPath, exists: _exists, ...musicSpec } = audioPlan.music;
    hashMusic = musicSpec;
  }
  const hashAudioPlan = { ...audioPlan, music: hashMusic };

  const irSansHash = {
    hashScheme: HASH_SCHEME,
    schema: 'kine/1' as const,
    project: spec.project,
    output: spec.output,
    pace: spec.pace,
    theme: hashTheme,
    render: spec.render,
    scenes,
    audioPlan: hashAudioPlan,
    assertPlan,
    time: { map },
    ...(assetsInput ? { assets: assetsInput } : {}),
  };
  const specHash = hashValue(irSansHash);

  // 视觉哈希：排除 audioPlan 与 assertPlan —— 音频/断言改动不重渲帧（impact 表纪律，P4/P7）
  const visualScenes = scenes.map((sc) => {
    const { audio: _audio, ...rest } = sc;
    return rest;
  });
  const visualHash = hashValue({
    renderVersion: RENDER_VERSION,
    schema: irSansHash.schema,
    project: irSansHash.project,
    output: irSansHash.output,
    pace: irSansHash.pace,
    theme: irSansHash.theme,
    render: irSansHash.render,
    scenes: visualScenes,
    time: irSansHash.time,
    ...(assetsInput ? { assets: assetsInput } : {}),
  });

  const deps = buildDeps({
    specHash, themeHash, paceHash, timePlanHash, sfxPlanHash, musicHash,
    scenes: scenes.map((s) => s.id),
    duration: spec.output.duration,
    sceneDurs: scenes.map((s) => ({ id: s.id, dur: s.dur, t0: s.t0, t1: s.t1 })),
  });

  const ir: KineIR = {
    schema: 'kine/1',
    specHash,
    project: spec.project,
    output: spec.output,
    pace: spec.pace,
    theme: effectiveTheme,
    render: spec.render,
    scenes,
    audioPlan,
    assertPlan,
    time: { map },
    hashes: { themeHash, paceHash, timePlanHash, sfxPlanHash, musicHash, visualHash },
    deps,
  };

  // ---- 二次时间自检（E-TIME-001 汇总）
  const sumDur = scenes.reduce((a, s) => a + s.dur, 0);
  const tEnd = TtoT(map, sumDur);
  if (Math.abs(tEnd - spec.output.duration) > 1 / fps + 1e-6) {
    issues.push({
      code: 'E-TIME-001',
      severity: 'error',
      message: `Σ scenes.dur=${sumDur}s 映射回成片时钟为 ${tEnd.toFixed(4)}s，与 output.duration=${spec.output.duration}s 偏差 ${Math.abs(tEnd - spec.output.duration).toFixed(4)}s（> 1 帧）`,
      where: { path: 'output.duration', file: 'timeline.yaml' },
      facts: [`Σ dur=${sumDur}s`, `映射回 t=${tEnd.toFixed(4)}s`, `duration=${spec.output.duration}s`, `1帧=${(1 / fps).toFixed(4)}s`],
      hints: [
        `把最后一段 pace.ratio 调整为 ${(sumDur / Math.max(spec.output.duration, 1e-9)).toFixed(6)} 附近，或调整某幕 dur`,
        `kine map --t ${spec.output.duration} 可查看当前映射`,
      ],
    });
  }

  return { ir, issues };
}

export { sceneLt };

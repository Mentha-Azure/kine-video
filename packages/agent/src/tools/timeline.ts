// @kine/agent — timeline 类工具：compile / map / probe / find / explain
import path from 'node:path';
import {
  pointAt,
  pointAtFrame,
  sceneAtT,
  sceneLt,
  TtoT,
  tToT,
  parseTargetPath,
  computeImpact,
  type KineIR,
  type CompiledScene,
  type Issue,
} from '@kine/dsl';
import { renderDefaults, openRenderSession } from '@kine/render';
import type { ProbeResult } from '@kine/runtime';
import type { AgentContext } from '../context';
import { ok, fail, needInput, ambiguous, type ToolResult, type NextAction } from '../types';

// ---------------------------------------------------------------- compile

export async function toolCompile(
  ctx: AgentContext,
  opts: { writeIR?: boolean; strict?: boolean } = {},
): Promise<ToolResult> {
  const c = await ctx.compile({ fresh: true, writeIR: opts.writeIR, strict: opts.strict });
  const errors = c.issues.filter((i) => i.severity === 'error');
  const warns = c.issues.filter((i) => i.severity === 'warn');
  const ir = c.ir;
  const data = {
    specHash: ir.specHash,
    specHash8: ir.specHash.slice(0, 8),
    output: ir.output,
    duration: ir.time.map.duration,
    durationT: ir.time.map.durationT,
    frames: ir.time.map.frames,
    scenes: ir.scenes.map((s) => ({
      id: s.id,
      name: s.name,
      t0: s.t0,
      t1: s.t1,
      T0: s.T0,
      T1: s.T1,
      frames: s.frame1 - s.frame0,
      rate: s.rate,
      accel: s.accel,
      shots: s.shots.length,
      layers: s.layers.length,
    })),
    counts: {
      scenes: ir.scenes.length,
      layers: ir.scenes.reduce((n, s) => n + s.layers.length, 0),
      shots: ir.scenes.reduce((n, s) => n + s.shots.length, 0),
      sfxEvents: ir.audioPlan.sfxEvents.length,
      asserts: ir.assertPlan.length,
      depsNodes: ir.deps.nodes.length,
    },
    issues: [...errors, ...warns].map(fmtBrief),
  };
  if (errors.length > 0) {
    return fail('compile', errors[0].code, errors[0].message, {
      data,
      facts: errors.map((e) => `${e.code} @ ${e.where?.file ?? 'timeline.yaml'}:${e.where?.line ?? '?'} ${e.message}`),
      hints: errors[0].hints,
      nextActions: [{ tool: 'audit', args: {}, reason: '修复语法错误后重新审计' }],
    });
  }
  return ok('compile', data, {
    facts: [
      `specHash ${ir.specHash.slice(0, 8)} · ${ir.time.map.frames} 帧 @ ${ir.output.fps}fps · 成片 ${ir.output.duration}s（渲染时间轴 ${ir.time.map.durationT}s）`,
      `幕 ${ir.scenes.length} · 层 ${data.counts.layers} · 镜头 ${data.counts.shots} · sfx 事件 ${data.counts.sfxEvents} · 断言 ${data.counts.asserts}`,
      ...warns.slice(0, 5).map((w) => `${w.code} ${w.message}`),
    ],
    nextActions: [
      { tool: 'map', args: {}, reason: '查看整表' },
      { tool: 'audit', args: {}, reason: '三层检查' },
    ],
  });
}

function fmtBrief(i: Issue): { code: string; severity: string; message: string; at?: string } {
  return {
    code: i.code,
    severity: i.severity,
    message: i.message,
    at: i.where?.line != null ? `${i.where.file ?? 'timeline.yaml'}:${i.where.line}` : i.where?.path,
  };
}

// ---------------------------------------------------------------- map

export async function toolMap(
  ctx: AgentContext,
  opts: { t?: number; frame?: number; full?: boolean },
): Promise<ToolResult> {
  const c = await ctx.compile();
  const map = c.ir.time.map;
  if (opts.t != null) {
    if (opts.t < 0 || opts.t > map.duration) {
      return fail('map', 'E-TIME-003', `t=${opts.t}s 超出成片时长 0..${map.duration}s`, {
        hints: [`有效范围 0..${map.duration}`],
      });
    }
    const pt = pointAt(map, opts.t);
    const seg = map.segments.find((s) => s.id === pt.seg);
    const sc = irSceneAt(c.ir, pt.scene);
    const lt = sc ? sceneLt(sc, pt.T) : undefined;
    return ok(
      'map',
      {
        t: pt.t,
        T: +pt.T.toFixed(6),
        frame: pt.frame,
        seg: pt.seg,
        segRatio: seg?.ratio,
        scene: sc
          ? { id: sc.id, name: sc.name, index: c.ir.scenes.indexOf(sc), lt: lt == null ? undefined : +lt.toFixed(4) }
          : null,
      },
      { facts: [`t=${pt.t}s → 渲染时间 T=${pt.T.toFixed(3)}s → 帧 ${pt.frame} · 幕 ${pt.scene}${sc ? ` · 幕内时间 lt=${lt?.toFixed(3)}s` : ''}`] },
    );
  }
  if (opts.frame != null) {
    if (opts.frame < 0 || opts.frame >= map.frames) {
      return fail('map', 'E-TIME-003', `frame=${opts.frame} 超出 0..${map.frames - 1}`, {
        hints: [`总帧数 ${map.frames}`],
      });
    }
    const pt = pointAtFrame(map, opts.frame);
    return ok(
      'map',
      { frame: pt.frame, t: pt.t, T: +pt.T.toFixed(6), seg: pt.seg, scene: pt.scene ?? null },
      { facts: [`frame ${pt.frame} → t=${pt.t.toFixed(3)}s / T=${pt.T.toFixed(3)}s · 幕 ${pt.scene ?? '-'}`] },
    );
  }
  // 整表
  return ok(
    'map',
    {
      fps: map.fps,
      duration: map.duration,
      durationT: map.durationT,
      frames: map.frames,
      breaks: map.breaks.map((b) => ({ frame: b.frame, t: +b.t.toFixed(4), T: +b.T.toFixed(4) })),
      segments: map.segments.map((s) => ({ id: s.id, t0: s.t0, t1: s.t1, ratio: s.ratio, frames: [s.frame0, s.frame1] })),
      scenes: map.scenes.map((s) => ({
        id: s.id,
        T0: s.T0,
        T1: s.T1,
        t0: s.t0,
        t1: s.t1,
        frames: [s.frame0, s.frame1],
        dur: s.dur,
        rate: s.rate,
        accel: s.accel,
      })),
    },
    {
      facts: [
        `${map.frames} 帧 / ${map.duration}s 成片（渲染 ${map.durationT}s）· ${map.segments.length} 个 pace 段 · ${map.breaks.length} 个断点`,
        `断点：${map.breaks.map((b) => `frame ${b.frame} (t=${b.t.toFixed(2)}s)`).join(' · ') || '无'}`,
      ],
    },
  );
}

function irSceneAt(ir: KineIR, id: string | undefined): CompiledScene | undefined {
  return id ? ir.scenes.find((s) => s.id === id) : undefined;
}

// ---------------------------------------------------------------- probe

export async function toolProbe(
  ctx: AgentContext,
  opts: { at: number; hash?: boolean; json?: boolean },
): Promise<ToolResult> {
  const c = await ctx.compile();
  const map = c.ir.time.map;
  if (opts.at < 0 || opts.at > map.duration) {
    return fail('probe', 'E-TIME-003', `at=${opts.at}s 超出成片时长 0..${map.duration}s`);
  }
  const pt = pointAt(map, opts.at);
  const sc = irSceneAt(c.ir, pt.scene);
  const session = await openRenderSession(c.ir, { ...renderDefaults(c.ir, ctx.store.root), tag: 'probe' });
  try {
    const res = (await session.probe(pt.T)) as ProbeResult;
    let hash: string | undefined;
    if (opts.hash) hash = await session.stateHash(pt.T);
    const errs = session.consoleErrors?.() ?? [];
    const data = { ...res, stateHash: hash, consoleErrors: errs };
    const elements = res.elements ?? [];
    return ok('probe', data, {
      facts: [
        `t=${pt.t.toFixed(3)}s / T=${pt.T.toFixed(3)}s / frame ${pt.frame} · 幕 ${sc?.id ?? '-'}${res.scene ? `（lt=${res.scene.lt.toFixed(3)}s）` : ''}`,
        `相机 z1=${res.camera.z1.toFixed(3)} tw=${res.camera.tw} · 元素 ${elements.length} 个：${elements
          .slice(0, 6)
          .map((e) => `${e.id}(${e.kind}${e.widget ? `:${e.widget}` : ''})`)
          .join('、')}${elements.length > 6 ? ' …' : ''}`,
        ...(hash ? [`stateHash ${hash}`] : []),
      ],
      nextActions: [
        { tool: 'measure', args: { metric: 'density', at: pt.t }, reason: '量该时刻密度' },
        { tool: 'explain', args: { path: `scenes[${sc?.id}].camera` }, reason: '查看相机定义' },
      ],
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return fail('probe', 'E-RUNTIME-001', `运行时 probe 失败：${msg}`, {
      facts: [`t=${pt.t}s / T=${pt.T}s · 幕 ${sc?.id ?? '-'}`],
      hints: ['先跑 kine audit 定位运行时错误', '检查该幕是否有未注册 widget'],
    });
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------- find

interface FindCandidate {
  id: string;
  kind: string;
  scene: string;
  sceneIndex: number;
  widget?: string;
  alias?: string;
  tags?: string[];
  t0: number;
  t1: number;
  score: number;
  matchedBy: string;
  measure?: Record<string, unknown>;
}

export async function toolFind(
  ctx: AgentContext,
  opts: { query: string; scene?: string; range?: [number, number]; kind?: string; limit?: number },
): Promise<ToolResult> {
  const c = await ctx.compile();
  const q = opts.query.trim();
  if (!q) return needInput('find', '请提供查询词（元素 alias / id / widget / 文本内容）');
  const ql = q.toLowerCase();
  const candidates: FindCandidate[] = [];

  for (let si = 0; si < c.ir.scenes.length; si++) {
    const sc = c.ir.scenes[si];
    if (opts.scene && sc.id !== opts.scene) continue;
    const sceneT0 = sc.t0;
    const sceneT1 = sc.t1;
    for (const layer of sc.layers as unknown as Record<string, unknown>[]) {
      const id = String(layer.id ?? '');
      const kind = String(layer.kind ?? '');
      if (opts.kind && kind !== opts.kind) continue;
      const alias = typeof layer.alias === 'string' ? layer.alias : undefined;
      const tags = Array.isArray(layer.tags) ? (layer.tags as string[]) : undefined;
      const widget = typeof layer.widget === 'string' ? layer.widget : undefined;
      const content = typeof layer.content === 'string' ? layer.content : undefined;
      const win = Array.isArray(layer.window) ? (layer.window as [number, number]) : null;
      const t0 = win ? sceneT0 + Math.max(0, Math.min(win[0], sc.dur)) : sceneT0;
      const t1 = win ? sceneT0 + Math.max(0, Math.min(win[1], sc.dur)) : sceneT1;
      if (opts.range) {
        const [a, b] = opts.range;
        if (t1 < a || t0 > b) continue;
      }

      let score = 0;
      let matchedBy = '';
      const set = (s: number, by: string) => {
        if (s > score) {
          score = s;
          matchedBy = by;
        }
      };
      if (alias && alias === q) set(1.0, 'alias 精确');
      if (id && id === q) set(1.0, 'id 精确');
      if (tags && tags.some((t) => t === q)) set(0.9, 'tag 精确');
      if (widget && widget.toLowerCase() === ql) set(0.85, 'widget 精确');
      if (alias && alias.toLowerCase().includes(ql)) set(0.8, 'alias 模糊');
      if (widget && widget.toLowerCase().includes(ql)) set(0.75, 'widget 模糊');
      if (id && id.toLowerCase().includes(ql)) set(0.7, 'id 模糊');
      if (tags && tags.some((t) => t.toLowerCase().includes(ql))) set(0.7, 'tag 模糊');
      if (content && content.toLowerCase().includes(ql)) set(0.6, '文本内容');
      if (score <= 0) continue;

      const props = (layer.props ?? {}) as Record<string, unknown>;
      const measure: Record<string, unknown> = {};
      for (const k of ['period', 'speed', 'type_period', 'speed', 'size', 'rings', 'lines', 'nodes', 'bars', 'count']) {
        if (props[k] !== undefined) measure[k] = props[k];
      }
      if (typeof layer.type_period === 'number') measure.text_period = layer.type_period;
      candidates.push({
        id,
        kind,
        scene: sc.id,
        sceneIndex: si,
        widget,
        alias,
        tags,
        t0: +t0.toFixed(3),
        t1: +t1.toFixed(3),
        score,
        matchedBy,
        measure: Object.keys(measure).length ? measure : undefined,
      });
    }
  }

  candidates.sort((a, b) => b.score - a.score || (a.sceneIndex - b.sceneIndex) || a.id.localeCompare(b.id));
  const top = candidates[0];
  const second = candidates[1];
  const page = candidates.slice(0, opts.limit ?? 8);

  const facts = page.map(
    (cd) =>
      `scenes[${cd.scene}].layers[${cd.id}]${cd.widget ? ` ${cd.widget}` : ''}${cd.alias ? ` 「${cd.alias}」` : ''} · 活跃 ${cd.t0}-${cd.t1}s · 匹配 ${cd.matchedBy} ${cd.score.toFixed(2)}${cd.measure ? ` · measure ${JSON.stringify(cd.measure)}` : ''}`,
  );

  if (!top) {
    return needInput('find', `未找到与「${q}」匹配的元素（alias / id / tag / widget / 文本内容）`, [
      '可用 kine info 查看工程元素清单，或用更短的关键词',
    ]);
  }
  const lowConfidence = top.score < 0.75;
  const closeCall = second != null && second.score >= 0.55 && top.score - second.score < 0.2;
  if (lowConfidence || closeCall) {
    return ambiguous(
      'find',
      `「${q}」有 ${candidates.length} 个候选，无法确定目标`,
      page.map((cd) => ({
        label: `${cd.scene} · ${cd.id}${cd.widget ? ` (${cd.widget})` : ''} ${cd.matchedBy} ${cd.score.toFixed(2)}`,
        id: cd.id,
        facts: cd.measure ? [JSON.stringify(cd.measure)] : [cd.matchedBy],
      })),
    );
  }
  return ok('find', { candidates: page, total: candidates.length }, {
    verdict: 'PASS',
    facts: facts.slice(0, 5),
    nextActions: [{ tool: 'probe', args: { at: (top.t0 + top.t1) / 2 }, reason: '看该元素运行态' }],
    total: candidates.length,
  });
}

// ---------------------------------------------------------------- explain

export async function toolExplain(ctx: AgentContext, opts: { path: string }): Promise<ToolResult> {
  const c = await ctx.compile();
  const loaded = c.loaded;
  const p = opts.path.trim();
  const resolved = resolveSpecPath(loaded.raw, loaded.spec as unknown as Record<string, unknown>, p, loaded.lineOf);
  if (!resolved.found) {
    return fail('explain', 'E-TX-004', `无法解析路径：${p}`, {
      hints: ['路径示例：scenes[code].camera.tw · theme.post.vignette.base · pace.segments[fast].ratio'],
    });
  }
  const target = parseTargetPath(p);
  const sceneIds = c.ir.scenes.map((s) => s.id);
  const framesPerScene: Record<string, number> = {};
  for (const s of c.ir.scenes) framesPerScene[s.id] = s.frame1 - s.frame0;
  const impact = computeImpact({
    targets: [target],
    sceneIds,
    framesPerScene,
    totalFrames: c.ir.time.map.frames,
    nScenes: c.ir.scenes.length,
  });

  // drives / dependsOn（依赖图子集）
  const drives = new Set<string>();
  const dependsOn = new Set<string>();
  for (const id of impact.invalidates) {
    drives.add(id);
    for (const [from, to] of c.ir.deps.edges) if (to === id) dependsOn.add(from);
  }

  // effectiveTime（pace / rate / accel 必须给公式与数值）
  const effectiveTime = explainEffectiveTime(c.ir, p, target);

  const data = {
    path: p,
    kind: target.kind,
    sceneId: target.sceneId,
    layerId: target.layerId,
    field: target.field,
    value: resolved.value,
    definedAt: resolved.line != null ? `${path.basename(loaded.file)}:${resolved.line}` : undefined,
    drives: [...drives],
    dependsOn: [...dependsOn],
    effectiveTime,
    impactIfChanged: impact,
  };
  const facts: string[] = [`${p} = ${JSON.stringify(resolved.value)}${resolved.line != null ? `（${path.basename(loaded.file)}:${resolved.line}）` : ''}`];
  if (effectiveTime?.formula) facts.push(effectiveTime.formula);
  for (const l of effectiveTime?.notes ?? []) facts.push(l);
  if (impact.warnings.length) facts.push(...impact.warnings);
  return ok('explain', data, {
    facts,
    nextActions: [
      { tool: 'impact', args: { patch: `${p}=<新值>` }, reason: '看改动影响' },
      { tool: 'edit', args: { patch: `${p}=<新值>`, quote: '<用户原话>' }, reason: '事务化修改' },
    ],
  });
}

function explainEffectiveTime(
  ir: KineIR,
  p: string,
  t: ReturnType<typeof parseTargetPath>,
): { formula?: string; values?: Record<string, unknown>; notes?: string[] } | undefined {
  const map = ir.time.map;
  if (t.kind === 'pace') {
    const segs = ir.pace.segments;
    const notes = segs.map((s, i) => {
      const t0v = i === 0 ? 0 : segs[i - 1].until;
      const T0v = map.segments[i]?.T0 ?? 0;
      return `段 ${s.id}: t∈[${t0v}, ${s.until}) ratio=${s.ratio} → T=${TtoT(map, (t0v + s.until) / 2).toFixed(3)}（t=${((t0v + s.until) / 2).toFixed(3)} 处示例）`;
    });
    return {
      formula: 'T(t)=Σ_{k<i}dur_k+(t-until_{i-1})·ratio_i；t(T) 为其反函数',
      values: { segments: segs, durationT: map.durationT, breaks: map.breaks },
      notes,
    };
  }
  if (t.kind === 'scene' && t.sceneId && (t.field === 'rate' || t.field === 'accel' || t.field === undefined)) {
    const sc = ir.scenes.find((s) => s.id === t.sceneId);
    if (!sc) return undefined;
    const durEff = sc.dur;
    if (sc.accel === 'none') {
      return {
        formula: `lt=(T-T0)·rate = (T-${sc.T0.toFixed(3)})·${sc.rate}`,
        values: { T0: sc.T0, T1: sc.T1, dur: sc.dur, rate: sc.rate, ltAtEnd: sc.dur },
        notes: [`无加速（accel=none）：lt 0→${sc.dur}s 覆盖整幕`],
      };
    }
    const freezeT = sc.T0 + sc.dur / sc.accelFactor;
    return {
      formula: `lt=min((T-T0)·rate·accelFactor, dur)；accelFactor=${sc.accelFactor.toFixed(4)}`,
      values: {
        accelFactor: sc.accelFactor,
        freezeFromT: +freezeT.toFixed(3),
        freezeFromT_relative: +(freezeT - sc.T0).toFixed(3),
        holdSeconds: +(sc.T1 - freezeT).toFixed(3),
        dur: sc.dur,
      },
      notes: [
        `accel=cut：动画被压缩 ${sc.accelFactor.toFixed(3)}×，从 T=${freezeT.toFixed(3)}s 起保持末姿（持续 ${(sc.T1 - freezeT).toFixed(2)}s）`,
        '镜头数变化后需重新校准以 lt 为判据的阈值（W-ACC-001）；改动前先看 impact',
      ],
    };
  }
  if (t.kind === 'output' && (t.field === 'duration' || t.field === 'fps')) {
    return {
      formula: 'frame=round(t·fps)；总帧数=duration·fps',
      values: { duration: map.duration, fps: map.fps, frames: map.frames },
      notes: ['output.duration 是成片秒唯一真源；pace 只为音画同轴'],
    };
  }
  return undefined;
}

// ---------------------------------------------------------------- 路径解析

interface ResolvedPath {
  found: boolean;
  value?: unknown;
  line?: number;
}

/** 解析 JSONPath-ish 路径（支持 scenes[id].layers[id].props.x 与数字下标） */
export function resolveSpecPath(
  raw: Record<string, unknown>,
  _spec: Record<string, unknown>,
  pathStr: string,
  lineOf?: (path: (string | number)[]) => number | undefined,
): ResolvedPath {
  const toks = tokenizeLite(pathStr);
  if (!toks) return { found: false };
  let cur: unknown = raw;
  const linePath: (string | number)[] = [];
  for (const tk of toks) {
    if (cur == null) return { found: false };
    if (tk.key != null) {
      if (typeof cur !== 'object') return { found: false };
      cur = (cur as Record<string, unknown>)[tk.key];
      linePath.push(tk.key);
      if (cur === undefined) return { found: false };
    } else if (tk.sel != null) {
      if (!Array.isArray(cur)) return { found: false };
      let idx = -1;
      if (/^\d+$/.test(tk.sel)) idx = parseInt(tk.sel, 10);
      else idx = cur.findIndex((it) => it && typeof it === 'object' && (it as Record<string, unknown>).id === tk.sel);
      if (idx < 0 || idx >= cur.length) return { found: false };
      cur = cur[idx];
      linePath.push(idx);
    }
  }
  const line = lineOf?.(linePath);
  return { found: true, value: cur, line };
}

interface LiteTok {
  key?: string;
  sel?: string;
}

export function tokenizeLite(pathStr: string): LiteTok[] | null {
  const toks: LiteTok[] = [];
  const re = /^([A-Za-z_][A-Za-z0-9_]*)|\[([^\]]*)\]|\.([A-Za-z_][A-Za-z0-9_]*)/;
  let rest = pathStr.trim();
  // 首个裸键
  let m = re.exec(rest);
  if (!m) return null;
  while (rest.length > 0) {
    m = re.exec(rest);
    if (!m) return null;
    if (m[1] != null) toks.push({ key: m[1] });
    else if (m[2] != null) toks.push({ sel: m[2] });
    else if (m[3] != null) toks.push({ key: m[3] });
    rest = rest.slice(m[0].length);
  }
  return toks;
}

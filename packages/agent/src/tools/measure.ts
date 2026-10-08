// kine.measure —— 指标实测：值 + 期望对比 + 可引用 facts
import { listMetricNames, checkExpect, parseExpect, runMetric, metricDef, type MetricScope } from '@kine/metrics';
import type { AgentContext } from '../context';
import { fail, ok, type ToolResult } from '../types';
import { ensureMix, makeFrameProvider, parseRangeSpec } from './util';

export interface MeasureOptions {
  metric: string;
  scene?: string;
  range?: string | [number, number];
  at?: number | string;
  expect?: string;
  /** 采样步长覆盖（秒；仅 range 采样生效；默认 0.4）——缺陷 #7：可配置采样密度 */
  step?: number;
}

export async function toolMeasure(ctx: AgentContext, opts: MeasureOptions): Promise<ToolResult> {
  const ir = ctx.ir();
  const name = opts.metric;
  let def;
  try {
    def = metricDef(name);
  } catch {
    return fail('measure', 'E-METRIC-001', `未知指标 "${name}"`, {
      facts: [`可用指标：${listMetricNames().join(', ')}`],
      hints: ['用法：kine measure density --scene title'],
    });
  }
  const scopeCount = [opts.scene, opts.range, opts.at].filter((v) => v !== undefined).length;
  if (scopeCount > 1) {
    return fail('measure', 'E-METRIC-002', 'scope 三选一：--scene / --range / --at 只能给一个');
  }
  const scope: MetricScope = {};
  if (opts.scene) {
    if (!ir.scenes.some((s) => s.id === opts.scene)) {
      return fail('measure', 'E-METRIC-002', `未知幕 id "${opts.scene}"`, {
        facts: [`已知幕：${ir.scenes.map((s) => s.id).join(', ')}`],
      });
    }
    scope.scene = opts.scene;
  }
  if (opts.range) {
    // v3 P0-1：严格解析（成片秒 a:b 或数值数组）；禁止字符串按字符展开的静默错数据
    const rr = parseRangeSpec(opts.range, ir.time.map.duration);
    if (!rr.ok) return fail('measure', 'E-METRIC-003', rr.message ?? '--range 非法', { hints: rr.hints });
    scope.range = rr.range!;
  }
  if (opts.at !== undefined) scope.at = opts.at;
  if (opts.step !== undefined && opts.step > 0) scope.step = opts.step;

  const frames = makeFrameProvider(ctx, ir, 'measure');
  const mixWav = def.audio === 'mix' || def.audio === 'music' ? await ensureMix(ctx, ir) : null;
  const musicWav = def.audio === 'music' ? ir.audioPlan?.music?.absPath ?? null : null;

  let res;
  try {
    ctx.progress('measure', `采样 ${name} …`);
    res = await runMetric(name, scope, {
      ir,
      frames,
      mixWav: mixWav ?? undefined,
      musicWav: musicWav ?? undefined,
      artifactsDir: ctx.store.layout.kineDir,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return fail('measure', 'E-METRIC-003', `指标运行失败：${msg}`, {
      hints: /需要 FrameProvider|mixWav|musicWav/.test(msg) ? ['该指标需要额外输入（先 build 音频或检查帧抓取环境）'] : [],
    });
  }

  if (res.value === null) {
    return fail('measure', 'E-METRIC-005', '该指标在当前输入下无数值', {
      hints: ['检查该指标所需输入（帧/音频）是否可用'],
    });
  }
  let verdict: 'PASS' | 'FAIL' | undefined;
  let expectLine: string | undefined;
  if (opts.expect) {
    const parsed = parseExpect(opts.expect);
    if (!parsed) {
      return fail('measure', 'E-METRIC-004', `无法解析期望表达式 "${opts.expect}"`, {
        hints: ['示例：">= 0.9 %"、"in 6..9"、"<= 2 px"'],
      });
    }
    const passed = checkExpect(parsed, res.value, { min: res.agg.min, max: res.agg.max });
    verdict = passed ? 'PASS' : 'FAIL';
    expectLine = `期望 ${opts.expect} → 实测 ${fmt(res.value, res.unit)} → ${verdict}`;
  }

  const disp = fmt(res.value, res.unit);
  const facts: string[] = [
    `${name} = ${disp}（样本 ${res.sample.frames.length} 点${res.sample.step ? `，步进 ${res.sample.step}s` : ''}）`,
    res.interpretation,
    ...(expectLine ? [expectLine] : []),
  ];
  if (res.agg.min !== res.agg.max) facts.push(`区间 min ${fmt(res.agg.min, res.unit)} / max ${fmt(res.agg.max, res.unit)}`);

  return ok(
    'measure',
    {
      metric: name,
      value: res.value,
      unit: res.unit,
      expect: opts.expect,
      verdict,
      scope: res.scope,
      agg: res.agg,
      sample: { frames: res.sample.frames, step: res.sample.step, grid: (res.extras as Record<string, unknown> | undefined)?.grid ?? undefined },
      extras: res.extras,
      interpretation: res.interpretation,
      facts: res.facts,
    },
    {
      verdict: verdict ?? 'PASS',
      facts,
      hints: verdict === 'FAIL' ? ['用 kine explain 定位相关参数，kine impact 看改动影响'] : [],
      nextActions:
        verdict === 'FAIL'
          ? [{ tool: 'kine.explain', args: { path: '$定位相关元素' }, reason: '定位可改参数' }]
          : [{ tool: 'kine.check', args: {}, reason: '运行完整断言集' }],
    }
  );
}

function fmt(v: number, unit: string): string {
  if (unit === 'ratio') return `${(v * 100).toFixed(2)}%`;
  if (unit === 'px' || unit === 'ms' || unit === 's') return `${v.toFixed(2)}${unit}`;
  if (unit === 'level' || unit === 'dB') return `${v.toFixed(2)}${unit === 'dB' ? 'dB' : ''}`;
  if (unit === 'count') return `${Math.round(v)}`;
  return `${v}`;
}

// kine.check —— 断言集执行 + 基线 diff + 报告写盘
import { join } from 'node:path';
import { runAsserts, type AssertReport } from '@kine/metrics';
import { diffBaseline, latestBaseline, tsStamp, writeJsonAtomic, atomicWriteFile, type BaselineData } from '@kine/store';
import { ensureDir } from '@kine/render';
import type { AgentContext } from '../context';
import { fail, ok, type ToolResult } from '../types';
import { ensureMix, makeFrameProvider } from './util';

export interface CheckOptions {
  id?: string;
  noBaseline?: boolean;
}

export async function toolCheck(ctx: AgentContext, opts: CheckOptions = {}): Promise<ToolResult> {
  const ir = ctx.ir();
  const store = ctx.store;

  const frames = makeFrameProvider(ctx, ir, 'check');
  const mixWav = await ensureMix(ctx, ir);
  const musicWav = ir.audioPlan?.music?.absPath ?? null;

  let report: AssertReport;
  try {
    ctx.progress('check', '运行断言集…');
    report = await runAsserts(
      ir,
      {
        ir,
        frames,
        mixWav: mixWav ?? undefined,
        musicWav: musicWav ?? undefined,
        artifactsDir: store.layout.kineDir,
      },
      opts.id ? { onlyId: opts.id } : {}
    );
  } catch (e) {
    return fail('check', 'E-CHECK-001', `断言执行失败：${e instanceof Error ? e.message : String(e)}`);
  }

  // ---- 基线 diff（自动与最近基线对照）
  let diff: unknown;
  let regressions: string[] = [];
  if (!opts.noBaseline) {
    try {
      const latest = latestBaseline(store.layout.baselineDir);
      if (latest) {
        const current: BaselineData = {
          version: 'current',
          ts: new Date().toISOString(),
          specHash: ir.specHash,
          specHash8: ir.specHash.slice(0, 8),
          metrics: Object.fromEntries(
            report.results.map((r) => [r.id, { value: r.value ?? 'n/a', unit: r.unit, verdict: r.verdict }])
          ),
          keyframes: [],
          audio: {},
          paceBreaks: ir.time.map.breaks.map((b) => ({ frame: b.frame, t: b.t, T: b.T })),
        };
        const d = diffBaseline(latest, current);
        diff = d;
        regressions = d.metrics.filter((m) => m.verdict === 'regressed').map((m) => `${m.key}: ${m.a} → ${m.b}`);
      }
    } catch { /* 基线不可用时忽略 */ }
  }

  // ---- 报告写盘（机器 JSON + 人读 markdown）
  const reportsDir = join(store.layout.kineDir, 'reports');
  await ensureDir(reportsDir);
  const stamp = tsStamp();
  const jsonFile = join(reportsDir, `check_${stamp}.json`);
  const mdFile = join(reportsDir, `check_${stamp}.md`);
  await writeJsonAtomic(jsonFile, { report: report.json, diff });
  await atomicWriteFile(mdFile, buildMarkdown(report, diff, regressions));

  const hardFails = report.results.filter((r) => r.severity === 'error' && r.verdict === 'FAIL');
  const warnFails = report.results.filter((r) => r.severity === 'warn' && r.verdict === 'FAIL');
  const pass = hardFails.length === 0;

  const facts: string[] = [
    `断言 ${report.results.length} 条：PASS ${report.passCount} / FAIL ${report.failCount} / SKIP ${report.skipCount}`,
  ];
  for (const r of [...hardFails, ...warnFails].slice(0, 8)) {
    facts.push(`${r.verdict === 'FAIL' ? '✗' : '!'} ${r.id}（${r.metric}）期望 ${r.expect}，实测 ${r.display}${r.severity === 'warn' ? '（warn）' : ''}`);
    if (r.interpretation) facts.push(`   ${r.interpretation}`);
  }
  if (regressions.length > 0) {
    facts.push(`⚠ 基线回归：${regressions.join('；')}（回归红线 PASS→FAIL 必须在交付说明解释）`);
  } else if (diff) {
    facts.push('与最近基线对比：无 PASS→FAIL 回归');
  }
  facts.push(`报告：${mdFile}`);

  const verdict = pass ? 'PASS' : 'FAIL';
  return ok(
    'check',
    {
      verdict,
      results: report.results.map((r) => ({
        id: r.id,
        metric: r.metric,
        scope: r.scope,
        expect: r.expect,
        severity: r.severity,
        verdict: r.verdict,
        value: r.value,
        unit: r.unit,
        display: r.display,
        sample: r.sample,
      })),
      passCount: report.passCount,
      failCount: report.failCount,
      skipCount: report.skipCount,
      diff,
      regressions,
      reportMarkdown: report.markdown,
      files: { json: jsonFile, md: mdFile },
    },
    {
      verdict,
      facts,
      hints: pass
        ? ['断言全绿：可 render → verify → 交付']
        : ['FAIL 断言：先用 measure 复核，再用 explain 定位参数'],
      nextActions: pass
        ? [{ tool: 'kine.render', args: {}, reason: '出片' }]
        : hardFails.slice(0, 3).map((r) => ({ tool: 'kine.measure', args: { metric: r.metric, scene: r.scope?.scene }, reason: `复核 ${r.id}` })),
    }
  );
}

function buildMarkdown(report: AssertReport, diff: unknown, regressions: string[]): string {
  const lines: string[] = [];
  lines.push('# kine check 报告', '');
  lines.push(`生成时间：${new Date().toISOString()}`, '');
  lines.push(`PASS ${report.passCount} / FAIL ${report.failCount} / SKIP ${report.skipCount}`, '');
  const d = diff as { metrics?: Array<{ key: string; a: number | string; b: number | string; verdict: string }> } | undefined;
  if (regressions.length > 0) {
    lines.push('## ⚠ 基线回归（必须解释）', '');
    for (const r of regressions) lines.push(`- ${r}`);
    lines.push('');
  } else if (d) {
    lines.push('## 基线对比', '', '无 PASS→FAIL 回归。', '');
  }
  lines.push('## 断言明细', '');
  lines.push('| id | 指标 | scope | 期望 | 实测 | 严重度 | 判定 |');
  lines.push('|---|---|---|---|---|---|---|');
  for (const r of report.results) {
    const sc = r.scope;
    const scope = sc?.scene ? `scene:${sc.scene}` : sc?.range ? `range:${sc.range.join('..')}` : sc?.at ?? '全片';
    lines.push(`| ${r.id} | ${r.metric} | ${scope} | ${r.expect} | ${r.display} | ${r.severity} | ${r.verdict} |`);
  }
  lines.push('');
  for (const r of report.results) {
    if (r.verdict === 'FAIL' || r.verdict === 'SKIP') {
      lines.push(`### ${r.id} — ${r.verdict}`, '');
      if (r.facts.length > 0) for (const f of r.facts) lines.push(`- ${f}`);
      if (r.interpretation) lines.push(`- ${r.interpretation}`);
      lines.push('');
    }
  }
  return lines.join('\n');
}
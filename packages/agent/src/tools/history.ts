// history.ts — changelog / rollback / baseline / diff
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import {
  readChangelog, nextTxId, rollbackEdit, since, findEntry,
  saveBaseline, latestBaseline, loadBaseline, listBaselines, diffBaseline,
  baselineFile, readLatest, listVersions, atomicWriteFile,
  type BaselineData, type BaselineMetric, type ChangelogEntry,
} from '@kine/store';
import { ensureDir } from '@kine/render';
import { pointAtFrame, sceneAtT, TtoT } from '@kine/dsl';
import { ok, fail, type ToolResult } from '../types';
import type { AgentContext } from '../context';
import { framesPerScene, ensureMix, makeFrameProvider } from './util';
import { runMetric } from '@kine/metrics';

const KEYFRAME_PCT = 0.62;

// ── changelog ────────────────────────────────────────────────────────
export async function toolChangelog(ctx: AgentContext, args: { since?: string; tx?: string; limit?: number }): Promise<ToolResult> {
  const store = ctx.store;
  let entries: ChangelogEntry[];
  if (args.tx) {
    const e = findEntry(store.layout.changelogFile, args.tx);
    if (!e) return fail('changelog', 'E-TX-005', `找不到事务 ${args.tx}`, { hints: ['kine changelog 查看全部记录'] });
    entries = [e];
  } else {
    entries = readChangelog(store.layout.changelogFile);
    if (args.since) {
      try { entries = since(store.layout.changelogFile, args.since); }
      catch { return fail('changelog', 'E-TX-004', `无法解析 --since "${args.since}"`, { hints: ['支持 30m / 2h / 1d 或 ISO 时间'] }); }
    }
  }
  const limit = Math.max(1, args.limit ?? 50);
  const list = entries.slice(-limit).reverse();
  const facts = [`共 ${entries.length} 条事务记录（显示最近 ${list.length} 条）`];
  for (const e of list) {
    facts.push(`${e.tx} · ${e.ts} · ${e.tool}${e.rollbackOf ? ` (rollback of ${e.rollbackOf})` : ''} — "${truncate(e.quote, 42)}"`);
    facts.push(`    ${e.patch.slice(0, 120)}`);
    if (e.impact) facts.push(`    invalidates: ${e.impact.invalidates.slice(0, 6).join(', ')}${e.impact.invalidates.length > 6 ? ' …' : ''}`);
    if (e.preview) facts.push(`    preview: ${e.preview}`);
  }
  if (list.length === 0) facts.push('（无记录）');
  const nextTx = nextTxId(store.layout.changelogFile);
  return ok('changelog', { entries: list, total: entries.length, nextTxId: nextTx }, { facts });
}

function truncate(s: string, n: number): string { return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// ── rollback ─────────────────────────────────────────────────────────
export async function toolRollback(ctx: AgentContext, args: { txId: string }): Promise<ToolResult> {
  const store = ctx.store;
  if (!args.txId) return fail('rollback', 'E-TX-006', '缺少 txId', { hints: ['kine rollback tx_20261007_003'] });
  try {
    const r = await rollbackEdit(store, args.txId, { tool: 'rollback' });
    ctx.clearCompileCache();
    const facts = [
      `已回滚 ${args.txId}（方式：${String(r.entry.details?.restoredFrom ?? 'backup 还原')}）`,
      `回滚事务：${r.entry.tx}`,
      '缓存将在下次 render/measure 时按 specHash 自动失效',
    ];
    return ok('rollback', { rolledBack: r.rolledBack, entry: r.entry }, {
      facts,
      nextActions: [
        { tool: 'kine.audit', reason: '回滚后建议重跑语法与运行时检查' },
        { tool: 'kine.render', reason: '重新出片' },
      ],
    });
  } catch (e) {
    const msg = (e as Error).message;
    const code = msg.includes('E-TX-005') ? 'E-TX-005' : 'E-TX-003';
    return fail('rollback', code, `回滚失败：${msg}`, { hints: ['kine changelog 查看可用 txId'] });
  }
}

// ── baseline ─────────────────────────────────────────────────────────
export async function toolBaseline(ctx: AgentContext, args: { save?: boolean; version?: string }): Promise<ToolResult> {
  const store = ctx.store;
  const { ir } = await ctx.compile();
  if (!args.save) {
    const list = listBaselines(store.layout.baselineDir);
    const latest = latestBaseline(store.layout.baselineDir);
    const facts = [`共 ${list.length} 个基线：${list.join(', ') || '（无）'}`];
    if (latest) facts.push(`最新基线：${latest.version}（${latest.ts}，specHash ${latest.specHash8}，${Object.keys(latest.metrics).length} 项指标，${latest.keyframes.length} 个关键帧）`);
    return ok('baseline', { baselines: list, latest }, { facts, hints: ['kine baseline --save 保存当前状态为基线'] });
  }

  // 收集指标全集（视觉 + 音频）
  const frames = makeFrameProvider(ctx, ir, 'baseline');
  const mixWav = await ensureMix(ctx, ir);
  const metrics: Record<string, BaselineMetric> = {};
  const visual: string[] = ['density', 'frame_diff', 'edge_band', 'black_level', 'static_ratio', 'cam_jitter', 'transition_spike'];
  for (const name of visual) {
    ctx.progress('baseline', `measure ${name}`);
    const r = await runMetric(name, {}, { ir, frames, mixWav: mixWav ?? undefined, artifactsDir: store.layout.kineDir });
    metrics[name] = { value: r.value ?? 'n/a', unit: r.unit };
  }

  // 关键帧 stateHash：每幕 62% 处
  const { openRenderSession } = await import('@kine/render');
  const d = (await import('@kine/render')).renderDefaults(ir, store.root);
  const session = await openRenderSession(ir, { ...d, tag: 'baseline' });
  const keyframes: BaselineData['keyframes'] = [];
  try {
    const rows = ir.scenes.map((s) => {
      const f = Math.round(s.frame0 + KEYFRAME_PCT * (s.frame1 - s.frame0));
      return { scene: s.id, frame: f, T: pointAtFrame(ir.time.map, f).T };
    });
    const hashes = await session.hashMany(rows.map((r) => r.T));
    rows.forEach((r, i) => keyframes.push({ scene: r.scene, frame: r.frame, stateHash: hashes[i].hash }));
  } finally {
    await session.close();
  }

  // 音频特征
  const audio: Record<string, number | string | null> = {};
  if (mixWav) {
    const py = await (await import('@kine/store')).getKinePy();
    const st = await py.call<{ peakDbfs: number; rmsDbfs: number; t99_9: number; tailPeakDbfs: number }>('audio_stats', { wav: mixWav, window: 0.1 });
    audio.peak_dbfs = round3(st.peakDbfs);
    audio.rms_dbfs = round3(st.rmsDbfs);
    audio.t99_9_s = round3(st.t99_9);
    audio.tail_peak_dbfs = round3(st.tailPeakDbfs);
  }

  const version = args.version ?? readLatest(store.layout.outDir)?.version ?? ir.project.version;
  const data: BaselineData = {
    version,
    ts: new Date().toISOString(),
    specHash: ir.specHash,
    specHash8: ir.specHash.slice(0, 8),
    metrics,
    keyframes,
    audio,
    paceBreaks: ir.time.map.breaks,
  };
  await ensureDir(store.layout.baselineDir);
  const file = saveBaseline(store.layout.baselineDir, data);
  const facts = [
    `基线已保存：${path.relative(store.root, file)}`,
    `版本 ${version} · specHash ${data.specHash8} · ${Object.keys(metrics).length} 项指标 · ${keyframes.length} 个关键帧`,
    ...keyframes.map((k) => `  关键帧 ${k.scene} f${k.frame}: ${k.stateHash.slice(0, 12)}…`),
  ];
  return ok('baseline', { file, version, metrics, keyframes }, { facts });
}

function round3(v: number): number { return Math.round(v * 1000) / 1000; }

// ── diff（三联报告：指标 / 关键帧 / 语义）──────────────────────────
export async function toolDiff(ctx: AgentContext, args: { a: string; b: string }): Promise<ToolResult> {
  const store = ctx.store;
  const resolve = (v: string): BaselineData | null => {
    if (v === 'latest') return latestBaseline(store.layout.baselineDir);
    return loadBaseline(store.layout.baselineDir, v.startsWith('v') ? v : `v${v}`);
  };
  const a = resolve(args.a ?? '');
  const b = resolve(args.b ?? 'latest');
  if (!a) return fail('diff', 'E-VERIFY-000', `找不到基线 ${args.a}`, { hints: [`可用基线：${listBaselines(store.layout.baselineDir).join(', ') || '（无）'}`] });
  if (!b) return fail('diff', 'E-VERIFY-000', `找不到基线 ${args.b}`, { hints: [`可用基线：${listBaselines(store.layout.baselineDir).join(', ') || '（无）'}`] });
  const d = diffBaseline(a, b);

  const lines: string[] = [];
  lines.push(`# Kine diff：${a.version} → ${b.version}`);
  lines.push('');
  lines.push(`specHash ${a.specHash8} → ${b.specHash8}${d.specHashSame ? '（相同）' : '（已变更）'}`);
  lines.push('');
  lines.push('## 指标');
  lines.push('| 指标 | ' + a.version + ' | ' + b.version + ' | Δ | 判定 |');
  lines.push('|---|---|---|---|---|');
  for (const m of d.metrics) {
    lines.push(`| ${m.key} | ${fmtVal(m.a)} | ${fmtVal(m.b)} | ${m.delta !== undefined ? (m.delta > 0 ? '+' : '') + round3(m.delta) : '-'} | ${m.verdict} |`);
  }
  lines.push('');
  lines.push('## 关键帧 stateHash');
  for (const k of d.keyframes) lines.push(`- ${k.scene} f${k.frame}: ${k.same ? '一致' : `不一致 (${String(k.aHash).slice(0, 10)}… → ${String(k.bHash).slice(0, 10)}…)`}`);
  if (d.keyframes.length === 0) lines.push('-（无关键帧记录）');
  lines.push('');
  lines.push('## 音频');
  for (const m of d.audio) lines.push(`- ${m.key}: ${fmtVal(m.a)} → ${fmtVal(m.b)} (${m.verdict})`);
  if (d.audio.length === 0) lines.push('-（无音频特征记录）');
  lines.push('');
  lines.push('## 语义（changelog 摘录）');
  const entries = readChangelog(store.layout.changelogFile).filter((e) => {
    const inA = e.details?.specHashAfter === a.specHash || e.details?.specHashBefore === a.specHash;
    const inB = e.details?.specHashAfter === b.specHash || e.details?.specHashBefore === b.specHash;
    return !inA && !inB;
  });
  const between = readChangelog(store.layout.changelogFile).slice(-12);
  for (const e of (entries.length ? entries : between)) {
    lines.push(`- ${e.tx} ${e.tool}: ${e.patch.slice(0, 100)}`);
  }
  const md = lines.join('\n');

  await ensureDir(path.join(store.layout.kineDir, 'reports'));
  const file = path.join(store.layout.kineDir, 'reports', `diff_${a.version}_${b.version}.md`);
  await atomicWriteFile(file, md);

  const regressions = [...d.metrics, ...d.audio].filter((m) => m.verdict === 'regressed');
  const facts = [
    `${a.version} → ${b.version}：指标 ${d.metrics.length} 项，其中 ${d.metrics.filter((m) => m.verdict === 'changed').length} 项变化${regressions.length ? `，${regressions.length} 项回归` : ''}`,
    ...regressions.map((m) => `⚠ 回归：${m.key} ${fmtVal(m.a)} → ${fmtVal(m.b)}`),
    `关键帧：${d.keyframes.filter((k) => !k.same).length}/${d.keyframes.length} 不一致`,
    `报告：${path.relative(store.root, file)}`,
  ];
  return ok('diff', { a: a.version, b: b.version, diff: d, report: file }, {
    facts,
    verdict: regressions.some((m) => m.verdict === 'regressed') ? 'FAIL' : 'PASS',
  });
}

function fmtVal(v: number | string | null | undefined): string {
  if (v === null || v === undefined) return '-';
  if (typeof v === 'number') return String(round3(v));
  return v;
}

// ── versions ─────────────────────────────────────────────────────────
export async function toolVersions(ctx: AgentContext): Promise<ToolResult> {
  const store = ctx.store;
  const list = listVersions(store.layout.outDir);
  const latest = readLatest(store.layout.outDir);
  const facts = list.length ? list.map((v) => `${v.version === latest?.version ? '★ ' : ''}${v.version}${v.files.length ? ` (${v.files.join(', ')})` : ''}`) : ['（还没有出片版本）'];
  return ok('versions', { versions: list, latest }, { facts });
}

// kine.edit —— 事务化修改：dry-run → impact → 应用 → changelog（含用户原话）→ 可选预览
import { resolve as resolvePath } from 'node:path';
import { readFileSync } from 'node:fs';
import {
  compile,
  parsePatchExpr,
  parsePatchFile,
  validateProject,
  type LoadedProject,
  type PatchOp,
} from '@kine/dsl';
import {
  commitEdit,
  stageEdit,
  type ChangelogEntry,
  type CommitOptions,
} from '@kine/store';
import { ensureDir, renderDefaults, renderPreview } from '@kine/render';
import type { AgentContext } from '../context';
import { ambiguous, fail, ok, type NextAction, type ToolResult } from '../types';
import { compactValue, ensureMix, guardWrite, impactOf } from './util';

export interface EditOptions {
  expr?: string;
  file?: string;
  quote?: string;
  tx?: boolean;
  preview?: boolean;
  /** 歧义消解：显式指定元素 id（用户从 find 的候选中选择后回传） */
  id?: string;
}

interface FuzzyCand {
  sel: string;
  domain: string;
  match: string;
}

/** 对路径中的 [sel] 做模糊预检：近义多候选 → AMBIGUOUS（禁止静默选） */
function fuzzyCheck(raw: Record<string, unknown>, ops: PatchOp[]): FuzzyCand[] {
  const out: FuzzyCand[] = [];
  const scenes = (raw.scenes as Array<Record<string, unknown>>) ?? [];
  for (const op of ops) {
    const toks = op.path.match(/\[([^\]]+)\]|[^.\[\]]+/g) ?? [];
    for (let i = 0; i < toks.length; i++) {
      const m = /^\[([^\]]+)\]$/.exec(toks[i]);
      if (!m) continue;
      const sel = m[1];
      if (/^\d+$/.test(sel)) continue;
      const container = toks[i - 1];
      let pool: Array<Record<string, unknown>> = [];
      if (container === 'scenes') pool = scenes;
      else if (container === 'layers') pool = scenes.flatMap((s) => (s.layers as Array<Record<string, unknown>>) ?? []);
      else if (container === 'shots') pool = scenes.flatMap((s) => (s.shots as Array<Record<string, unknown>>) ?? []);
      else if (container === 'asserts') pool = (raw.asserts as Array<Record<string, unknown>>) ?? [];
      if (pool.length === 0) continue;
      const exact = pool.some((it) => it?.id === sel);
      if (exact) continue;
      const fuzzy = pool.filter((it) => {
        const id = String(it?.id ?? '');
        const name = String(it?.name ?? '');
        const alias = String(it?.alias ?? '');
        const q = sel.toLowerCase();
        return id.toLowerCase().includes(q) || name.includes(sel) || alias.includes(sel);
      });
      if (fuzzy.length > 1) {
        for (const f of fuzzy) out.push({ sel, domain: container, match: String(f.id) });
      }
    }
  }
  return out;
}

export async function toolEdit(ctx: AgentContext, opts: EditOptions): Promise<ToolResult> {
  const quote = opts.quote?.trim() ?? '';
  if (!quote) {
    return fail('edit', 'E-TX-002', '缺少 --quote（用户原话必填，事务记录需要）', {
      hints: ['用法：kine edit set scenes[x].layers[y].props.p=0.32 --tx --quote "把闪现周期调到 0.32"'],
    });
  }
  if (!opts.expr && !opts.file) {
    return fail('edit', 'E-TX-001', '缺少 patch 表达式或 --file', {
      hints: ['示例：kine edit set scenes[title].layers[glitch].props.flash_period=0.32 --tx --quote "..."'],
    });
  }
  if (opts.expr && opts.file) {
    return fail('edit', 'E-TX-001', '不能同时给表达式与 --file');
  }

  const store = await ctx.store;
  const loaded = ctx.compile().loaded;

  let ops: PatchOp[];
  try {
    ops = opts.file
      ? parsePatchFile(readFileUtf8(resolvePath(store.root, opts.file)))
      : [parsePatchExpr(opts.expr!)];
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return fail('edit', err.code ?? 'E-TX-001', err.message ?? String(e));
  }

  // 模糊匹配预检（AMBIGUOUS 协议）
  const fuzzy = fuzzyCheck(loaded.raw as Record<string, unknown>, ops);
  if (fuzzy.length > 1) {
    return ambiguous('edit', `patch 目标 "${fuzzy[0].sel}" 不精确（未找到同名 id），匹配到多个候选，请确认要改哪一个`, fuzzy.map((f) => ({
      label: `${f.domain}: ${f.match}`,
      id: f.match,
      facts: [`若选此项，请用 --id ${f.match} 或直接把路径写成 [${f.match}]`],
    })));
  }
  if (opts.id) {
    // 用户显式消歧：将 bare [sel] 替换为 [id]（仅当 sel 非精确 id）
    const scenesRaw = ((loaded.raw as Record<string, unknown>).scenes as Array<Record<string, unknown>>) ?? [];
    for (const op of ops) {
      const toks = op.path.match(/\[([^\]]+)\]|[^.\[\]]+/g) ?? [];
      for (let i = 0; i < toks.length; i++) {
        const m = /^\[([^\]]+)\]$/.exec(toks[i]);
        if (!m || /^\d+$/.test(m[1]) || m[1] === opts.id) continue;
        const pool =
          toks[i - 1] === 'scenes'
            ? scenesRaw
            : scenesRaw.flatMap((s) => (s.layers as Array<Record<string, unknown>>) ?? []);
        if (!pool.some((it) => it?.id === m[1])) op.path = op.path.replace(`[${m[1]}]`, `[${opts.id}]`);
      }
    }
  }

  const beforeIR = ctx.compile().ir;
  let stage;
  try {
    stage = await stageEdit(store, ops);
  } catch (e) {
    const err = e as { code?: string; message?: string; facts?: string[]; hints?: string[] };
    if (err.code === 'E-TX-004' && (err.facts ?? []).some((f) => f.includes('候选 id'))) {
      // 目标不存在：若候选 ≥2 且用户未用 --id，转 AMBIGUOUS
      const candLine = (err.facts ?? []).find((f) => f.includes('候选 id')) ?? '';
      const cands = candLine.replace(/^候选 id：/, '').split(',').map((s) => s.trim()).filter((s) => s && s !== '(无)');
      if (cands.length > 1 && !opts.id) {
        return ambiguous('edit', `patch 目标不存在（未找到 id），现有候选如下，请确认`, cands.map((c) => ({
          label: c,
          id: c,
          facts: [`用 --id ${c} 重试，或把路径改写成 [${c}]`],
        })));
      }
    }
    return fail('edit', err.code ?? 'E-TX-004', err.message ?? String(e), { facts: err.facts, hints: err.hints });
  }

  const important = stage.issues.filter((i) => i.severity === 'error');
  if (important.length > 0) {
    return fail('edit', 'E-TX-003', `patch 应用后 schema 校验失败（${important.length} 个错误），已拒绝提交`, {
      facts: important.map((i) => `[${i.code}] ${i.message}`),
      hints: ['修正 patch 后重试'],
    });
  }

  const impact = impactOf(beforeIR, stage.targets);
  const specHashAfter = compileRawAfter(store.root, loaded, stage.rawAfter).ir.specHash;

  const baseData = {
    committed: false as boolean,
    txId: stage.txId,
    diffs: stage.diffs.map((d) => ({ op: d.op, path: d.path, from: compactValue(d.from), to: compactValue(d.to) })),
    summary: stage.summary.map((s) => (s.length > 140 ? `${s.slice(0, 137)}…` : s)),
    target: stage.target,
    impact,
    specHashBefore: beforeIR.specHash,
    specHashAfter,
  };

  if (!opts.tx) {
    return ok('edit', baseData, {
      verdict: 'PASS',
      facts: [
        `dry-run：${stage.summary.length} 项变更——${stage.summary.slice(0, 3).map((s) => (s.length > 100 ? `${s.slice(0, 97)}…` : s)).join('；')}${stage.summary.length > 3 ? `；…另 ${stage.summary.length - 3} 项` : ''}`,
        `失效：${impact.invalidates.length} 个节点（${impact.approx.rerender}）`,
        `保留：${impact.keeps.join(' / ') || '无'}`,
        `预计重渲 ${impact.approx.frames} 帧`,
      ],
      nextActions: [
        { tool: 'kine.edit', args: { expr: opts.expr, file: opts.file, tx: true, quote, preview: true }, reason: '确认无误后用 --tx 提交（事务 + changelog）' },
      ],
    });
  }

  const guard = guardWrite(ctx, 'edit');
  if (guard) return guard;

  const commitOpts: CommitOptions = {
    quote,
    tool: 'edit',
    impact: { invalidates: impact.invalidates, kept: impact.keeps },
    specHashBefore: beforeIR.specHash,
    specHashAfter,
    checks: { audit: 'syntax-pass' },
  };

  let previewFile: string | undefined;
  if (opts.preview) {
    try {
      const afterIR = compileRawAfter(store.root, loaded, stage.rawAfter).ir;
      const sceneId = stage.target.scene ?? afterIR.scenes[0].id;
      const sc = afterIR.scenes.find((s) => s.id === sceneId) ?? afterIR.scenes[0];
      const dur = Math.min(4, afterIR.output.duration);
      const t0 = Math.max(sc.t0, Math.min(sc.t0 + sc.dur * 0.38, afterIR.output.duration - dur));
      const prevDir = resolvePath(store.layout.kineDir, 'out', 'previews');
      await ensureDir(prevDir);
      const defaults = renderDefaults(afterIR, store.root);
      const mixFile = await ensureMix(ctx, afterIR);
      const r = await renderPreview(afterIR, {
        ...defaults,
        outDir: prevDir,
        t0: +t0.toFixed(3),
        dur,
        audioFile: mixFile ?? undefined,
      });
      previewFile = r.file;
      commitOpts.preview = r.file;
    } catch (e) {
      ctx.progress('edit', `预览渲染失败（不影响提交）：${String((e as Error).message ?? e)}`);
    }
  }

  const entry: ChangelogEntry = await commitEdit(store, stage, commitOpts);
  ctx.clearCompileCache?.();

  const nextActions: NextAction[] = [
    { tool: 'kine.audit', args: {}, reason: '提交后跑一次全轴检查' },
    { tool: 'kine.rollback', args: { txId: stage.txId }, reason: '如需撤销本次改动' },
  ];
  if (previewFile) nextActions.unshift({ tool: 'kine.preview', args: { at: '$受影响段', dur: 4 }, reason: `已生成预览：${previewFile}` });

  return ok(
    'edit',
    { ...baseData, committed: true, entry, preview: previewFile },
    {
      verdict: 'PASS',
      facts: [
        `已提交事务 ${stage.txId}：${stage.summary.slice(0, 3).map((s) => (s.length > 100 ? `${s.slice(0, 97)}…` : s)).join('；')}${stage.summary.length > 3 ? `；…另 ${stage.summary.length - 3} 项` : ''}`,
        `changelog 已记录用户原话："${quote}"`,
        previewFile ? `预览已生成：${previewFile}（请播放确认效果）` : '未生成预览（--preview 未开启）',
        `失效：${impact.invalidates.length} 个节点｜保留：${impact.keeps.length} 项`,
        `specHash：${beforeIR.specHash.slice(0, 8)} → ${specHashAfter.slice(0, 8)}`,
      ],
      hints: previewFile ? ['预览为成品形态短片（成片分辨率 + 音轨），确认后再 render'] : ['提交后建议 kine preview --at <t> --dur 4 看效果'],
      nextActions,
    }
  );
}

// ---- 局部工具：读取 patch 文件（UTF-8）
function readFileUtf8(p: string): string {
  return readFileSync(p, 'utf8');
}

/** rawAfter（未做 zod 默认值展开）→ 校验后编译；校验失败抛 E-TX-003 */
function compileRawAfter(projectDir: string, loaded: LoadedProject, rawAfter: unknown) {
  const { spec } = validateProject(rawAfter as Record<string, unknown>, loaded.file, loaded.lineOf);
  if (!spec) throw Object.assign(new Error('patch 应用后无法通过 schema 校验'), { code: 'E-TX-003' });
  return compile(spec, { projectDir });
}

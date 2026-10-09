// @kine/agent — style：风格档案（M10）——theme.profile / theme.palette 的事务化应用
//
// apply：set theme.profile=extended + set theme.palette=<ref>（走 tx --quote 事务；干跑默认）
// show ：展示当前 profile / palette 与解析后的色板值
import * as path from 'node:path';
import { parseTargetPath, resolvePalette } from '@kine/dsl';
import { commitEdit, stageEdit } from '@kine/store';
import { renderDefaults, renderPreview } from '@kine/render';
import type { AgentContext } from '../context';
import { fail, ok, type ToolResult } from '../types';
import { ensureMix, guardWrite, impactOf } from './util';

export interface StyleArgs {
  action: 'apply' | 'show';
  ref?: string;
  tx?: boolean;
  quote?: string;
  preview?: boolean;
}

export async function toolStyle(ctx: AgentContext, args: StyleArgs): Promise<ToolResult<unknown>> {
  if (args.action === 'show') {
    const { ir } = await ctx.compile();
    const profile = ir.theme.profile ?? 'core';
    const ref = ir.theme.palette;
    const facts = [`profile: ${profile}`, `palette: ${ref ?? '（未设：core 默认色板）'}`];
    const pr = resolvePalette(ref, undefined);
    if (pr.ok) {
      facts.push(
        `当前色板（${pr.source}${pr.entryId ? ` · ${pr.entryId}` : ''}）：accent ${pr.palette.accent}｜text ${pr.palette.text}｜bg ${pr.palette.bg.join(' / ')}`,
      );
    } else {
      facts.push(`色板解析失败：${pr.error.message}`);
    }
    return ok('style', { profile, palette: ref ?? null, resolved: pr.ok ? pr.palette : null }, {
      facts,
      nextActions: [{ tool: 'library', args: { action: 'list', kind: 'palette' } }],
    });
  }

  // ---- apply
  const guard = guardWrite(ctx, 'style');
  if (guard) return guard;
  if (!args.ref) return fail('style', 'E-LIB-021', 'apply 需要 --ref（library://<id> / @tag / core）');
  if (args.tx && !args.quote) return fail('style', 'E-TX-002', '--tx 必须带 --quote（用户原话，逐字记录）');

  const store = ctx.store;
  const ops = [
    { op: 'set' as const, path: 'theme.profile', value: 'extended' },
    { op: 'set' as const, path: 'theme.palette', value: args.ref },
  ];
  let staged;
  try {
    staged = await stageEdit(store, ops);
  } catch (e) {
    const err = e as { code?: string; message?: string; facts?: string[]; hints?: string[] };
    return fail('style', err.code ?? 'E-TX-004', err.message ?? String(e), {
      facts: err.facts ?? [],
      hints: err.hints ?? [],
    });
  }
  const before = await ctx.compile({ fresh: true });
  const impact = impactOf(before.ir, [parseTargetPath('theme.profile')]);
  const pr = resolvePalette(args.ref, undefined);

  const data: Record<string, unknown> = {
    staged: { txId: staged.txId, diffs: staged.diffs, summary: staged.summary, target: staged.target },
    impact,
    palettePreview: pr.ok ? { source: pr.source, entryId: pr.entryId ?? null, accent: pr.palette.accent, text: pr.palette.text, bg: pr.palette.bg } : null,
  };

  if (!args.tx) {
    return ok('style', data, {
      verdict: 'NEED_INPUT',
      facts: [
        `干跑：${staged.summary.join('；')}`,
        ...(pr.ok
          ? [`色板预览（${pr.source}${pr.entryId ? ` · ${pr.entryId}` : ''}）：accent ${pr.palette.accent}｜text ${pr.palette.text}`]
          : [`色板解析警告：${pr.error.message}`]),
        `影响：失效 ${impact.invalidates.length} 节点 / 保留 ${impact.keeps.length} 项`,
      ],
      hints: ['确认后加 --tx --quote "…" 提交（提交后需 audit → render）'],
      nextActions: [{ tool: 'audit', args: {} }],
    });
  }

  const entry = await commitEdit(store, staged, {
    quote: args.quote!,
    tool: 'style',
    impact: { invalidates: impact.invalidates, kept: impact.keeps },
    checks: { audit: 'syntax-pass' },
  });

  let previewFile: string | null = null;
  if (args.preview) {
    try {
      const defaults = renderDefaults(before.ir, store.root);
      const dur = before.ir.output.duration;
      const t0 = Math.max(0, Math.min(dur - 4, dur * 0.5));
      const mix = await ensureMix(ctx, before.ir);
      const r = await renderPreview(before.ir, {
        ...defaults,
        t0,
        dur: 4,
        audioFile: mix ?? undefined,
        outDir: path.join(store.layout.kineDir, 'out', 'previews'),
      });
      previewFile = r.file;
    } catch {
      // 预览失败不影响提交
    }
  }
  ctx.clearCompileCache();

  return ok('style', { committed: true, entry, preview: previewFile, palettePreview: data['palettePreview'] }, {
    facts: [
      `风格已应用：profile extended + palette ${args.ref}`,
      `事务 ${entry.tx}（含用户原话）`,
      ...(previewFile ? [`预览：${previewFile}`] : []),
    ],
    nextActions: [
      { tool: 'audit', args: {} },
      { tool: 'render', args: {} },
    ],
  });
}

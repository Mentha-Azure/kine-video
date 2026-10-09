// @kine/agent — contact：接触表（v4）——一次抓帧拼图，一屏看全片（反馈：此前需手工用 ffmpeg 拼接触表才能发现重叠）
import path from 'node:path';
import { pointAt } from '@kine/dsl';
import { pyMontage } from '@kine/metrics';
import { capturePngs, ensureDir, renderDefaults } from '@kine/render';
import { tsStamp } from '@kine/store';
import type { AgentContext } from '../context';
import { fail, ok, type ToolResult } from '../types';

export interface ContactArgs {
  /** 仅拼该幕（与 t0/t1 三选一优先） */
  scene?: string;
  t0?: number;
  t1?: number;
  /** 帧数（默认 12，2–36） */
  count?: number;
  /** 列数（默认 4） */
  cols?: number;
  /** 单格像素（默认 384） */
  cell?: number;
}

export async function toolContact(ctx: AgentContext, args: ContactArgs = {}): Promise<ToolResult> {
  const { ir } = ctx.compile();
  const dur = ir.time.map.duration;
  let t0 = args.t0 ?? 0;
  let t1 = args.t1 ?? dur;
  if (args.scene) {
    const sc = ir.scenes.find((s) => s.id === args.scene);
    if (!sc) {
      return fail('contact', 'E-LAYOUT-001', `未找到幕 "${args.scene}"`, {
        facts: [`幕：${ir.scenes.map((s) => s.id).join(' / ')}`],
      });
    }
    t0 = sc.t0;
    t1 = sc.t1;
  }
  if (!(Number.isFinite(t0) && Number.isFinite(t1)) || t1 <= t0 || t0 < 0 || t1 > dur + 1e-6) {
    return fail('contact', 'E-TIME-003', `区间非法：${t0}..${t1}（成片秒，0..${dur}）`, {
      hints: ['如：kine contact --t0 0 --t1 24 --count 12；或 kine contact --scene code'],
    });
  }
  const count = Math.min(36, Math.max(2, Math.round(args.count ?? 12)));
  const cols = Math.min(count, Math.max(1, Math.round(args.cols ?? 4)));
  const cell = Math.min(1024, Math.max(96, Math.round(args.cell ?? 384)));
  const times = Array.from({ length: count }, (_, i) => t0 + ((i + 0.5) * (t1 - t0)) / count);
  const frames = times.map((t) => pointAt(ir.time.map, Math.min(t, dur - 1e-6)).frame);

  const stamp = tsStamp();
  const defaults = renderDefaults(ir, ctx.store.root);
  const shotsDir = path.join(ctx.store.layout.kineDir, 'reports', `contact_${stamp}`);
  await ensureDir(shotsDir);
  let shots: Array<{ frame: number; file: string }>;
  try {
    shots = await capturePngs(ir, frames, { ...defaults, outDir: shotsDir, prefix: 'c' });
  } catch (e) {
    return fail('contact', 'E-RENDER-001', `接触表抓帧失败：${e instanceof Error ? e.message : String(e)}`, {
      hints: ['缩小 --count 重试；确认浏览器可用（KINE_BROWSER）'],
    });
  }
  const out = path.join(ctx.store.layout.kineDir, 'reports', `contact_${stamp}.png`);
  try {
    await pyMontage(
      shots.map((s) => s.file),
      out,
      { cols, cell, labels: times.map((t) => `${t.toFixed(2)}s`) },
    );
  } catch (e) {
    return fail('contact', 'E-PY-001', `接触表拼图失败：${e instanceof Error ? e.message : String(e)}`, {
      facts: [`单帧已抓取到：${shotsDir}`],
    });
  }
  return ok(
    'contact',
    { file: out, count, cols, t0: +t0.toFixed(3), t1: +t1.toFixed(3), frames },
    {
      verdict: 'PASS',
      facts: [
        `接触表：${out}`,
        `区间 ${t0.toFixed(2)}s–${t1.toFixed(2)}s｜${count} 帧 ×${cols} 列｜单格 ${cell}px｜每格左下标注时间`,
        '用途：一屏复核构图/重叠/贴边/节奏；定量检测用 kine layout（bbox 重叠与出画）',
      ],
      hints: ['先用图片查看器打开确认构图；发现重叠后：kine layout --scene <幕> 定位'],
      nextActions: [{ tool: 'kine.layout', args: {}, reason: '对重叠位做定量 bbox 检查' }],
    },
  );
}

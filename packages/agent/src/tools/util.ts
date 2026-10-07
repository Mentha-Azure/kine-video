// @kine/agent — 工具共享辅助（帧提供者/影响分析/常用组合）
import fs from 'node:fs';
import path from 'node:path';
import type { KineIR, ImpactReport, ParsedTarget } from '@kine/dsl';
import { computeImpact } from '@kine/dsl';
import { capturePngs, renderDefaults } from '@kine/render';
import type { FrameProvider } from '@kine/metrics';
import type { AgentContext } from '../context';

/** 每幕帧数（影响分析 approx.frames 用） */
export function framesPerScene(ir: KineIR): Record<string, number> {
  const out: Record<string, number> = {};
  for (const sc of ir.time.map.scenes) out[sc.id] = sc.frame1 - sc.frame0;
  return out;
}

/** 由改动目标列表计算影响报告（依赖图闭包） */
export function impactOf(ir: KineIR, targets: ParsedTarget[]): ImpactReport {
  const sceneIds = [...new Set(targets.map((t) => t.sceneId).filter((x): x is string => !!x))];
  return computeImpact({
    targets,
    sceneIds,
    framesPerScene: framesPerScene(ir),
    totalFrames: ir.time.map.frames,
    nScenes: ir.time.map.scenes.length,
  });
}

/**
 * 基于 capturePngs 的帧提供者：带磁盘缓存（.kine/work/<hash8>/shots-<tag>/_index.json）。
 * 同一帧跨工具调用复用，避免重复抓帧（一次会话批量抓缺失帧）。
 */
export function makeFrameProvider(ctx: AgentContext, ir: KineIR, tag = 'probe'): FrameProvider {
  const d = renderDefaults(ir, ctx.store.root);
  const outDir = path.join(d.workDir, `shots-${tag}`);
  const indexFile = path.join(outDir, '_index.json');
  let index: Record<string, string> = {};
  if (fs.existsSync(indexFile)) {
    try {
      index = JSON.parse(fs.readFileSync(indexFile, 'utf8')) as Record<string, string>;
    } catch {
      index = {};
    }
  }
  const maxFrame = ir.time.map.frames - 1;
  return {
    async ensure(frames: number[]): Promise<Map<number, string>> {
      const want = [...new Set(frames.map((f) => Math.max(0, Math.min(maxFrame, Math.floor(f)))))];
      const missing = want.filter((f) => {
        const p = index[String(f)];
        return !p || !fs.existsSync(p);
      });
      if (missing.length > 0) {
        const shots = await capturePngs(ir, missing, { ...d, outDir, prefix: 'f' });
        for (const s of shots) index[String(s.frame)] = s.file;
        fs.mkdirSync(outDir, { recursive: true });
        fs.writeFileSync(indexFile, JSON.stringify(index, null, 0));
      }
      const out = new Map<number, string>();
      for (const f of want) {
        const p = index[String(f)];
        if (p) out.set(f, p);
      }
      return out;
    },
  };
}

/** 供渲染/预览的音频（默认带音轨）：编译后即构建 mix（缓存友好），失败返回 null */
export async function ensureMix(context: AgentContext, ir: KineIR): Promise<string | null> {
  try {
    const { buildAudio } = await import('@kine/audio');
    const art = await buildAudio(ir, {
      cacheDir: context.store.layout.cacheDir,
      locksDir: context.store.layout.locksDir,
    });
    return art.mixFile;
  } catch {
    return null;
  }
}

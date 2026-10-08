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

export interface RangeSpecResult {
  ok: boolean;
  range?: [number, number];
  message?: string;
  hints?: string[];
}

/**
 * 解析时间窗参数（成片秒）：接受 "a:b" 字符串（如 "0:5" / "12.5:14"）或 [number, number]。
 * 严格数值校验，禁止字符串按字符展开造成的静默错数据（v3 P0-1 / P0-3 同类问题）。
 */
export function parseRangeSpec(input: string | [number, number], maxSec?: number): RangeSpecResult {
  if (Array.isArray(input)) {
    const [a, b] = input;
    if (!Number.isFinite(a) || !Number.isFinite(b) || !(b > a)) {
      return {
        ok: false,
        message: `--range 取值非法：[${a}, ${b}]（需 b > a，成片秒）`,
        hints: ['示例：--range 0:5 或 --range 12.5:14'],
      };
    }
    if (maxSec !== undefined && b > maxSec + 1e-9) {
      return {
        ok: false,
        message: `--range 超出成片时长：${a}:${b}（成片时长 ${maxSec}s）`,
        hints: [`可用范围 0:${maxSec}`],
      };
    }
    return { ok: true, range: [a, b] };
  }
  const raw = String(input).trim();
  const m = /^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/.exec(raw);
  if (!m) {
    return {
      ok: false,
      message: `--range 格式非法："${raw}"（应为 秒:秒，如 0:5 / 12.5:14）`,
      hints: ['measure/find 的 --range 一律成片秒；帧区间请用于 render --range'],
    };
  }
  const a = Number(m[1]);
  const b = Number(m[2]);
  if (!(b > a)) {
    return {
      ok: false,
      message: `--range 数值非法：${a} → ${b}（需 b > a）`,
      hints: ['示例：--range 0:5'],
    };
  }
  if (maxSec !== undefined && b > maxSec + 1e-9) {
    return {
      ok: false,
      message: `--range 超出成片时长：${a}:${b}（成片时长 ${maxSec}s）`,
      hints: [`可用范围 0:${maxSec}`],
    };
  }
  return { ok: true, range: [a, b] };
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

export interface EnsureMixOptions {
  /** true=失败抛 E-AUDIO-MIX-001（交付路径 render 用）；默认 false=降级返回 null 但必留痕（v3 P0-2） */
  strict?: boolean;
}

/** 供渲染/预览的音频（默认带音轨）：编译后即构建 mix（缓存友好）；失败必留痕，strict 时抛错 */
export async function ensureMix(context: AgentContext, ir: KineIR, opts: EnsureMixOptions = {}): Promise<string | null> {
  try {
    const { buildAudio } = await import('@kine/audio');
    const art = await buildAudio(ir, {
      cacheDir: context.store.layout.cacheDir,
      locksDir: context.store.layout.locksDir,
    });
    return art.mixFile;
  } catch (e) {
    // 不再静默：失败必须留痕（progress 通道；CLI 非静默时落到 stderr）
    const msg = e instanceof Error ? e.message : String(e);
    context.progress('audio', `混音失败${opts.strict ? '（严格模式，中止）' : '（已降级为无声处理）'}：${msg}`);
    const err = Object.assign(new Error(`音频构建失败：${msg}`), {
      code: 'E-AUDIO-MIX-001',
      hints: [
        '检查 audio 配置：如 sfx 事件参数（piano_motif.notes 必须是频率数组，如 [220.0, 261.63, 329.63]）',
        '音乐文件缺失/不可解码也走此路径；可用 kine rules E-AUDIO-MIX-001 查看说明',
      ],
    });
    if (opts.strict) throw err;
    return null;
  }
}

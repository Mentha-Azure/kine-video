// @kine/render — 分片规划：边界只准落 pace 断点与首尾、终幕独立（规格文档04 §4.3）
import type { KineIR } from '@kine/dsl';

export interface ChunkRange {
  index: number;
  /** 成片帧号 [f0, f1)，0-based，左闭右开 */
  f0: number;
  f1: number;
}

/** 收集合法分片边界帧：0、总帧数、各 pace 段末端、终幕起点 */
export function breakFrames(ir: KineIR): number[] {
  const frames = ir.time.map.frames;
  const set = new Set<number>([0, frames]);
  const segs = ir.time.map.segments;
  for (let i = 0; i < segs.length - 1; i++) {
    const f = segs[i]!.frame1;
    if (f > 0 && f < frames) set.add(f);
  }
  const scenes = ir.time.map.scenes;
  const last = scenes[scenes.length - 1];
  if (last && last.frame0 > 0 && last.frame0 < frames) set.add(last.frame0);
  return [...set].sort((a, b) => a - b);
}

/**
 * 分片规划：不跨断点；每段内尽量均分（floor(段长/目标长)）；
 * 源工程参照：8274 帧 4 worker → [(0,2502),(2502,2502),(5004,2502),(7506,768)]
 */
export function planChunks(ir: KineIR, opts: { workers?: number } = {}): ChunkRange[] {
  const frames = ir.time.map.frames;
  const workers = Math.max(1, opts.workers ?? 4);
  const breaks = breakFrames(ir);
  const target = Math.max(1, Math.floor(frames / workers));
  const out: ChunkRange[] = [];
  for (let i = 0; i < breaks.length - 1; i++) {
    const a = breaks[i]!;
    const b = breaks[i + 1]!;
    const len = b - a;
    if (len <= 0) continue;
    const n = Math.max(1, Math.floor(len / target));
    const size = Math.floor(len / n);
    let f = a;
    for (let j = 0; j < n; j++) {
      const end = j === n - 1 ? b : f + size;
      out.push({ index: out.length, f0: f, f1: end });
      f = end;
    }
  }
  return out;
}

export function chunkFileName(index: number, f0: number, f1: number, key8: string): string {
  return `chunk_${String(index).padStart(2, '0')}_${String(f0).padStart(6, '0')}-${String(f1).padStart(6, '0')}_${key8}.ts`;
}

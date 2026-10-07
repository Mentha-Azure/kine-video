// tests/chunks.test.ts — 分片切分（断点纪律：单 chunk 不跨 pace 断点，文档02/04）
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { loadAndCompile } from '@kine/dsl';
import { breakFrames, planChunks } from '@kine/render';

function assertBreaksRespected(chunks: { f0: number; f1: number }[], breaks: number[]): void {
  for (const b of breaks) {
    if (b === 0) continue;
    const boundary = chunks.some((c) => c.f1 === b);
    expect(boundary, `断点 ${b} 应落在分片边界`).toBe(true);
  }
  for (const c of chunks) {
    for (const b of breaks) {
      if (b > c.f0 && b < c.f1) throw new Error(`分片 ${c.f0}-${c.f1} 跨越断点 ${b}`);
    }
  }
}

describe('分片规划', () => {
  const ir = loadAndCompile(path.resolve('examples/mv-mini/timeline.yaml')).ir;

  it('mv-mini 断点 = [0, 1080, 1200, 1440]（终幕起点 + pace 断点 + 首尾）', () => {
    expect(breakFrames(ir)).toEqual([0, 1080, 1200, 1440]);
  });

  it('4 worker 均分且不跨断点', () => {
    const chunks = planChunks(ir, { workers: 4 });
    expect(chunks.map((c) => [c.f0, c.f1])).toEqual([
      [0, 360],
      [360, 720],
      [720, 1080],
      [1080, 1200],
      [1200, 1440],
    ]);
  });

  it('1 worker 与 8 worker 同样守约（覆盖完整、边界落断点）', () => {
    for (const w of [1, 8]) {
      const chunks = planChunks(ir, { workers: w });
      assertBreaksRespected(chunks, breakFrames(ir));
      expect(chunks[0]!.f0).toBe(0);
      expect(chunks[chunks.length - 1]!.f1).toBe(1440);
    }
  });

  it('double-pace 断点 240 被尊重（用例⑧）', () => {
    const ir2 = loadAndCompile(path.resolve('fixtures/double-pace/timeline.yaml')).ir;
    const breaks = breakFrames(ir2);
    expect(breaks).toContain(240);
    expect(breaks).toContain(420);
    assertBreaksRespected(planChunks(ir2, { workers: 4 }), breaks);
  });
});

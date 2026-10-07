// tests/time.test.ts — 时间映射（双速/accel:cut）单测（文档03 §3.4/§3.5）
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { loadAndCompile, pointAt, pointAtFrame, tToT, TtoT, sceneLt } from '@kine/dsl';

describe('时间映射（双速工程 fixture）', () => {
  const ir = loadAndCompile(path.resolve('fixtures/double-pace/timeline.yaml')).ir;

  it('帧数与 pace 断点', () => {
    expect(ir.time.map.frames).toBe(420);
    const b = ir.time.map.breaks.find((x) => x.frame === 240);
    expect(b).toBeTruthy();
    expect(b!.t).toBeCloseTo(4.0, 6);
    expect(b!.T).toBeCloseTo(4.0, 6);
  });

  it('t→T 与 T→t 往返（ratio 1.5 段）', () => {
    expect(tToT(ir.time.map, 7.0)).toBeCloseTo(8.5, 6);
    expect(TtoT(ir.time.map, 8.5)).toBeCloseTo(7.0, 6);
    expect(tToT(ir.time.map, 5.5)).toBeCloseTo(6.25, 6);
    expect(TtoT(ir.time.map, tToT(ir.time.map, 5.5))).toBeCloseTo(5.5, 6);
  });

  it('pointAt / pointAtFrame 一致', () => {
    const p = pointAt(ir.time.map, 5.5);
    expect(p.T).toBeCloseTo(6.25, 6);
    expect(p.frame).toBe(330);
    const q = pointAtFrame(ir.time.map, 240);
    expect(q.t).toBeCloseTo(4.0, 6);
    expect(q.scene).toBe('s2');
  });

  it('幕帧区间与 T/t 边界', () => {
    const s1 = ir.time.map.scenes.find((s) => s.id === 's1')!;
    const s2 = ir.time.map.scenes.find((s) => s.id === 's2')!;
    expect(s1.frame0).toBe(0);
    expect(s1.frame1).toBe(240);
    expect(s2.frame0).toBe(240);
    expect(s2.frame1).toBe(420);
    expect(s2.T1).toBeCloseTo(8.5, 6);
    expect(s2.t1).toBeCloseTo(7.0, 6);
  });
});

describe('accel: cut 动画时钟（用例⑥）', () => {
  const ir = loadAndCompile(path.resolve('fixtures/accel-cut/timeline.yaml')).ir;

  it('accelFactor=min(DUR/cut,1.62) 且 lt 压缩后夹紧保持', () => {
    const sc = ir.scenes[0]!;
    expect(sc.accelFactor).toBeCloseTo(1.62, 6);
    const tm = ir.time.map.scenes[0]!;
    expect(sceneLt(tm, sc.T0 + 1.0)).toBeCloseTo(1.62, 3);
    // 夹紧：T 走满幕时 lt 停在幕尾（保持末姿）
    expect(sceneLt(tm, sc.T0 + sc.dur)).toBeCloseTo(sc.dur, 3);
  });
});

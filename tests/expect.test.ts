// tests/expect.test.ts — expect 语法解析与判定（文档03/06）
import { describe, expect, it } from 'vitest';
import { parseExpect, checkExpect, thresholdInMetricUnit } from '@kine/metrics';

describe('expect 语法', () => {
  it('解析 >= 4 %', () => {
    const p = parseExpect('>= 4 %');
    expect(p.op).toBe('>=');
    expect(p.threshold).toBe(4);
    expect(p.unit).toBe('%');
    expect(thresholdInMetricUnit(p)).toBeCloseTo(0.04, 6);
  });

  it('解析 in 6..9', () => {
    const p = parseExpect('in 6..9');
    expect(p.op).toBe('in');
    expect(p.range?.[0]).toBe(6);
    expect(p.range?.[1]).toBe(9);
  });

  it('解析 <= 2 px', () => {
    const p = parseExpect('<= 2 px');
    expect(p.op).toBe('<=');
    expect(p.threshold).toBe(2);
    expect(p.unit).toBe('px');
  });

  it('checkExpect 阈值判定', () => {
    const p = parseExpect('>= 4 %');
    expect(checkExpect(p, 0.05)).toBe(true);
    expect(checkExpect(p, 0.03)).toBe(false);
  });

  it('checkExpect in 区间（用实测 min/max）', () => {
    const p = parseExpect('in 6..9');
    expect(checkExpect(p, 8, { min: 8, max: 8 })).toBe(true);
    expect(checkExpect(p, 5, { min: 5, max: 5 })).toBe(false);
  });
});

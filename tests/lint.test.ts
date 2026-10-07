// tests/lint.test.ts — 9.6 回归 fixtures 的 lint 断言（用例①②③⑥⑦⑧）
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { loadAndCompile, type Issue } from '@kine/dsl';

function codes(dir: string): { codes: string[]; errors: number; warns: number } {
  const file = path.resolve('fixtures', dir, 'timeline.yaml');
  const comp = loadAndCompile(file, { projectDir: path.dirname(file) });
  const all: Issue[] = [...comp.issues, ...comp.lintIssues];
  return {
    codes: all.map((i) => i.code),
    errors: all.filter((i) => i.severity === 'error').length,
    warns: all.filter((i) => i.severity === 'warn').length,
  };
}

describe('9.6 回归 fixtures · lint', () => {
  it('① energy 驱动提亮 → E-AUD-003（防灰白病）', () => {
    const r = codes('env-flash');
    expect(r.codes).toContain('E-AUD-003');
    expect(r.errors).toBeGreaterThan(0);
  });

  it('② z1=1.14 + 贴边 HUD → E-HUD-001（防被切）', () => {
    expect(codes('hud-clip').codes).toContain('E-HUD-001');
  });

  it('③ tw=2.4 → E-CAM-001（防抖动夸张）', () => {
    expect(codes('pump-tw').codes).toContain('E-CAM-001');
  });

  it('⑥ accel:cut → W-ACC-001 且零 error（提示重校阈值）', () => {
    const r = codes('accel-cut');
    expect(r.errors).toBe(0);
    expect(r.codes).toContain('W-ACC-001');
  });

  it('⑦⑧ ambiguous / double-pace 零错误', () => {
    expect(codes('ambiguous').errors).toBe(0);
    expect(codes('double-pace').errors).toBe(0);
  });
});

// v6 守卫：push/whip 转场方向修复 + 浅色色板三处注册规则对齐（forge/seed/dsl）
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { validatePaletteData } from '@kine/dsl';
import { companionOffset } from '@kine/runtime';
import { AgentContext, validateForgeData, toolLibrary } from '@kine/agent';

describe('companionOffset（push/whip 新画布位移因子，v6 bug 修复）', () => {
  it('正向 off>0：1-off（旧行为逐值保持不变）', () => {
    expect(companionOffset(0.5)).toBeCloseTo(0.5, 10);
    expect(companionOffset(0.25)).toBeCloseTo(0.75, 10);
    expect(companionOffset(1)).toBeCloseTo(0, 10);
  });
  it('反向 off<0：-1-off（旧公式 (1-off) 会把新画布推到 2 屏外）', () => {
    expect(companionOffset(-0.5)).toBeCloseTo(-0.5, 10);
    expect(companionOffset(-0.2)).toBeCloseTo(-0.8, 10);
    expect(companionOffset(-1)).toBeCloseTo(0, 10);
  });
  it('不变量：off=0 → +1（新画布恰在屏外一侧）；|off|=1 → 0（新画布完全入场）', () => {
    expect(companionOffset(0)).toBe(1);
    expect(Math.abs(companionOffset(1))).toBeCloseTo(0, 10);
    expect(Math.abs(companionOffset(-1))).toBeCloseTo(0, 10);
  });
});

describe('validatePaletteData（dark/light 分流，单一实现）', () => {
  it('浅色合法色板：放行', () => {
    expect(validatePaletteData({ bg: ['#f4f5f7', '#e8eaef'], text: '#1a1d24', mode: 'light' })).toEqual([]);
  });
  it('浅色过暗 → E-COLOR-002', () => {
    const issues = validatePaletteData({ bg: ['#666666', '#f4f5f7'], text: '#1a1d24', mode: 'light' });
    expect(issues.some((i) => i.code === 'E-COLOR-002')).toBe(true);
  });
  it('浅色对比度不足 → E-COLOR-005', () => {
    const issues = validatePaletteData({ bg: ['#f4f5f7', '#ffffff'], text: '#dddddd', mode: 'light' });
    expect(issues.some((i) => i.code === 'E-COLOR-005')).toBe(true);
  });
  it('深色过亮 → E-COLOR-002（原规则保持）', () => {
    const issues = validatePaletteData({ bg: ['#f4f5f7', '#e8eaef'], text: '#111111' });
    expect(issues.some((i) => i.code === 'E-COLOR-002')).toBe(true);
  });
});

describe('forge register（浅色色板可注册，v6 bug 修复）', () => {
  it('light 色板通过静态校验', () => {
    const r = validateForgeData('palette', {
      name: 'light-test', mode: 'light', bg: ['#f4f5f7', '#e8eaef'], text: '#1a1d24', text_dim: '#5a6070', accent: '#d92b45',
    });
    expect(r.errors).toEqual([]);
  });
  it('light 过暗被拦（报 E-COLOR-002）', () => {
    const r = validateForgeData('palette', {
      name: 'light-bad', mode: 'light', bg: ['#666666', '#777777'], text: '#111111', accent: '#d92b45',
    });
    expect(r.errors.some((e) => e.includes('E-COLOR-002'))).toBe(true);
  });
  it('mode 非法值被拦', () => {
    const r = validateForgeData('palette', {
      name: 'x', mode: 'bright', bg: ['#060609', '#0a0a12'], text: '#e8e8ea', accent: '#ff2e3f',
    });
    expect(r.errors.some((e) => e.includes('mode'))).toBe(true);
  });
});

describe('library seed（浅色种子注册 + 幂等）', () => {
  let home: string;
  const oldHome = process.env.KINE_HOME;
  beforeEach(() => {
    home = mkdtempSync(path.join(os.tmpdir(), 'kine-v6-'));
    process.env.KINE_HOME = home;
  });
  afterEach(() => {
    if (oldHome === undefined) delete process.env.KINE_HOME;
    else process.env.KINE_HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('core/light-paper 注册成功；复跑幂等跳过', async () => {
    const ctx = new AgentContext({ dir: home, dirSource: 'explicit' });
    const r1 = await toolLibrary(ctx, { action: 'seed' });
    expect(r1.ok).toBe(true);
    const d1 = r1.data as { added: string[]; errors: string[] };
    expect(d1.errors).toEqual([]);
    expect(d1.added).toContain('core/light-paper');

    const r2 = await toolLibrary(ctx, { action: 'seed' });
    const d2 = r2.data as { skipped: string[]; errors: string[] };
    expect(d2.errors).toEqual([]);
    expect(d2.skipped).toContain('core/light-paper');
  });
});

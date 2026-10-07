// tests/impact.test.ts — 影响分析闭包（规格文档08 §8.3 失效规则表；9.6 用例⑤）
import { describe, expect, it } from 'vitest';
import { AgentContext, toolImpact } from '@kine/agent';

const MV = 'examples/mv-mini';

async function impactOfPath(path: string) {
  const ctx = new AgentContext({ dir: MV, quiet: true });
  const res = await toolImpact(ctx, { paths: [path] });
  expect(res.ok).toBe(true);
  const data = res.data as { impact: { invalidates: string[]; keeps: string[]; warnings: string[] } };
  return data.impact;
}

describe('impact 影响分析', () => {
  it('pace 改动：map 失效，但 sfx 不重合成（用例⑤）', async () => {
    const imp = await impactOfPath('pace.segments[1].ratio');
    expect(imp.invalidates).toContain('map');
    expect(imp.keeps.some((s) => s.includes('audio:sfx'))).toBe(true);
    expect(imp.warnings.length).toBeGreaterThan(0); // 时间重映射警告
  });

  it('audio.music.file：音频产物重做，画面帧保留（不重渲）', async () => {
    const imp = await impactOfPath('audio.music.file');
    expect(imp.invalidates).toContain('audio:mix');
    expect(imp.invalidates.some((s) => s.includes('frames'))).toBe(false);
    expect(imp.keeps.some((s) => s.includes('frames'))).toBe(true);
  });

  it('单层改 props：只失效该幕帧', async () => {
    const imp = await impactOfPath('scenes[title].layers[title_main].props.size');
    expect(imp.invalidates).toContain('frames:title');
    expect(imp.invalidates).not.toContain('frames:boot');
    expect(imp.invalidates).not.toContain('frames:code');
  });

  it('output.duration：全时间派生物失效 + 方向性决策警告', async () => {
    const imp = await impactOfPath('output.duration');
    expect(imp.invalidates).toContain('map');
    expect(imp.invalidates).toContain('audio:mix');
    expect(imp.warnings.some((w) => w.includes('方向') || w.includes('确认'))).toBe(true);
  });
});

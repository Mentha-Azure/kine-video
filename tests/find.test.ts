// tests/find.test.ts — 语义寻址与歧义协议（规格文档03 §3.7 / 9.6 用例⑦）
import { describe, expect, it } from 'vitest';
import { AgentContext, toolFind } from '@kine/agent';

describe('find 语义寻址', () => {
  it('近义双候选 → AMBIGUOUS 且带候选列表（用例⑦）', async () => {
    const ctx = new AgentContext({ dir: 'fixtures/ambiguous', quiet: true });
    const res = await toolFind(ctx, { query: '标题' });
    expect(res.ok).toBe(true);
    expect(res.verdict).toBe('AMBIGUOUS');
    const data = res.data as { options?: { id: string }[]; candidates?: { id: string }[] };
    const list = data.options ?? data.candidates ?? [];
    expect(list.length).toBeGreaterThanOrEqual(2);
    const ids = list.map((o) => o.id);
    expect(ids).toContain('title_main');
    expect(ids).toContain('title_sub');
  });

  it('唯一 id 精确命中 → PASS', async () => {
    const ctx = new AgentContext({ dir: 'fixtures/ambiguous', quiet: true });
    const res = await toolFind(ctx, { query: 'title_main' });
    expect(res.ok).toBe(true);
    expect(res.verdict).toBe('PASS');
  });
});

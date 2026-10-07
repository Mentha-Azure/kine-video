// tests/edit.test.ts — 事务化编辑：apply → changelog → 回滚（规格文档08 §8.4）
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AgentContext, toolEdit, toolRollback } from '@kine/agent';

const SRC = path.resolve('examples/mv-mini');
const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'kine-edit-test-'));

function prepareProject(): string {
  const dst = path.join(tmpRoot, 'proj');
  cpSync(SRC, dst, {
    recursive: true,
    filter: (s) => !/[\\/]\.kine([\\/]|$)/.test(s) && !s.includes('node_modules'),
  });
  for (const d of ['backup', 'locks', 'logs', 'cache', 'ir', 'work', 'out', 'baseline']) {
    mkdirSync(path.join(dst, '.kine', d), { recursive: true });
  }
  return dst;
}

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('edit 事务 + rollback', () => {
  it('--tx 提交写入 timeline.yaml 并记 changelog；rollback 还原', async () => {
    const dir = prepareProject();
    const ctx = new AgentContext({ dir, quiet: true });

    const before = readFileSync(path.join(dir, 'timeline.yaml'), 'utf8');
    const res = await toolEdit(ctx, {
      expr: 'set scenes[title].layers[title_main].props.size=80',
      quote: '测试：标题字号改为 80',
      tx: true,
    });
    expect(res.ok).toBe(true);
    const data = res.data as { committed?: boolean; txId?: string };
    expect(data.committed).toBe(true);
    expect(data.txId).toMatch(/^tx_\d{8}_\d{3}$/);

    const after = readFileSync(path.join(dir, 'timeline.yaml'), 'utf8');
    expect(before).not.toBe(after);
    expect(after).toContain('size: 80');

    const changelog = readFileSync(path.join(dir, '.kine', 'changelog.jsonl'), 'utf8');
    expect(changelog).toContain(data.txId!);
    expect(changelog).toContain('测试：标题字号改为 80');

    // 备份文件存在
    const backupDir = path.join(dir, '.kine', 'backup');
    const backups = (await import('node:fs')).readdirSync(backupDir);
    expect(backups.length).toBeGreaterThan(0);

    // 回滚
    const rb = await toolRollback(ctx, { txId: data.txId! });
    expect(rb.ok).toBe(true);
    const restored = readFileSync(path.join(dir, 'timeline.yaml'), 'utf8');
    expect(restored).toContain('size: 88');
    expect(existsSync(path.join(dir, 'timeline.yaml'))).toBe(true);
  });
});

// tests/info-versions.test.ts — 回归：versions[].file 路径（真 bug）+ 音乐事实句三态
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { AgentContext, toolInfo, toolInit } from '@kine/agent';

const SRC = path.resolve('examples/mv-mini');
const tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'kine-info-test-'));

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe('info：版本产物路径与音频事实句', () => {
  it('versions[].file 指向 out/<version>/<version>.mp4（而非裸文件名）', async () => {
    const dir = path.join(tmpRoot, 'proj');
    cpSync(SRC, dir, {
      recursive: true,
      filter: (s) => !/[\\/]\.kine([\\/]|$)/.test(s) && !s.includes('node_modules'),
    });
    // 伪造一个已发布版本目录：<version>.mp4 + video.mp4 + shots/（验证优先级与路径拼接）
    const vDir = path.join(dir, '.kine', 'out', 'v0.1');
    mkdirSync(path.join(vDir, 'shots'), { recursive: true });
    writeFileSync(path.join(vDir, 'v0.1.mp4'), 'x');
    writeFileSync(path.join(vDir, 'video.mp4'), 'x');

    const ctx = new AgentContext({ dir, quiet: true });
    const res = await toolInfo(ctx);
    expect(res.ok).toBe(true);
    const data = res.data as { versions: { version: string; file?: string }[] };
    const v = data.versions.find((x) => x.version === 'v0.1');
    expect(v).toBeTruthy();
    expect(v!.file).toBe(path.relative(dir, path.join(vDir, 'v0.1.mp4')));
    expect(v!.file).not.toContain('..');
  });

  it('无音乐工程的事实句为「音乐：无」且无「文件缺失」', async () => {
    const dir = path.join(tmpRoot, 'blank');
    const init = await toolInit({ dir, template: 'blank' });
    expect(init.ok).toBe(true);

    const ctx = new AgentContext({ dir, quiet: true });
    const res = await toolInfo(ctx);
    expect(res.ok).toBe(true);
    const facts = res.facts.join('\n');
    expect(facts).toContain('音乐：无；');
    expect(facts).not.toContain('文件缺失');
  });
});

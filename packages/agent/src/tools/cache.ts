// cache.ts — 缓存状态与 GC
import path from 'node:path';
import { cacheStatus, cacheGc, dirSize } from '@kine/store';
import { ok, fail, type ToolResult } from '../types';
import type { AgentContext } from '../context';

function bytes(n: number): string {
  if (n > 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n > 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n > 1e3) return `${(n / 1e3).toFixed(1)} KB`;
  return `${n} B`;
}

export async function toolCache(ctx: AgentContext, args: { action?: 'status' | 'gc'; maxBytes?: number; dryRun?: boolean }): Promise<ToolResult> {
  const store = ctx.store;
  const { cacheDir, locksDir, workDir } = store.layout;
  const action = args.action ?? 'status';

  if (action === 'status') {
    const st = cacheStatus(cacheDir);
    const workBytes = dirSize(workDir);
    const byKind = Object.entries(st.byKind).map(([k, v]) => `${k}: ${v.count} 项 / ${bytes(v.bytes)}`);
    const facts = [
      `缓存条目 ${st.entries} 个（${bytes(st.totalBytes)}），命中率 ${(st.hitRate * 100).toFixed(1)}%`,
      ...byKind.map((s) => `  ${s}`),
      `工作目录（分片/会话）：${bytes(workBytes)}`,
      `孤儿文件：${st.orphans}（无索引条目）`,
    ];
    return ok('cache', { status: st, workDirBytes: workBytes }, { facts, hints: ['kine cache gc 清理（默认上限 20GB，LRU 驱逐）'] });
  }

  // gc
  const maxBytes = args.maxBytes ?? 20 * 1024 ** 3;
  const r = cacheGc(cacheDir, { maxBytes, dryRun: !!args.dryRun });
  const facts = [
    args.dryRun ? '[dry-run] 将执行：' : '已执行：',
    `移除索引条目 ${r.removedEntries} 个、文件 ${r.removedFiles} 个，释放 ${bytes(r.freedBytes)}`,
    `保留 ${bytes(r.keptBytes)}（上限 ${bytes(maxBytes)}）`,
  ];
  return ok('cache', r, { facts });
}

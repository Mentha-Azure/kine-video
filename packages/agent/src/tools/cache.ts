// cache.ts — 缓存状态与 GC（cacheDir + work 目录）
import { cacheStatus, cacheGc, workStatus, workGc } from '@kine/store';
import { ok, type ToolResult } from '../types';
import type { AgentContext } from '../context';

function bytes(n: number): string {
  if (n > 1e9) return `${(n / 1e9).toFixed(2)} GB`;
  if (n > 1e6) return `${(n / 1e6).toFixed(1)} MB`;
  if (n > 1e3) return `${(n / 1e3).toFixed(1)} KB`;
  return `${n} B`;
}

export async function toolCache(ctx: AgentContext, args: { action?: 'status' | 'gc'; maxBytes?: number; workMaxBytes?: number; dryRun?: boolean }): Promise<ToolResult> {
  const store = ctx.store;
  const { cacheDir, workDir } = store.layout;
  const action = args.action ?? 'status';

  if (action === 'status') {
    const st = cacheStatus(cacheDir);
    const wk = workStatus(workDir);
    const byKind = Object.entries(st.byKind).map(([k, v]) => `${k}: ${v.count} 项 / ${bytes(v.bytes)}`);
    const top = wk.subs
      .slice(0, 5)
      .map((s) => `${s.hash}/${s.sub}  ${s.kind === 'scratch' ? '派生·随时可删' : '复用·缓存'}  ${bytes(s.bytes)}`);
    const facts = [
      `缓存条目 ${st.entries} 个（${bytes(st.totalBytes)}），命中率 ${(st.hitRate * 100).toFixed(1)}%`,
      ...byKind.map((s) => `  ${s}`),
      `work 目录 ${bytes(wk.totalBytes)}：派生 ${bytes(wk.scratchBytes)}（frames）/ 采样 ${bytes(wk.sampleBytes)}（shots-*，可重采）/ 复用 ${bytes(wk.cacheBytes)}（chunk·browser）`,
      ...top.map((s) => `  ${s}`),
      `孤儿文件：${st.orphans}（无索引条目）`,
    ];
    return ok(
      'cache',
      { status: st, work: wk },
      {
        facts,
        hints: [
          'kine cache gc：frames 无条件删；超上限时先删 shots-* 采样帧（可按 _index.json 重采），仍超再按 mtime 整目录驱逐 <hash>（默认上限 work 2GB / cache 20GB，--work-max / --max 调整）',
          'work 的占用随 spec 版本累积（<visualHash8>/ 每版一个目录）——迭代多的工程优先 gc',
        ],
      },
    );
  }

  // gc：cacheDir（真缓存索引） + workDir（派生 / 采样 / LRU）
  const maxBytes = args.maxBytes ?? 20 * 1024 ** 3;
  const workMaxBytes = args.workMaxBytes ?? 2 * 1024 ** 3;
  const r = cacheGc(cacheDir, { maxBytes, dryRun: !!args.dryRun });
  const w = workGc(workDir, { maxBytes: workMaxBytes, dryRun: !!args.dryRun });
  const facts = [
    args.dryRun ? '[dry-run] 将执行：' : '已执行：',
    `cache：移除条目 ${r.removedEntries.length} / 文件 ${r.removedFiles.length}，释放 ${bytes(r.freedBytes)}，保留 ${bytes(r.keptBytes)}（上限 ${bytes(maxBytes)}）`,
    `work：移除 ${w.removedDirs.length} 项（frames ${bytes(w.scratchBytes)} + 采样 ${bytes(w.sampleBytes)} + LRU 驱逐 ${bytes(w.evictedBytes)}），释放 ${bytes(w.freedBytes)}，保留 ${bytes(w.keptBytes)}（上限 ${bytes(workMaxBytes)}）`,
  ];
  return ok('cache', { ...r, work: w }, { facts });
}

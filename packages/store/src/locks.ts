// @kine/store — 文件锁（同 key 并发写保护）
import fs from 'node:fs';
import path from 'node:path';
import lockfile from 'proper-lockfile';

export function lockPath(locksDir: string, name: string): string {
  const safe = name.replace(/[^a-zA-Z0-9._-]/g, '_');
  return path.join(locksDir, `${safe}.lock`);
}

/** 在锁保护下执行 fn（锁名唯一决定互斥域；stale 15s 自动回收） */
export async function withLock<T>(locksDir: string, name: string, fn: () => Promise<T> | T): Promise<T> {
  fs.mkdirSync(locksDir, { recursive: true });
  const target = lockPath(locksDir, name);
  // 锁目标文件允许不存在：以 target 为锁实体（realpath:false）
  const release = await lockfile.lock(target, {
    realpath: false,
    stale: 15000,
    retries: { retries: 40, factor: 1.4, minTimeout: 50, maxTimeout: 600 },
  });
  try {
    return await fn();
  } finally {
    try { await release(); } catch { /* ignore */ }
  }
}

/** 清理 stale 锁（doctor 用）：删除 > staleMs 未更新的 *.lock 目录 */
export function cleanStaleLocks(locksDir: string, staleMs = 10 * 60 * 1000): string[] {
  const removed: string[] = [];
  if (!fs.existsSync(locksDir)) return removed;
  for (const name of fs.readdirSync(locksDir)) {
    if (!name.endsWith('.lock')) continue;
    const p = path.join(locksDir, name);
    try {
      const st = fs.statSync(p);
      if (Date.now() - st.mtimeMs > staleMs) {
        fs.rmSync(p, { recursive: true, force: true });
        removed.push(name);
      }
    } catch { /* ignore */ }
  }
  return removed;
}

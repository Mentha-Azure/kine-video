// @kine/store — 缓存索引：登记产物 {key,kind,path,inputs,size,hits}，状态统计与 LRU gc
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFile, dirSize, readJsonFile, writeJsonAtomic } from './layout';
import { withLock } from './locks';

export interface CacheEntry {
  key: string;
  kind: string;
  /** 相对 cacheDir 的路径（正斜杠） */
  path: string;
  inputs: string[];
  created: string;
  size: number;
  hits: number;
  lastHit?: string;
}

export interface CacheIndex {
  version: 1;
  entries: Record<string, CacheEntry>;
  stats: { requests: number; hits: number; misses: number };
}

const EMPTY: CacheIndex = { version: 1, entries: {}, stats: { requests: 0, hits: 0, misses: 0 } };

export function cacheIndexFile(cacheDir: string): string {
  return path.join(cacheDir, 'index.json');
}

export function loadCacheIndex(cacheDir: string): CacheIndex {
  return readJsonFile<CacheIndex>(cacheIndexFile(cacheDir), structuredClone(EMPTY));
}

export function saveCacheIndex(cacheDir: string, idx: CacheIndex): void {
  writeJsonAtomic(cacheIndexFile(cacheDir), idx);
}

/** 登记（或刷新）一条缓存产物。file 为绝对路径；重复 key 覆盖登记但不删旧文件（由 gc 清理孤儿）。 */
export async function registerArtifact(
  cacheDir: string,
  locksDir: string,
  entry: { key: string; kind: string; file: string; inputs: string[] },
): Promise<CacheEntry> {
  return withLock(locksDir, `cache-index`, () => {
    const idx = loadCacheIndex(cacheDir);
    const rel = path.relative(cacheDir, entry.file).split(path.sep).join('/');
    let size = 0;
    try { size = fs.statSync(entry.file).size; } catch { /* ignore */ }
    const prev = idx.entries[entry.key];
    const rec: CacheEntry = {
      key: entry.key,
      kind: entry.kind,
      path: rel,
      inputs: entry.inputs,
      created: prev?.created ?? new Date().toISOString(),
      size,
      hits: prev?.hits ?? 0,
      lastHit: prev?.lastHit,
    };
    idx.entries[entry.key] = rec;
    saveCacheIndex(cacheDir, idx);
    return rec;
  });
}

/** 记一次请求（命中/未命中），用于 status 命中率 */
export async function recordRequest(cacheDir: string, locksDir: string, hit: boolean): Promise<void> {
  return withLock(locksDir, 'cache-index', () => {
    const idx = loadCacheIndex(cacheDir);
    idx.stats.requests += 1;
    if (hit) idx.stats.hits += 1;
    else idx.stats.misses += 1;
    saveCacheIndex(cacheDir, idx);
  });
}

export async function touchEntry(cacheDir: string, locksDir: string, key: string): Promise<void> {
  return withLock(locksDir, 'cache-index', () => {
    const idx = loadCacheIndex(cacheDir);
    const e = idx.entries[key];
    if (!e) return;
    e.hits += 1;
    e.lastHit = new Date().toISOString();
    saveCacheIndex(cacheDir, idx);
  });
}

export interface CacheStatus {
  entries: number;
  totalBytes: number;
  byKind: Record<string, { count: number; bytes: number }>;
  hitRate: number;
  orphans: string[];
}

export function cacheStatus(cacheDir: string): CacheStatus {
  const idx = loadCacheIndex(cacheDir);
  const byKind: Record<string, { count: number; bytes: number }> = {};
  let total = 0;
  const known = new Set<string>();
  for (const e of Object.values(idx.entries)) {
    const fp = path.join(cacheDir, e.path);
    known.add(path.normalize(fp));
    let size = e.size;
    try { size = fs.statSync(fp).size; } catch { /* keep recorded */ }
    byKind[e.kind] ??= { count: 0, bytes: 0 };
    byKind[e.kind].count += 1;
    byKind[e.kind].bytes += size;
    total += size;
  }
  // 孤儿扫描（仅一层目录，cache 下文件）
  const orphans: string[] = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) walk(fp);
      else if (path.normalize(fp) !== path.normalize(cacheIndexFile(cacheDir)) && !known.has(path.normalize(fp))) {
        orphans.push(path.relative(cacheDir, fp).split(path.sep).join('/'));
      }
    }
  };
  walk(cacheDir);
  const { requests, hits } = idx.stats;
  return { entries: Object.keys(idx.entries).length, totalBytes: total, byKind, hitRate: requests > 0 ? hits / requests : 0, orphans };
}

export interface GcResult {
  removedEntries: string[];
  removedFiles: string[];
  freedBytes: number;
  keptBytes: number;
}

/** LRU 回收：删除孤儿文件 + 超出 maxBytes 时按 lastHit/created 从旧到新驱逐 */
export function cacheGc(cacheDir: string, opts: { maxBytes?: number; dryRun?: boolean } = {}): GcResult {
  const maxBytes = opts.maxBytes ?? 20 * 1024 * 1024 * 1024;
  const idx = loadCacheIndex(cacheDir);
  const removedEntries: string[] = [];
  const removedFiles: string[] = [];
  let freed = 0;

  // 1) 记录已丢失的条目
  for (const [key, e] of Object.entries(idx.entries)) {
    const fp = path.join(cacheDir, e.path);
    if (!fs.existsSync(fp)) {
      removedEntries.push(key);
      delete idx.entries[key];
    }
  }
  // 2) 孤儿文件
  const status = cacheStatus(cacheDir);
  for (const rel of status.orphans) {
    removedFiles.push(rel);
    freed += fs.existsSync(path.join(cacheDir, rel)) ? fs.statSync(path.join(cacheDir, rel)).size : 0;
  }
  if (!opts.dryRun) {
    for (const rel of status.orphans) {
      try { fs.rmSync(path.join(cacheDir, rel), { force: true }); } catch { /* ignore */ }
    }
  }
  // 3) LRU 驱逐
  let total = Object.values(idx.entries).reduce((s, e) => {
    try { return s + fs.statSync(path.join(cacheDir, e.path)).size; } catch { return s; }
  }, 0);
  const order = Object.values(idx.entries).sort((a, b) => {
    const ka = Date.parse(a.lastHit ?? a.created);
    const kb = Date.parse(b.lastHit ?? b.created);
    return ka - kb;
  });
  let i = 0;
  while (total > maxBytes && i < order.length) {
    const e = order[i++];
    const fp = path.join(cacheDir, e.path);
    let size = e.size;
    try { size = fs.statSync(fp).size; } catch { /* ignore */ }
    removedEntries.push(e.key);
    removedFiles.push(e.path);
    total -= size;
    freed += size;
    delete idx.entries[e.key];
    if (!opts.dryRun) {
      try { fs.rmSync(fp, { force: true }); } catch { /* ignore */ }
    }
  }
  if (!opts.dryRun) {
    saveCacheIndex(cacheDir, idx);
  }
  return { removedEntries, removedFiles, freedBytes: freed, keptBytes: total };
}

export function cacheDirSize(cacheDir: string): number {
  return dirSize(cacheDir);
}

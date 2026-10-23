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

// ---------------------------------------------------------------- work 目录（派生/采样/复用）
// work = <workDir>/<visualHash8>/{frames,shots-*,chunk,browser,...}
//   scratch  frames    纯输出转储（只有 --keep-frames 时才有人看）→ 无条件删
//   samples  shots-*   指标采样帧（_index.json 跨调用复用，但体积最大）→ 超预算时优先删
//   cache    chunk/browser  分片编码 / Chromium profile（重建代价高）→ 仍超预算时按 mtime LRU 整目录驱逐
const SCRATCH_WORK_DIRS = new Set(['frames']);
export type WorkSubKind = 'scratch' | 'samples' | 'cache';
export function classifyWorkSub(name: string): WorkSubKind {
  if (SCRATCH_WORK_DIRS.has(name)) return 'scratch';
  if (name.startsWith('shots-')) return 'samples';
  return 'cache';
}

export interface WorkSubUsage {
  hash: string;
  sub: string;
  kind: WorkSubKind;
  bytes: number;
  mtimeMs: number;
}

export interface WorkUsage {
  totalBytes: number;
  scratchBytes: number;
  sampleBytes: number;
  cacheBytes: number;
  byName: Record<string, number>;
  subs: WorkSubUsage[];
}

/** work 目录逐项统计（按 <hash>/<sub> 明细 + 三档小计） */
export function workStatus(workDir: string): WorkUsage {
  const usage: WorkUsage = { totalBytes: 0, scratchBytes: 0, sampleBytes: 0, cacheBytes: 0, byName: {}, subs: [] };
  let hashes: string[] = [];
  try {
    hashes = fs.readdirSync(workDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return usage;
  }
  for (const hash of hashes) {
    const hd = path.join(workDir, hash);
    let entries: fs.Dirent[] = [];
    try { entries = fs.readdirSync(hd, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue; // 散落文件正常不该有，不计入
      const sub = e.name;
      const sd = path.join(hd, sub);
      const bytes = dirSize(sd);
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(sd).mtimeMs; } catch { /* ignore */ }
      const kind = classifyWorkSub(sub);
      usage.subs.push({ hash, sub, kind, bytes, mtimeMs });
      usage.totalBytes += bytes;
      if (kind === 'scratch') usage.scratchBytes += bytes;
      else if (kind === 'samples') usage.sampleBytes += bytes;
      else usage.cacheBytes += bytes;
      usage.byName[sub] = (usage.byName[sub] ?? 0) + bytes;
    }
  }
  usage.subs.sort((a, b) => b.bytes - a.bytes);
  return usage;
}

export interface WorkGcResult {
  /** 被删的相对路径：<hash>/<sub> 或整个 <hash> */
  removedDirs: string[];
  scratchBytes: number;
  sampleBytes: number;
  evictedBytes: number;
  freedBytes: number;
  keptBytes: number;
}

/**
 * work 目录回收（v5 补：cacheGc 原本只清 cacheDir，work 一直没人管）
 *   ① scratch（frames）无条件删——零复用价值
 *   ② 仍超 maxBytes：删所有 samples（shots-*，体积最大、可按 _index.json 重采）
 *   ③ 再超：按 <hash> 的 mtime 从旧到新整目录驱逐（chunk/browser 一起走）
 */
export function workGc(workDir: string, opts: { maxBytes?: number; dryRun?: boolean } = {}): WorkGcResult {
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024 * 1024;
  const res: WorkGcResult = { removedDirs: [], scratchBytes: 0, sampleBytes: 0, evictedBytes: 0, freedBytes: 0, keptBytes: 0 };
  if (!fs.existsSync(workDir)) return res;

  const del = (rel: string) => {
    if (!opts.dryRun) {
      try { fs.rmSync(path.join(workDir, rel), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  };

  // ① scratch
  const before = workStatus(workDir);
  let total = before.totalBytes;
  for (const s of before.subs) {
    if (s.kind !== 'scratch') continue;
    res.removedDirs.push(`${s.hash}/${s.sub}`);
    res.scratchBytes += s.bytes;
    total -= s.bytes;
    del(`${s.hash}/${s.sub}`);
  }

  // ② samples（只在超预算时）
  if (total > maxBytes) {
    for (const s of before.subs) {
      if (s.kind !== 'samples') continue;
      if (total <= maxBytes) break;
      res.removedDirs.push(`${s.hash}/${s.sub}`);
      res.sampleBytes += s.bytes;
      total -= s.bytes;
      del(`${s.hash}/${s.sub}`);
    }
  }

  // ③ 整目录 LRU（再不够才动 chunk/browser）
  if (total > maxBytes) {
    let hashes: string[] = [];
    try {
      hashes = fs.readdirSync(workDir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch { /* ignore */ }
    const dirs = hashes.map((hash) => {
      const hd = path.join(workDir, hash);
      let bytes = 0;
      let mtimeMs = 0;
      try { bytes = dirSize(hd); } catch { /* ignore */ }
      try { mtimeMs = fs.statSync(hd).mtimeMs; } catch { /* ignore */ }
      return { hash, bytes, mtimeMs };
    });
    for (const d of dirs.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
      if (total <= maxBytes) break;
      res.removedDirs.push(d.hash);
      res.evictedBytes += d.bytes;
      total -= d.bytes;
      del(d.hash);
    }
  }

  res.freedBytes = res.scratchBytes + res.sampleBytes + res.evictedBytes;
  res.keptBytes = Math.max(0, total);
  return res;
}

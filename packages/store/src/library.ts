// @kine/store — 用户级资源库（M8a）：内容寻址 + 索引 + 元数据 + 引用解析
//
// 布局（<kineHome>/library/）：
//   index.json              条目索引（id → entry）
//   blobs/<sha2>/<sha256>   内容寻址的原始文件（music/image/video/font）
//   meta/<id>.json          条目元数据快照（analysis/data）
//   previews/<id>.png       预览图（可选）
//
// 引用：library://<id>（精确）｜library://@<tag>（标签句柄）。
// 解析歧义必须显式（E-LIB-002，多候选列 facts，禁静默选取）。
import { createHash } from 'node:crypto';
import {
  copyFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync,
} from 'node:fs';
import * as path from 'node:path';
import { kineHome } from './paths';
import { withLock } from './locks';
import { atomicWriteFile } from './layout';

export type LibraryKind =
  | 'music' | 'image' | 'video' | 'font'
  | 'theme' | 'palette' | 'layout' | 'blueprint' | 'preset'
  | 'sfx-preset' | 'music-preset' | 'xf-suite' | 'widget-pack' | 'kit' | 'voice';

export const LIBRARY_KINDS: LibraryKind[] = [
  'music', 'image', 'video', 'font',
  'theme', 'palette', 'layout', 'blueprint', 'preset',
  'sfx-preset', 'music-preset', 'xf-suite', 'widget-pack', 'kit', 'voice',
];

/** 需要 blob 落盘的库类 */
export const BLOB_KINDS: LibraryKind[] = ['music', 'image', 'video', 'font'];

export type LibraryStatus = 'draft' | 'library';

export interface LibraryEntry {
  id: string;
  kind: LibraryKind;
  name: string;
  ns: 'core' | 'ai' | 'usr';
  tags: string[];
  status: LibraryStatus;
  version: number;
  /** 内容寻址哈希（blob 类必有；设计类若含引用文件也可有） */
  sha256?: string;
  size?: number;
  /** blob 相对路径（相对 library 根） */
  blob?: string;
  /** 设计类内联数据（theme/palette/blueprint/preset/...） */
  data?: unknown;
  /** 分析结果（音乐 BPM 等） */
  analysis?: unknown;
  license?: string | null;
  source?: string | null;
  created: string;
  updated: string;
}

export interface LibraryIndex {
  version: 1;
  entries: Record<string, LibraryEntry>;
}

export interface LibraryError {
  code: string;
  message: string;
  facts?: string[];
  hints?: string[];
}

export function kineLibraryRoot(): string {
  return path.join(kineHome(), 'library');
}

export function libraryIndexFile(root = kineLibraryRoot()): string {
  return path.join(root, 'index.json');
}

export function libraryBlobPath(root: string, sha256: string): string {
  return path.join(root, 'blobs', sha256.slice(0, 2), sha256);
}

export function libraryMetaPath(root: string, id: string): string {
  return path.join(root, 'meta', `${id.replace(/\//g, '__')}.json`);
}

// ---- 索引读写（读宽写严）

export function readLibraryIndex(root = kineLibraryRoot()): LibraryIndex {
  try {
    const raw = JSON.parse(readFileSync(libraryIndexFile(root), 'utf8')) as { entries?: unknown };
    if (raw && typeof raw === 'object' && raw.entries && typeof raw.entries === 'object') {
      return { version: 1, entries: raw.entries as Record<string, LibraryEntry> };
    }
  } catch {
    // 空库或首次使用
  }
  return { version: 1, entries: {} };
}

function writeIndexUnlocked(root: string, idx: LibraryIndex): void {
  mkdirSync(root, { recursive: true });
  atomicWriteFile(libraryIndexFile(root), JSON.stringify(idx, null, 2));
}

export async function withLibraryLock<T>(fn: () => Promise<T> | T): Promise<T> {
  return withLock(path.join(kineHome(), 'locks'), 'library-index', fn);
}

// ---- id / tag 规范化

const TAG_RE = /^[a-z0-9][a-z0-9-]{0,11}$/;
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function normalizeTag(t: string): string {
  const v = t.trim().toLowerCase().replace(/^@/, '');
  if (!TAG_RE.test(v)) throw Object.assign(new Error(`非法标签 "${t}"：小写 kebab（≤12 字），如 @noir`), { code: 'E-LIB-010' });
  return v;
}

export function makeLibraryId(name: string, ns: 'core' | 'ai' | 'usr' = 'usr'): string {
  const n = name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  if (!NAME_RE.test(n)) throw Object.assign(new Error(`非法名称 "${name}"：小写字母/数字/连字符（≤40 字）`), { code: 'E-LIB-011' });
  return `${ns}/${n}`;
}

// ---- blob（内容寻址）

export async function hashFile256(file: string): Promise<{ sha256: string; size: number }> {
  const size = statSync(file).size;
  const h = createHash('sha256');
  await new Promise<void>((res, rej) => {
    createReadStream(file)
      .on('data', (c) => h.update(c))
      .on('end', () => res())
      .on('error', rej);
  });
  return { sha256: h.digest('hex'), size };
}

export async function addBlob(root: string, file: string): Promise<{ sha256: string; size: number; blob: string; existed: boolean }> {
  const { sha256, size } = await hashFile256(file);
  const rel = path.join('blobs', sha256.slice(0, 2), sha256);
  const blob = rel.split(path.sep).join('/');
  const dest = path.join(root, rel);
  if (existsSync(dest)) return { sha256, size, blob, existed: true };
  mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.tmp-${process.pid}`;
  copyFileSync(file, tmp);
  renameSync(tmp, dest);
  return { sha256, size, blob, existed: false };
}

// ---- 条目 CRUD

export interface AddEntryInput {
  name: string;
  kind: LibraryKind;
  ns?: 'core' | 'ai' | 'usr';
  id?: string;
  tags?: string[];
  status?: LibraryStatus;
  sha256?: string;
  size?: number;
  blob?: string;
  data?: unknown;
  analysis?: unknown;
  license?: string | null;
  source?: string | null;
}

export async function addLibraryEntry(root: string, input: AddEntryInput): Promise<LibraryEntry> {
  return withLibraryLock(() => {
    const idx = readLibraryIndex(root);
    const id = input.id ?? makeLibraryId(input.name, input.ns ?? 'usr');
    const prev = idx.entries[id];
    const now = new Date().toISOString();
    const entry: LibraryEntry = {
      id,
      kind: input.kind,
      name: input.name.trim(),
      ns: input.ns ?? ((id.split('/')[0] as LibraryEntry['ns']) || 'usr'),
      tags: (input.tags ?? prev?.tags ?? []).map(normalizeTag),
      status: input.status ?? prev?.status ?? 'draft',
      version: (prev?.version ?? 0) + 1,
      sha256: input.sha256 ?? prev?.sha256,
      size: input.size ?? prev?.size,
      blob: input.blob ?? prev?.blob,
      data: input.data !== undefined ? input.data : prev?.data,
      analysis: input.analysis !== undefined ? input.analysis : prev?.analysis,
      license: input.license ?? prev?.license ?? null,
      source: input.source ?? prev?.source ?? null,
      created: prev?.created ?? now,
      updated: now,
    };
    idx.entries[id] = entry;
    writeIndexUnlocked(root, idx);
    mkdirSync(path.dirname(libraryMetaPath(root, id)), { recursive: true });
    atomicWriteFile(
      libraryMetaPath(root, id),
      JSON.stringify({ id, updated: now, sha256: entry.sha256 ?? null, analysis: entry.analysis ?? null, data: entry.data ?? null }, null, 2),
    );
    return entry;
  });
}

export function listLibraryEntries(
  root = kineLibraryRoot(),
  filter: { kind?: LibraryKind; tag?: string; status?: LibraryStatus; ns?: string } = {},
): LibraryEntry[] {
  const tag = filter.tag !== undefined ? normalizeTag(filter.tag) : undefined;
  return Object.values(readLibraryIndex(root).entries)
    .filter(
      (e) =>
        (!filter.kind || e.kind === filter.kind) &&
        (!filter.status || e.status === filter.status) &&
        (!filter.ns || e.ns === filter.ns) &&
        (!tag || e.tags.includes(tag)),
    )
    .sort((a, b) => b.updated.localeCompare(a.updated));
}

export type LibraryResolution = { ok: true; entry: LibraryEntry } | { ok: false; error: LibraryError };

/** 引用解析：id 精确 → 模糊唯一；@tag 唯一。多候选 → E-LIB-002（候选项在 facts）。 */
export function resolveLibraryEntry(root: string, ref: string): LibraryResolution {
  const idx = readLibraryIndex(root);
  const all = Object.values(idx.entries);
  const clean = ref.replace(/^library:\/\//, '').replace(/#pin$/, '').trim();
  if (clean.startsWith('@')) {
    const tag = clean.slice(1).toLowerCase();
    const matches = all.filter((e) => e.tags.includes(tag));
    if (matches.length === 1) return { ok: true, entry: matches[0]! };
    if (matches.length === 0) {
      return { ok: false, error: { code: 'E-LIB-001', message: `标签 "@${tag}" 未命中任何条目`, hints: ['kine library list 查看全部条目'] } };
    }
    return {
      ok: false,
      error: {
        code: 'E-LIB-002',
        message: `标签 "@${tag}" 命中 ${matches.length} 个条目（歧义）`,
        facts: matches.map((m) => `${m.id}（${m.kind}${m.status === 'draft' ? ' · draft' : ''}）`),
        hints: ['用完整 id 精确引用'],
      },
    };
  }
  if (idx.entries[clean]) return { ok: true, entry: idx.entries[clean]! };
  const lc = clean.toLowerCase();
  const fuzzy = all.filter((e) => e.id.toLowerCase().includes(lc) || e.name.toLowerCase().includes(lc));
  if (fuzzy.length === 1) return { ok: true, entry: fuzzy[0]! };
  if (fuzzy.length === 0) {
    return { ok: false, error: { code: 'E-LIB-001', message: `未找到条目 "${clean}"`, hints: ['kine library list 查看；或 kine library add 先入库'] } };
  }
  return {
    ok: false,
    error: {
      code: 'E-LIB-002',
      message: `"${clean}" 命中 ${fuzzy.length} 个条目（歧义）`,
      facts: fuzzy.map((m) => `${m.id}（${m.kind}）`),
      hints: ['用完整 id 或 @tag 精确引用'],
    },
  };
}

export async function removeLibraryEntry(
  root: string,
  ref: string,
  opts: { force?: boolean } = {},
): Promise<{ removed: LibraryEntry; blobRemoved: boolean }> {
  return withLibraryLock(() => {
    const res = resolveLibraryEntry(root, ref);
    if (!res.ok) throw Object.assign(new Error(res.error.message), res.error);
    if (res.entry.status === 'library' && !opts.force) {
      throw Object.assign(new Error(`条目 ${res.entry.id} 已入册（library）；删除需 --force`), { code: 'E-LIB-012' });
    }
    const idx = readLibraryIndex(root);
    delete idx.entries[res.entry.id];
    writeIndexUnlocked(root, idx);
    let blobRemoved = false;
    const sha = res.entry.sha256;
    if (sha && !Object.values(idx.entries).some((e) => e.sha256 === sha)) {
      const bp = libraryBlobPath(root, sha);
      if (existsSync(bp)) {
        rmSync(bp);
        blobRemoved = true;
      }
    }
    try {
      rmSync(libraryMetaPath(root, res.entry.id));
    } catch {
      // 无 meta 快照
    }
    return { removed: res.entry, blobRemoved };
  });
}

/** 清理无引用 blob（遗留/损坏）。 */
export async function gcLibrary(
  root = kineLibraryRoot(),
  opts: { dryRun?: boolean } = {},
): Promise<{ removed: string[]; freedBytes: number; keptBytes: number }> {
  return withLibraryLock(() => {
    const idx = readLibraryIndex(root);
    const referenced = new Set(Object.values(idx.entries).map((e) => e.sha256).filter(Boolean) as string[]);
    const removed: string[] = [];
    let freedBytes = 0;
    let keptBytes = 0;
    const blobsRoot = path.join(root, 'blobs');
    if (existsSync(blobsRoot)) {
      for (const sub of readdirSync(blobsRoot)) {
        const subDir = path.join(blobsRoot, sub);
        if (!statSync(subDir).isDirectory()) continue;
        for (const f of readdirSync(subDir)) {
          const full = path.join(subDir, f);
          const size = statSync(full).size;
          if (referenced.has(f)) keptBytes += size;
          else {
            freedBytes += size;
            removed.push(full);
            if (!opts.dryRun) rmSync(full);
          }
        }
      }
    }
    return { removed, freedBytes, keptBytes };
  });
}

/** 库校验：blob 完整性 + （--dir 时）工程引用可达性与漂移选项。 */
export async function verifyLibrary(
  root = kineLibraryRoot(),
  opts: { dir?: string } = {},
): Promise<{ ok: boolean; checks: string[]; issues: string[]; options: string[] }> {
  const checks: string[] = [];
  const issues: string[] = [];
  const options: string[] = [];
  const idx = readLibraryIndex(root);
  const entries = Object.values(idx.entries);
  checks.push(`条目 ${entries.length} 个`);
  for (const e of entries) {
    if (!e.sha256 || !BLOB_KINDS.includes(e.kind)) continue;
    const bp = libraryBlobPath(root, e.sha256);
    if (!existsSync(bp)) {
      issues.push(`${e.id}：blob 缺失（${e.sha256.slice(0, 12)}…）`);
      continue;
    }
    const size = statSync(bp).size;
    if (e.size !== undefined && e.size !== size) issues.push(`${e.id}：blob 大小不符（索引 ${e.size} vs 实际 ${size}）`);
  }
  if (opts.dir) {
    const timeline = path.join(opts.dir, 'timeline.yaml');
    if (!existsSync(timeline)) {
      issues.push(`工程目录缺少 timeline.yaml：${opts.dir}`);
    } else {
      const text = readFileSync(timeline, 'utf8');
      const refs = [...new Set(text.match(/library:\/\/[^\s"'#]+/g) ?? [])];
      checks.push(`工程引用 ${refs.length} 处（${opts.dir}）`);
      for (const r of refs) {
        const res = resolveLibraryEntry(root, r);
        if (!res.ok) {
          issues.push(`${r}：${res.error.message}`);
          continue;
        }
        checks.push(`${r} → ${res.entry.id} @ v${res.entry.version}${res.entry.sha256 ? ` sha256:${res.entry.sha256.slice(0, 12)}…` : ''}（${res.entry.status}）`);
      }
      if (refs.length > 0) {
        options.push('库条目更新会改变工程 specHash（内容寻址参与哈希）→ 重编译即见差异');
        options.push('如需冻结版本：引用加 `#pin` 或 kine library pin 到工程 assets/（复制文件，工程自持）');
        options.push('如需回滚：旧 blob 在 gc 前保留；对照 changelog / 版本产物')
      }
    }
  }
  return { ok: issues.length === 0, checks, issues, options };
}

/** 把库 blob 复制到工程 assets/（冻结引用，#pin 语义）。 */
export async function pinLibraryAsset(
  root: string,
  projectDir: string,
  ref: string,
  opts: { as?: string } = {},
): Promise<{ file: string; sha256: string; entry: LibraryEntry }> {
  const res = resolveLibraryEntry(root, ref);
  if (!res.ok) throw Object.assign(new Error(res.error.message), res.error);
  const e = res.entry;
  if (!e.sha256 || !e.blob) throw Object.assign(new Error(`条目 ${e.id} 不是文件型条目（无可 pin 的 blob）`), { code: 'E-LIB-013' });
  const src = path.join(root, e.blob);
  if (!existsSync(src)) throw Object.assign(new Error(`条目 ${e.id} 的 blob 缺失`), { code: 'E-LIB-014' });
  const ext = path.extname(e.source ?? '') || '';
  const base = (opts.as ?? `${e.id.split('/').pop() ?? e.name}_${e.sha256.slice(0, 8)}`).replace(/[^a-zA-Z0-9._-]+/g, '-');
  const assetsDir = path.join(projectDir, 'assets');
  mkdirSync(assetsDir, { recursive: true });
  const dest = path.join(assetsDir, base.endsWith(ext) ? base : `${base}${ext}`);
  copyFileSync(src, dest);
  return { file: dest, sha256: e.sha256, entry: e };
}

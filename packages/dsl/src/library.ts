// @kine/dsl — 库引用解析（只读；v2 M8a）。
// 与 @kine/store/library 的写入端共享 index.json 格式；此处保持零内部依赖，供 compile/lint 使用。
import { existsSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface LibEntryLite {
  id: string;
  kind: string;
  name: string;
  ns: string;
  tags: string[];
  status: string;
  version: number;
  sha256?: string;
  blob?: string;
  data?: unknown;
}

/** Kine 用户级数据根目录（KINE_HOME 可覆盖；默认 ~/.local/share/kine） */
export function kineHomeDir(): string {
  return process.env.KINE_HOME?.trim() || path.join(os.homedir(), '.local', 'share', 'kine');
}

export function readLibraryIndexLite(home = kineHomeDir()): Record<string, LibEntryLite> {
  try {
    const raw = JSON.parse(readFileSync(path.join(home, 'library', 'index.json'), 'utf8')) as {
      entries?: Record<string, LibEntryLite>;
    };
    return raw?.entries ?? {};
  } catch {
    return {};
  }
}

export interface LibraryRefError {
  code: 'E-LIB-001' | 'E-LIB-002';
  message: string;
  candidates?: string[];
}

/** 解析 'library://<id>' | 'library://@tag'（返回 null 表示不是库引用） */
export function parseLibraryRef(src: string): { raw: string; isTag: boolean; body: string } | null {
  if (!src.startsWith('library://')) return null;
  const body = src.slice('library://'.length).replace(/#pin$/, '');
  return { raw: src, isTag: body.startsWith('@'), body: body.replace(/^@/, '') };
}

export function libraryBlobFile(entry: LibEntryLite, home = kineHomeDir()): string | null {
  if (!entry.blob) return null;
  const abs = path.join(home, 'library', entry.blob);
  return existsSync(abs) ? abs : null;
}

/** 解析引用 → 条目（含 blob 文件路径，若为素材类）。多候选 → E-LIB-002（禁静默）。 */
export function resolveLibraryRefLite(
  ref: string,
  home = kineHomeDir(),
): { entry: LibEntryLite; file: string | null } | { error: LibraryRefError } {
  const idx = readLibraryIndexLite(home);
  const all = Object.values(idx) as LibEntryLite[];
  const parsed = parseLibraryRef(ref);
  const body = parsed ? parsed.body : ref.replace(/#pin$/, '');
  const isTag = parsed ? parsed.isTag : body.startsWith('@');
  const clean = body.replace(/^@/, '');
  if (isTag) {
    const matches = all.filter((e) => e.tags.includes(clean.toLowerCase()));
    if (matches.length === 1) return { entry: matches[0]!, file: libraryBlobFile(matches[0]!, home) };
    if (matches.length === 0) return { error: { code: 'E-LIB-001', message: `标签 "@${clean}" 未命中任何库条目` } };
    return {
      error: {
        code: 'E-LIB-002',
        message: `标签 "@${clean}" 命中 ${matches.length} 个条目（歧义）`,
        candidates: matches.map((m) => m.id),
      },
    };
  }
  if (idx[clean]) return { entry: idx[clean]!, file: libraryBlobFile(idx[clean]!, home) };
  const lc = clean.toLowerCase();
  const fuzzy = all.filter((e) => e.id.toLowerCase().includes(lc) || e.name.toLowerCase().includes(lc));
  if (fuzzy.length === 1) return { entry: fuzzy[0]!, file: libraryBlobFile(fuzzy[0]!, home) };
  if (fuzzy.length === 0) return { error: { code: 'E-LIB-001', message: `未找到库条目 "${clean}"` } };
  return {
    error: {
      code: 'E-LIB-002',
      message: `"${clean}" 命中 ${fuzzy.length} 个条目（歧义）`,
      candidates: fuzzy.map((m) => m.id),
    },
  };
}

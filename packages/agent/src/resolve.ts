// @kine/agent — 工程目录解析（默认 dir 的四级解析 + 全局登记表）
//
// 解析顺序（未显式传 dir 时）：
//   ① 基准目录向上找 timeline.yaml（findProjectRoot）
//   ② 基准目录向下扫描（深度 3）：唯一命中 → 用；多个 → 取登记表最近使用的；无登记 → 报错列候选
//   ③ 登记表兜底（~/.local/share/kine/projects.json）：唯一有效 → 用；多个 → 报错
//   ④ 都没有 → E-PROJ-001（给出 --dir / init / cd 提示）
// 显式传 dir 时不智能回退：找不到工程直接 E-PROJ-002（避免把修改落到意外工程）。
import { existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import type { Dirent } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { atomicWriteFile, findProjectRoot } from '@kine/store';

// ── 全局登记表 ────────────────────────────────────────────────────────
export interface ProjectRegistryEntry {
  dir: string;
  lastUsed: string;
  title?: string;
}

export interface ProjectRegistry {
  version: 1;
  projects: ProjectRegistryEntry[];
}

export function kineHome(): string {
  return process.env.KINE_HOME?.trim() || path.join(os.homedir(), '.local', 'share', 'kine');
}

export function registryFile(): string {
  return path.join(kineHome(), 'projects.json');
}

export function readRegistry(): ProjectRegistry {
  try {
    const raw = JSON.parse(readFileSync(registryFile(), 'utf8')) as { projects?: unknown };
    if (raw && Array.isArray(raw.projects)) {
      const projects = (raw.projects as ProjectRegistryEntry[]).filter((e) => e && typeof e.dir === 'string');
      return { version: 1, projects };
    }
  } catch {
    /* 无登记表或损坏：视为空 */
  }
  return { version: 1, projects: [] };
}

export function writeRegistry(reg: ProjectRegistry): void {
  mkdirSync(kineHome(), { recursive: true });
  atomicWriteFile(registryFile(), JSON.stringify({ version: 1, projects: reg.projects.slice(0, 50) }, null, 2));
}

/** 记录/刷新一个已知工程（每次成功打开工程后调用；10 分钟内重复访问不写盘） */
export function registerProject(dir: string, title?: string): void {
  try {
    const norm = path.resolve(dir);
    const reg = readRegistry();
    const idx = reg.projects.findIndex((e) => path.resolve(e.dir).toLowerCase() === norm.toLowerCase());
    const now = Date.now();
    if (idx >= 0) {
      const e = reg.projects[idx]!;
      const age = now - Date.parse(e.lastUsed);
      if (Number.isFinite(age) && age < 10 * 60 * 1000) return; // 新鲜：不写盘
      e.lastUsed = new Date(now).toISOString();
      if (title) e.title = title;
      reg.projects.splice(idx, 1);
      reg.projects.unshift(e);
    } else {
      reg.projects.unshift({ dir: norm, lastUsed: new Date(now).toISOString(), title });
    }
    writeRegistry(reg);
  } catch {
    /* 登记失败不阻塞主流程 */
  }
}

// ── 向下扫描 ──────────────────────────────────────────────────────────
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.kine', '.venv', 'venv', '__pycache__',
  'dist', 'build', '.cache', '.smoke', '.tmp', 'coverage', '.idea', '.vscode', 'generated',
]);

/** 向下扫描含 timeline.yaml 的工程目录（默认深度 3，跳过常见无关目录） */
export function scanForProjects(root: string, opts: { maxDepth?: number; limit?: number } = {}): string[] {
  const maxDepth = opts.maxDepth ?? 3;
  const limit = opts.limit ?? 24;
  const found: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = [{ dir: path.resolve(root), depth: 0 }];
  while (queue.length > 0 && found.length < limit) {
    const item = queue.shift()!;
    if (existsSync(path.join(item.dir, 'timeline.yaml'))) found.push(item.dir);
    if (item.depth >= maxDepth) continue;
    let entries: Dirent[] = [];
    try {
      entries = readdirSync(item.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      if (ent.name.startsWith('.') || SKIP_DIRS.has(ent.name)) continue;
      queue.push({ dir: path.join(item.dir, ent.name), depth: item.depth + 1 });
    }
  }
  return found.sort();
}

// ── 解析 ──────────────────────────────────────────────────────────────
export class ResolveError extends Error {
  readonly code: string;
  readonly hints: string[];
  readonly facts: string[];

  constructor(code: string, message: string, extra: { hints?: string[]; facts?: string[] } = {}) {
    super(message);
    this.name = 'ResolveError';
    this.code = code;
    this.hints = extra.hints ?? [];
    this.facts = extra.facts ?? [];
  }
}

export interface ResolvedDir {
  dir: string;
  /** 自动发现/回退时的说明（显式指定时为空） */
  note?: string;
  explicit: boolean;
  /** v4：目录来源（E-PROJ-006 写保护依据） */
  via?: 'explicit' | 'ancestor' | 'scan' | 'registry' | 'direct';
}

function safeFindProjectRoot(dir: string): string | null {
  try {
    return findProjectRoot(dir);
  } catch {
    return null;
  }
}

const SUGGEST =
  '传 dir 参数 / --dir <工程目录>；或在工程目录下运行；kine init <目录> --template mv-mini 新建工程';

export function resolveTargetDir(input: string | undefined, opts: { explicit?: boolean; base?: string } = {}): ResolvedDir {
  const base = path.resolve(opts.base ?? process.env.KINE_CWD ?? process.cwd());
  const explicit = opts.explicit ?? input !== undefined;

  // 显式指定：只做祖先查找，找不到直接报错（不智能回退，避免误改意外工程）
  if (input !== undefined && input.trim() !== '') {
    const abs = path.resolve(base, input);
    const up = safeFindProjectRoot(abs);
    if (up) return { dir: up, explicit, via: 'explicit' };
    const where = existsSync(abs) ? `目录不是 Kine 工程（未找到 timeline.yaml）：${abs}` : `目录不存在：${abs}`;
    throw new ResolveError('E-PROJ-002', where, {
      hints: ['传入工程目录（含 timeline.yaml）或工程内文件路径', 'kine projects 查看已登记工程', 'kine init <目录> 新建工程'],
    });
  }

  // ① 向上找
  const up = safeFindProjectRoot(base);
  if (up) return { dir: up, explicit: false, via: 'ancestor' };

  // ② 向下扫描
  const found = scanForProjects(base);
  if (found.length === 1) {
    return { dir: found[0]!, explicit: false, via: 'scan', note: `未指定 dir：在工作区（${base}）自动发现工程 ${found[0]}` };
  }
  if (found.length > 1) {
    const reg = readRegistry();
    const recent = reg.projects.find((e) => found.some((f) => path.resolve(f).toLowerCase() === path.resolve(e.dir).toLowerCase()));
    if (recent) {
      return {
        dir: recent.dir,
        explicit: false,
        via: 'scan',
        note: `未指定 dir：工作区发现 ${found.length} 个工程，已选取最近使用的 ${recent.dir}（可用 dir 参数或 kine projects 查看）`,
      };
    }
    throw new ResolveError('E-PROJ-003', `未指定 dir，且工作区（${base}）发现多个工程（${found.length} 个），无法自动选择`, {
      facts: found.slice(0, 8).map((f) => `工程：${f}`),
      hints: ['显式指定：kine <命令> --dir <工程目录>（MCP 工具传 dir 参数）'],
    });
  }

  // ③ 登记表兜底
  const reg = readRegistry();
  const valid = reg.projects.filter((e) => safeFindProjectRoot(e.dir) !== null);
  if (valid.length === 1) {
    return { dir: valid[0]!.dir, explicit: false, via: 'registry', note: `当前目录无工程：回退到唯一登记工程 ${valid[0]!.dir}` };
  }
  if (valid.length > 1) {
    throw new ResolveError('E-PROJ-004', '当前目录未发现工程，且登记表中有多个工程，无法自动选择', {
      facts: valid.slice(0, 8).map((e) => `工程：${e.dir}（最近使用 ${e.lastUsed}）`),
      hints: ['显式指定工程目录', 'kine projects 查看/清理登记表'],
    });
  }

  // ④ 都没有
  throw new ResolveError('E-PROJ-001', `未找到 Kine 工程（基准目录：${base}）`, { hints: [SUGGEST] });
}

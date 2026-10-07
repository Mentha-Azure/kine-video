// @kine/store — 工程目录布局与原子文件写入
// 工程结构：<project>/timeline.yaml + assets/ + .kine/{ir,cache,work,out,baseline,logs,locks,backup} + README.md
import fs from 'node:fs';
import path from 'node:path';

export interface ProjectLayout {
  /** 工程根目录（绝对路径） */
  dir: string;
  timelineFile: string;
  readmeFile: string;
  assetsDir: string;
  kineDir: string;
  irFile: string;
  irDir: string;
  cacheDir: string;
  workDir: string;
  outDir: string;
  baselineDir: string;
  changelogFile: string;
  logsDir: string;
  locksDir: string;
  backupDir: string;
}

export function projectLayout(dir: string): ProjectLayout {
  const abs = path.resolve(dir);
  const kineDir = path.join(abs, '.kine');
  return {
    dir: abs,
    timelineFile: path.join(abs, 'timeline.yaml'),
    readmeFile: path.join(abs, 'README.md'),
    assetsDir: path.join(abs, 'assets'),
    kineDir,
    irFile: path.join(kineDir, 'ir', 'project.ir.json'),
    irDir: path.join(kineDir, 'ir'),
    cacheDir: path.join(kineDir, 'cache'),
    workDir: path.join(kineDir, 'work'),
    outDir: path.join(kineDir, 'out'),
    baselineDir: path.join(kineDir, 'baseline'),
    changelogFile: path.join(kineDir, 'changelog.jsonl'),
    logsDir: path.join(kineDir, 'logs'),
    locksDir: path.join(kineDir, 'locks'),
    backupDir: path.join(kineDir, 'backup'),
  };
}

/** 从 dir 或 timeline.yaml 路径找工程根（向上层探测） */
export function findProjectRoot(dirOrFile: string): string {
  let p = path.resolve(dirOrFile);
  if (fs.existsSync(p) && fs.statSync(p).isFile()) p = path.dirname(p);
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(p, 'timeline.yaml'))) return p;
    const parent = path.dirname(p);
    if (parent === p) break;
    p = parent;
  }
  throw new Error(`未找到 timeline.yaml：从 ${dirOrFile} 向上 12 层内无工程文件`);
}

export function ensureLayout(l: ProjectLayout): void {
  for (const d of [l.kineDir, l.irDir, l.cacheDir, l.workDir, l.outDir, l.baselineDir, l.logsDir, l.locksDir, l.backupDir, l.assetsDir]) {
    fs.mkdirSync(d, { recursive: true });
  }
}

/** 大文件/关键文件原子写入（临时文件 + rename，同目录保证同卷） */
export function atomicWriteFile(file: string, data: string | Buffer): void {
  const dir = path.dirname(file);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);
  fs.writeFileSync(tmp, data);
  try {
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw e;
  }
}

export function readJsonFile<T>(file: string, fallback?: T): T {
  if (!fs.existsSync(file)) {
    if (fallback !== undefined) return fallback;
    throw new Error(`文件不存在：${file}`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

export function writeJsonAtomic(file: string, value: unknown): void {
  atomicWriteFile(file, JSON.stringify(value, null, 2) + '\n');
}

export function tsStamp(d = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

export function fileSizeSafe(file: string): number {
  try { return fs.statSync(file).size; } catch { return 0; }
}

export function dirSize(dir: string): number {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop()!;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const fp = path.join(d, e.name);
      if (e.isDirectory()) stack.push(fp);
      else { try { total += fs.statSync(fp).size; } catch { /* ignore */ } }
    }
  }
  return total;
}

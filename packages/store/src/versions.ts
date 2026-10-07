// @kine/store — 版本管理：out/v<major>.<minor>/、自增次版本、latest 指针（终版）
import fs from 'node:fs';
import path from 'node:path';
import { readJsonFile, writeJsonAtomic } from './layout';

export interface VersionInfo {
  version: string;
  dir: string;
  createdAt: string;
  files: string[];
}

export interface LatestPointer {
  version: string;
  ts: string;
  video?: string;
  specHash8?: string;
  verified?: string;
}

const V_RE = /^v(\d+)\.(\d+)$/;

export function listVersions(outDir: string): VersionInfo[] {
  if (!fs.existsSync(outDir)) return [];
  const out: VersionInfo[] = [];
  for (const name of fs.readdirSync(outDir)) {
    if (!V_RE.test(name)) continue;
    const dir = path.join(outDir, name);
    if (!fs.statSync(dir).isDirectory()) continue;
    out.push({
      version: name,
      dir,
      createdAt: fs.statSync(dir).birthtime.toISOString(),
      files: fs.readdirSync(dir).sort(),
    });
  }
  return out.sort((a, b) => cmpVersion(a.version, b.version));
}

/** 版本主产物 mp4：优先 <dir>/<version>.mp4（交付命名），其次 video.mp4，最后任意 *.mp4；返回绝对路径 */
export function versionVideoFile(v: VersionInfo): string | undefined {
  const named = path.join(v.dir, `${v.version}.mp4`);
  if (fs.existsSync(named)) return named;
  const video = path.join(v.dir, 'video.mp4');
  if (fs.existsSync(video)) return video;
  const any = v.files.find((f) => f.endsWith('.mp4'));
  return any ? path.join(v.dir, any) : undefined;
}

export function cmpVersion(a: string, b: string): number {
  const ma = V_RE.exec(a);
  const mb = V_RE.exec(b);
  if (!ma || !mb) return a.localeCompare(b);
  const [a1, a2] = [parseInt(ma[1], 10), parseInt(ma[2], 10)];
  const [b1, b2] = [parseInt(mb[1], 10), parseInt(mb[2], 10)];
  return a1 - b1 || a2 - b2;
}

/** 下一版本号：默认自增次版本；major=true 升主版本并归零次版本 */
export function nextVersion(outDir: string, opts: { major?: boolean; from?: string } = {}): string {
  const versions = listVersions(outDir).map((v) => v.version);
  let base = opts.from;
  if (!base) {
    const latest = readLatest(outDir);
    base = latest?.version ?? versions[versions.length - 1] ?? 'v0.0';
  }
  const m = V_RE.exec(base) ?? V_RE.exec('v0.0')!;
  const major = parseInt(m[1], 10);
  const minor = parseInt(m[2], 10);
  if (opts.major) return `v${major + 1}.0`;
  // 避免与已存在版本冲突
  let v = `v${major}.${minor + 1}`;
  let k = minor + 1;
  while (versions.includes(v)) v = `v${major}.${++k}`;
  return v;
}

export function latestFile(outDir: string): string {
  return path.join(outDir, 'latest.json');
}

export function readLatest(outDir: string): LatestPointer | null {
  const f = latestFile(outDir);
  if (!fs.existsSync(f)) return null;
  try { return readJsonFile<LatestPointer>(f); } catch { return null; }
}

/** 只有 verify 全 PASS（或已解释的 WARN）才允许调用：把「终版」指针指向该版本 */
export function setLatest(outDir: string, p: Omit<LatestPointer, 'ts'> & { ts?: string }): LatestPointer {
  const full: LatestPointer = { ts: new Date().toISOString(), ...p };
  writeJsonAtomic(latestFile(outDir), full);
  return full;
}

export function readDeliverables(versionDir: string): { video?: string; report?: string; previews: string[]; shots: string[] } {
  const out: { video?: string; report?: string; previews: string[]; shots: string[] } = { previews: [], shots: [] };
  if (!fs.existsSync(versionDir)) return out;
  for (const f of fs.readdirSync(versionDir)) {
    const fp = path.join(versionDir, f);
    if (f.endsWith('.mp4')) out.video = out.video ?? fp;
    if (f === 'report.md') out.report = fp;
    if (f.startsWith('preview_')) out.previews.push(fp);
    if (f.startsWith('shots')) out.shots.push(fp);
  }
  return out;
}

// @kine/store — changelog.jsonl（每条改动可追溯、可回滚）
import fs from 'node:fs';
import path from 'node:path';

export interface ChangelogEntry {
  /** tx_YYYYMMDD_NNN */
  tx: string;
  ts: string;
  tool: string;
  /** 用户原话（逐字） */
  quote: string;
  /** 人读 patch 摘要，如 "scenes[title].layers[glitch].props.flash_period: 0.40 → 0.32" */
  patch: string;
  target: { path: string; id?: string; scene?: string };
  impact?: { invalidates: string[]; kept: string[] };
  preview?: string | null;
  checks?: { audit?: string; check?: string };
  rollbackOf?: string | null;
  /** 完整机器细节：ops/diffs/backup 文件，供 rollback 与 diff */
  details?: {
    ops?: unknown[];
    diffs?: unknown[];
    backupFile?: string;
    specHashBefore?: string;
    specHashAfter?: string;
    [k: string]: unknown;
  };
}

export function readChangelog(file: string): ChangelogEntry[] {
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const out: ChangelogEntry[] = [];
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s) as ChangelogEntry); } catch { /* 损坏行跳过 */ }
  }
  return out;
}

export function appendChangelog(file: string, entry: ChangelogEntry): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(entry) + '\n');
}

/** 下一个事务 id：tx_YYYYMMDD_NNN（当日递增） */
export function nextTxId(file: string, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  const day = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}`;
  const entries = readChangelog(file);
  let max = 0;
  const re = new RegExp(`^tx_${day}_(\\d+)$`);
  for (const e of entries) {
    const m = re.exec(e.tx);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `tx_${day}_${String(max + 1).padStart(3, '0')}`;
}

export function findEntry(file: string, txId: string): ChangelogEntry | undefined {
  return readChangelog(file).find((e) => e.tx === txId);
}

export function since(file: string, isoOrRelative?: string): ChangelogEntry[] {
  const all = readChangelog(file);
  if (!isoOrRelative) return all;
  // 支持 "2h" / "30m" / ISO 时间戳
  const m = /^(\d+)([hmd])$/.exec(isoOrRelative);
  if (m) {
    const ms = parseInt(m[1], 10) * (m[2] === 'h' ? 3600e3 : m[2] === 'm' ? 60e3 : 86400e3);
    const cut = Date.now() - ms;
    return all.filter((e) => Date.parse(e.ts) >= cut);
  }
  const t = Date.parse(isoOrRelative);
  if (!Number.isNaN(t)) return all.filter((e) => Date.parse(e.ts) >= t);
  return all;
}

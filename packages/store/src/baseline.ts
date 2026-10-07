// @kine/store — 基线：指标全集 + 关键帧 stateHash + 音频特征 + pace 断点，与版本一一对应
import fs from 'node:fs';
import path from 'node:path';
import { writeJsonAtomic } from './layout';
import { cmpVersion } from './versions';

export interface BaselineMetric {
  value: number | string;
  unit?: string;
  verdict?: string;
}

export interface BaselineData {
  version: string;
  ts: string;
  specHash: string;
  specHash8: string;
  metrics: Record<string, BaselineMetric>;
  keyframes: { scene: string; frame: number; stateHash: string }[];
  audio: Record<string, number | string | null>;
  paceBreaks: { frame: number; t: number; T: number }[];
  paceBreaksHash?: string;
}

export function baselineFile(baselineDir: string, version: string): string {
  return path.join(baselineDir, `${version}.json`);
}

export function saveBaseline(baselineDir: string, data: BaselineData): string {
  const file = baselineFile(baselineDir, data.version);
  writeJsonAtomic(file, data);
  return file;
}

export function loadBaseline(baselineDir: string, version: string): BaselineData | null {
  const f = baselineFile(baselineDir, version);
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')) as BaselineData; } catch { return null; }
}

export function listBaselines(baselineDir: string): string[] {
  if (!fs.existsSync(baselineDir)) return [];
  return fs.readdirSync(baselineDir)
    .filter((f) => f.endsWith('.json') && f.startsWith('v'))
    .map((f) => f.replace(/\.json$/, ''))
    .sort(cmpVersion);
}

export function latestBaseline(baselineDir: string): BaselineData | null {
  const list = listBaselines(baselineDir);
  for (let i = list.length - 1; i >= 0; i--) {
    const b = loadBaseline(baselineDir, list[i]);
    if (b) return b;
  }
  return null;
}

export interface MetricDelta {
  key: string;
  a: number | string | undefined;
  b: number | string | undefined;
  delta?: number;
  pct?: number;
  verdict: 'same' | 'changed' | 'regressed' | 'improved' | 'unknown';
}

export interface BaselineDiff {
  versionA: string;
  versionB: string;
  specHashSame: boolean;
  metrics: MetricDelta[];
  keyframes: { scene: string; frame: number; aHash: string; bHash: string; same: boolean }[];
  audio: MetricDelta[];
}

function numOrNaN(v: unknown): number {
  return typeof v === 'number' ? v : NaN;
}

function delta(a: BaselineMetric | undefined, b: BaselineMetric | undefined): MetricDelta {
  const av = a?.value;
  const bv = b?.value;
  const an = numOrNaN(av);
  const bn = numOrNaN(bv);
  if (av === undefined || bv === undefined) {
    return { key: '', a: av, b: bv, verdict: av === bv ? 'same' : 'changed' };
  }
  if (Number.isNaN(an) || Number.isNaN(bn)) {
    return { key: '', a: av, b: bv, verdict: av === bv ? 'same' : 'changed' };
  }
  const d = bn - an;
  const pct = an !== 0 ? (d / Math.abs(an)) * 100 : undefined;
  return { key: '', a: av, b: bv, delta: d, pct, verdict: d === 0 ? 'same' : 'changed' };
}

export function diffBaseline(a: BaselineData, b: BaselineData): BaselineDiff {
  const metrics: MetricDelta[] = [];
  const keys = new Set([...Object.keys(a.metrics), ...Object.keys(b.metrics)]);
  for (const k of keys) {
    const d = delta(a.metrics[k], b.metrics[k]);
    d.key = k;
    // 用当前判定改进/回归：在当前版本携带的 verdict 上迁移
    if (b.metrics[k]?.verdict === 'FAIL' && a.metrics[k]?.verdict !== 'FAIL') d.verdict = a.metrics[k]?.verdict === 'FAIL' ? 'same' : 'regressed';
    else if (b.metrics[k]?.verdict === 'PASS' && a.metrics[k]?.verdict === 'FAIL') d.verdict = 'improved';
    metrics.push(d);
  }
  const audio: MetricDelta[] = [];
  const akeys = new Set([...Object.keys(a.audio), ...Object.keys(b.audio)]);
  for (const k of akeys) {
    const av = a.audio[k];
    const bv = b.audio[k];
    audio.push({ key: k, a: av ?? undefined, b: bv ?? undefined, verdict: av === bv ? 'same' : 'changed' });
  }
  const kfA = new Map(a.keyframes.map((k) => [`${k.scene}#${k.frame}`, k.stateHash]));
  const keyframes = b.keyframes.map((k) => {
    const id = `${k.scene}#${k.frame}`;
    const ha = kfA.get(id) ?? '(无基线)';
    return { scene: k.scene, frame: k.frame, aHash: ha, bHash: k.stateHash, same: ha === k.stateHash };
  });
  return { versionA: a.version, versionB: b.version, specHashSame: a.specHash === b.specHash, metrics, keyframes, audio };
}

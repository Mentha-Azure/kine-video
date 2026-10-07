// @kine/dsl — 归一化 hash 工具（specHash = IR 归一化 hash，是缓存与回归的根键）
import { createHash } from 'node:crypto';

/** 稳定序列化：对象键排序，保证同语义文档得到同 hash */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortValue);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      const val = (v as Record<string, unknown>)[k];
      if (val !== undefined) out[k] = sortValue(val);
    }
    return out;
  }
  if (typeof v === 'number' && Number.isFinite(v)) {
    // 消除 -0 与浮点表示尾差
    const r = Math.round(v * 1e9) / 1e9;
    return Object.is(r, -0) ? 0 : r;
  }
  return v;
}

export function sha256(s: string | Buffer): string {
  return createHash('sha256').update(s).digest('hex');
}

export function hashValue(v: unknown): string {
  return sha256(canonicalJson(v));
}

export function short(hash: string, n = 8): string {
  return hash.slice(0, n);
}

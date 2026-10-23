// voices.ts — 配音音色（library kind: voice）
//
// 音色 = 参考音频 + 参考文本 + TTS 服务端点 的组合（GPT-SoVITS 零样本/微调通用）。
// 注册进库后用 `library://<ns>/<name>` 引用；默认音色记在 <kineHome>/voices.json。
//
// 两条硬约束（踩过坑）：
//   1. 参考音频必须 3–10 秒，且必须是**自然连续语音**（人工压缩停顿去凑时长会让长文本重复/拖长）；
//   2. ref_text 必须与参考音频逐字一致（含标点）。
import fs from 'node:fs';
import * as path from 'node:path';
import { kineHome } from './paths';
import { kineLibraryRoot, readLibraryIndex, type LibraryEntry } from './library';

export const VOICE_DEFAULT_MAX_PAUSE = 0.5;
export const VOICE_DEFAULT_PAUSE_TO = 0.46;
export const VOICE_PAUSE_THRESH_DB = -42;
export const VOICE_MIN_PAUSE = 0.13;

export interface VoiceData {
  /** 显示名（如「旁白」） */
  label?: string;
  /** TTS 服务端点（POST，JSON） */
  endpoint: string;
  /** 参考音频（本地路径；3–10 秒自然语音） */
  ref_audio: string;
  /** 参考文本（与参考音频逐字一致） */
  ref_text: string;
  language?: string;
  /** 默认语速（服务端 speed 参数；>1.15 长句会拖音漏词） */
  speed?: number;
  /** 记录用：模型标识（不参与请求） */
  model?: { gpt?: string; sovits?: string };
  /** 停顿归一化：超过 max_pause 的停顿压到 to 秒（null = 不做） */
  pause_cap?: { max_pause: number; to: number } | null;
  notes?: string;
}

export interface VoiceEntry {
  id: string;
  name: string;
  ns: string;
  status: string;
  data: VoiceData;
  tags: string[];
  updated: string;
}

export interface VoiceDefaults {
  default?: string;
}

export function voiceDefaultsFile(): string {
  return path.join(kineHome(), 'voices.json');
}

export function readVoiceDefaults(): VoiceDefaults {
  try {
    const raw = JSON.parse(fs.readFileSync(voiceDefaultsFile(), 'utf8')) as VoiceDefaults;
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

export function setDefaultVoice(id: string): void {
  fs.mkdirSync(path.dirname(voiceDefaultsFile()), { recursive: true });
  const tmp = `${voiceDefaultsFile()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ default: id }, null, 2), 'utf8');
  fs.renameSync(tmp, voiceDefaultsFile());
}

/** 列出库里的音色（status=library 优先，draft 也一并返回并标注） */
export function listVoices(root = kineLibraryRoot()): VoiceEntry[] {
  const idx = readLibraryIndex(root);
  const out: VoiceEntry[] = [];
  for (const e of Object.values(idx.entries) as LibraryEntry[]) {
    if (e.kind !== 'voice' || !e.data || typeof e.data !== 'object') continue;
    out.push({
      id: e.id,
      name: e.name,
      ns: e.ns,
      status: e.status,
      data: e.data as VoiceData,
      tags: e.tags ?? [],
      updated: e.updated,
    });
  }
  out.sort((a, b) => (a.status === b.status ? a.id.localeCompare(b.id) : a.status === 'library' ? -1 : 1));
  return out;
}

/** 解析音色：接受 name / id / library://id / @tag / 空（取默认） */
export function resolveVoice(ref: string | undefined, root = kineLibraryRoot()): VoiceEntry | null {
  const all = listVoices(root);
  if (all.length === 0) return null;
  const pick = (id: string | undefined) => {
    if (!id) return null;
    const bare = id.replace(/^library:\/\//, '').replace(/^@/, '');
    return (
      all.find((v) => v.id === bare) ??
      all.find((v) => v.name === bare) ??
      all.find((v) => v.tags.includes(bare)) ??
      null
    );
  };
  if (ref && ref.trim()) {
    const hit = pick(ref.trim());
    if (hit) return hit;
    // 显式给了但没找到：不静默回落
    return null;
  }
  const d = readVoiceDefaults().default;
  return pick(d) ?? all[0];
}

/** 默认音色 id（无登记时取第一个 library 状态的音色） */
export function defaultVoiceId(root = kineLibraryRoot()): string | null {
  const v = resolveVoice(undefined, root);
  if (!v) return null;
  return readVoiceDefaults().default && listVoices(root).some((x) => x.id === readVoiceDefaults().default)
    ? (readVoiceDefaults().default as string)
    : v.id;
}

// ---------------------------------------------------------------- WAV IO（16-bit PCM）

export interface WavPcm {
  samples: Float32Array;
  sr: number;
  channels: number;
  bits: number;
}

function findChunk(buf: Buffer, id: string, from = 12): { start: number; size: number } | null {
  let p = from;
  while (p + 8 <= buf.length) {
    const cid = buf.toString('ascii', p, p + 4);
    const size = buf.readUInt32LE(p + 4);
    if (cid === id) return { start: p + 8, size };
    p += 8 + size + (size % 2);
  }
  return null;
}

/** 读 WAV（支持 16-bit PCM；多声道下混单声道） */
export function readWavPcm16(buf: Buffer): WavPcm {
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是 WAV 数据');
  }
  const fmt = findChunk(buf, 'fmt ');
  const dat = findChunk(buf, 'data');
  if (!fmt || !dat) throw new Error('WAV 缺 fmt/data 块');
  const channels = buf.readUInt16LE(fmt.start + 2);
  const sr = buf.readUInt32LE(fmt.start + 4);
  const bits = buf.readUInt16LE(fmt.start + 14);
  if (bits !== 16) throw new Error(`仅支持 16-bit PCM（实际 ${bits}-bit）`);
  const n = Math.floor(dat.size / 2 / channels);
  const samples = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) acc += buf.readInt16LE(dat.start + (i * channels + c) * 2);
    samples[i] = acc / channels / 32768;
  }
  return { samples, sr, channels, bits };
}

/** 写 16-bit 单声道 WAV */
export function writeWavPcm16(file: string, samples: Float32Array, sr: number): void {
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0, 'ascii');
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write('WAVE', 8, 'ascii');
  buf.write('fmt ', 12, 'ascii');
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36, 'ascii');
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
}

// ---------------------------------------------------------------- 停顿结构

export interface PauseStats {
  count: number;
  total: number;
  longest: number;
  list: number[];
}

/** 静音段识别（10ms 窗口 RMS 阈值），返回样本区间 */
export function silenceRuns(samples: Float32Array, sr: number, threshDb = VOICE_PAUSE_THRESH_DB, minPause = VOICE_MIN_PAUSE): Array<[number, number]> {
  const win = Math.max(1, Math.round(0.01 * sr));
  const m = Math.floor(samples.length / win);
  const thr = 10 ** (threshDb / 20);
  const runs: Array<[number, number]> = [];
  let i = 0;
  while (i < m) {
    let rms = 0;
    for (let k = 0; k < win; k++) rms += samples[i * win + k] ** 2;
    rms = Math.sqrt(rms / win);
    if (rms < thr) {
      let j = i;
      while (j + 1 < m) {
        let r2 = 0;
        for (let k = 0; k < win; k++) r2 += samples[(j + 1) * win + k] ** 2;
        if (Math.sqrt(r2 / win) >= thr) break;
        j++;
      }
      if ((j - i + 1) * win / sr >= minPause) runs.push([i * win, (j + 1) * win]);
      i = j + 1;
    } else {
      i++;
    }
  }
  return runs;
}

export function pauseStats(samples: Float32Array, sr: number): PauseStats {
  const list = silenceRuns(samples, sr).map(([a, b]) => (b - a) / sr);
  return {
    count: list.length,
    total: list.reduce((s, x) => s + x, 0),
    longest: list.length ? Math.max(...list) : 0,
    list: list.map((x) => Math.round(x * 100) / 100),
  };
}

/**
 * 停顿归一化：把长于 max_pause 的停顿从中间挖掉、压到 to 秒（只动信号静音，不动语音采样）。
 * 用途：TTS 片段间的固定间隔 + 模型自生成静音会让停顿忽长忽短，听起来"不齐、不自然"。
 */
export function normalizePauses(
  samples: Float32Array,
  sr: number,
  opts: { max_pause?: number; to?: number } = {},
): { samples: Float32Array; before: PauseStats; after: PauseStats } {
  const maxPause = opts.max_pause ?? VOICE_DEFAULT_MAX_PAUSE;
  const to = opts.to ?? VOICE_DEFAULT_PAUSE_TO;
  const before = pauseStats(samples, sr);
  const runs = silenceRuns(samples, sr, VOICE_PAUSE_THRESH_DB, maxPause);
  if (runs.length === 0) return { samples, before, after: before };
  const keep: Array<[number, number]> = [];
  let cursor = 0;
  for (const [a, b] of runs) {
    const cut = Math.round((((b - a) / sr) - to) * sr);
    const mid = a + Math.floor((b - a + 1) / 2);
    keep.push([cursor, mid - Math.floor(cut / 2)]);
    cursor = mid + cut - Math.floor(cut / 2);
  }
  keep.push([cursor, samples.length]);
  const total = keep.reduce((s, [a, b]) => s + Math.max(0, b - a), 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const [a, b] of keep) {
    if (b <= a) continue;
    out.set(samples.subarray(a, b), o);
    o += b - a;
  }
  return { samples: out.subarray(0, o).slice(), before, after: pauseStats(out.subarray(0, o), sr) };
}

/** 峰值电平（dBFS） */
export function peakDb(samples: Float32Array): number {
  let p = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = Math.abs(samples[i]);
    if (v > p) p = v;
  }
  return p > 0 ? 20 * Math.log10(p) : -Infinity;
}

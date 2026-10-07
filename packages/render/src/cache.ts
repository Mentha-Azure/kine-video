// @kine/render — 缓存键与产物路径（规格文档04 §4.5：所有缓存键含 specHash）
import { existsSync, mkdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { hashValue, short } from '@kine/dsl/hash';
import type { EncoderProfile } from './ffmpeg';
import type { ChunkRange } from './chunks';
import { chunkFileName } from './chunks';

export function profileKey(p: EncoderProfile): string {
  return `${p.codec}-crf${p.crf}-${p.preset}-${p.pixFmt}-${p.fr}`;
}

/** chunkKey = sha256(visualHash, frameRange, encoderProfile, surface)（规格文档04 §4.5；visualHash=帧内容根键，音频/断言改动不失效） */
export function chunkKey(visualHash: string, range: { f0: number; f1: number }, profile: EncoderProfile, surface = 'canvas'): string {
  return hashValue({ specHash: visualHash, f0: range.f0, f1: range.f1, profile: profileKey(profile), surface });
}

export interface ChunkCacheHit {
  hit: boolean;
  file?: string;
  key: string;
  key8: string;
}

/** 查找分片缓存：workDir/chunk/ 下文件名含 key8 且尺寸>0 即命中 */
export function lookupChunk(workDir: string, visualHash: string, range: ChunkRange, profile: EncoderProfile, surface = 'canvas'): ChunkCacheHit {
  const key = chunkKey(visualHash, range, profile, surface);
  const key8 = short(key, 8);
  const dir = path.join(workDir, 'chunk');
  const file = path.join(dir, chunkFileName(range.index, range.f0, range.f1, key8));
  if (existsSync(file)) {
    try {
      const st = statSync(file);
      if (st.size > 0) return { hit: true, file, key, key8 };
    } catch {
      /* 视为未命中 */
    }
  }
  return { hit: false, key, key8 };
}

export function chunkCachePath(workDir: string, range: ChunkRange, key8: string): string {
  const dir = path.join(workDir, 'chunk');
  mkdirSync(dir, { recursive: true });
  return path.join(dir, chunkFileName(range.index, range.f0, range.f1, key8));
}

/** 原子写（临时文件 + rename，规格文档08 §8.3） */
export function atomicWriteFile(file: string, data: Buffer | string): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}`;
  writeFileSync(tmp, data);
  try {
    renameSync(tmp, file);
  } catch (e) {
    try {
      unlinkSync(tmp);
    } catch {
      /* noop */
    }
    throw e;
  }
}

export function ensureDir(dir: string): string {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 帧 PNG 调试输出路径（规格文档04 §4.4，可关） */
export function framePngPath(workDir: string, sceneId: string, frameNo: number): string {
  return path.join(workDir, 'frames', sceneId, `${String(frameNo).padStart(6, '0')}.png`);
}

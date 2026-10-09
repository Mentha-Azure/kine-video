// @kine/render — 渲染编排：worker 池、抓帧、编码、缓存、拼接、合流（规格文档04）
import { existsSync, statfsSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { pointAtFrame, type KineIR } from '@kine/dsl';
import { short } from '@kine/dsl/hash';
import {
  concatArgs,
  buildConcatList,
  ffmpegExec,
  muxArgs,
  remuxArgs,
  startChunkEncoder,
  type EncoderProfile,
} from './ffmpeg';
import { atomicWriteFile, chunkCachePath, clearChunkOk, ensureDir, framePngPath, lookupChunk, writeChunkOk } from './cache';
import type { ChunkRange } from './chunks';
import { planChunks } from './chunks';
import { openSession, sleep, staggerDelay, withTimeout, type KineSession } from './browser';

// ---------------------------------------------------------------- 选项与产物

export interface RenderCommonOptions {
  projectDir: string;
  workDir: string;
  width: number;
  height: number;
  fps: number;
  profile: EncoderProfile;
  noCache?: boolean;
  keepFrames?: boolean;
  onProgress?: (ev: RenderProgress) => void;
}

export interface RenderProjectOptions extends RenderCommonOptions {
  outDir: string;
  version: string;
  workers?: number;
  /** 提供则渲染完成后合流（音频 wav） */
  audioFile?: string | null;
}

export interface ChunkArtifact {
  index: number;
  f0: number;
  f1: number;
  file: string;
  key: string;
  cached: boolean;
  frames: number;
  ms: number;
}

export interface RenderResult {
  chunks: ChunkArtifact[];
  videoFile: string;
  finalFile: string | null;
  framesTotal: number;
  framesRendered: number;
  framesCached: number;
  elapsedMs: number;
}

export type RenderProgress =
  | { phase: 'chunk-start'; chunk: { index: number; f0: number; f1: number }; worker: number }
  | { phase: 'frame'; chunk: { index: number; f0: number; f1: number }; frame: number; done: number; total: number; fps: number }
  | { phase: 'chunk-done'; chunk: { index: number; f0: number; f1: number }; ms: number; cached: boolean }
  | { phase: 'concat'; chunks: number }
  | { phase: 'mux'; audio: string }
  | { phase: 'done'; framesRendered: number; framesCached: number; elapsedMs: number };

/** 从 IR 生成渲染默认选项（workDir = .kine/work/<visualHash8> —— 音频/断言改动不失效帧缓存）
 *  v4：KINE_WORK_DIR 可重定向工作目录（防 C 盘写满；指向其他盘如 D:\kine-work）。 */
export function renderDefaults(ir: KineIR, projectDir: string): RenderCommonOptions {
  const override = process.env.KINE_WORK_DIR?.trim();
  const base = override ? override : path.join(projectDir, '.kine', 'work');
  return {
    projectDir,
    workDir: path.join(base, short(ir.hashes.visualHash, 8)),
    width: ir.output.width,
    height: ir.output.height,
    fps: ir.output.fps,
    profile: {
      codec: 'libx264',
      crf: ir.output.video.crf,
      preset: ir.output.video.preset,
      pixFmt: 'yuv420p',
      fr: ir.output.fps,
    },
  };
}

/** v4：磁盘剩余空间守卫（反馈：写 C 盘，当剩 4.3GB 时渲染脆弱）。<1GB 拒绝，附清理/重定向建议。 */
export function checkFreeDisk(dir: string): { freeBytes: number } {
  try {
    const s = statfsSync(dir);
    const free = Number(s.bavail) * Number(s.bsize);
    if (free < 1024 ** 3) {
      const err = new Error(
        `磁盘剩余空间不足 1GB（当前 ${(free / 1024 ** 3).toFixed(2)}GB）——渲染中止以免写坏缓存`,
      ) as Error & { code: string; hints: string[] };
      err.code = 'E-RENDER-007';
      err.hints = [
        '清理旧工作目录：kine cache gc（或手动删 .kine/work 下过期 hash 目录）',
        '重定向工作目录到其他盘：设置环境变量 KINE_WORK_DIR=D:\\kine-work（v4）',
      ];
      throw err;
    }
    return { freeBytes: free };
  } catch (e) {
    if (e && typeof e === 'object' && (e as { code?: string }).code === 'E-RENDER-007') throw e;
    return { freeBytes: -1 }; // 探测失败（目录尚未创建等）→ 放行
  }
}

export class RenderFrameError extends Error {
  code = 'E-RENDER-003';
  frame: number;
  T: number;
  scene: string | undefined;
  hints: string[];
  constructor(frame: number, T: number, scene: string | undefined, cause: unknown) {
    super(
      `E-RENDER-003 第 ${frame} 帧渲染失败（T=${T.toFixed(3)}s，幕=${scene ?? '?'}）：` +
        `${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.frame = frame;
    this.T = T;
    this.scene = scene;
    this.hints = [`重试：kine render --range ${(frame / 60).toFixed(1)}:${((frame + 30) / 60).toFixed(1)}`, '缩小范围定位问题帧'];
  }
}

// ---------------------------------------------------------------- 单帧抓取

const FRAME_TIMEOUT_MS = 3000;
const FRAME_RETRIES = 2; // 首次 + 2 次重试（规格文档04 §4.6）

async function shootWithRetry(
  session: KineSession,
  T: number,
  frameNo: number,
  scene: string | undefined,
  firstFrame: boolean,
): Promise<Buffer> {
  let last: unknown = null;
  for (let attempt = 0; attempt <= FRAME_RETRIES; attempt++) {
    try {
      return await withTimeout(session.shoot(T, { firstFrame }), FRAME_TIMEOUT_MS, `frame ${frameNo}`);
    } catch (e) {
      last = e;
      if (attempt < FRAME_RETRIES) await sleep(120);
    }
  }
  throw new RenderFrameError(frameNo, T, scene, last);
}

// ---------------------------------------------------------------- 单分片抓帧

async function captureChunk(
  session: KineSession,
  ir: KineIR,
  range: ChunkRange,
  key8: string,
  opts: RenderCommonOptions,
  worker: number,
): Promise<ChunkArtifact> {
  const t0ms = Date.now();
  const outFile = chunkCachePath(opts.workDir, range, key8);
  checkFreeDisk(opts.workDir); // v4：磁盘守卫（<1GB → E-RENDER-007）
  clearChunkOk(outFile); // v4：重写分片前先作废旧完整性凭据（防旧 .ok 匹配到新文件）
  const encoder = startChunkEncoder(opts.profile, outFile);
  const map = ir.time.map;
  const total = range.f1 - range.f0;
  let done = 0;
  let lastEmit = 0;
  try {
    for (let f = range.f0; f < range.f1; f++) {
      const pt = pointAtFrame(map, f);
      const firstFrame = f === 0;
      const buf = await shootWithRetry(session, pt.T, f, pt.scene, firstFrame);
      if (opts.keepFrames) {
        const sceneId = pt.scene ?? 'unknown';
        atomicWriteFile(framePngPath(opts.workDir, sceneId, f), buf);
      }
      await encoder.writeFrame(buf);
      done++;
      const now = Date.now();
      if (opts.onProgress && (now - lastEmit > 250 || done === total)) {
        lastEmit = now;
        const elapsed = Math.max(1, now - t0ms) / 1000;
        opts.onProgress({
          phase: 'frame',
          chunk: { index: range.index, f0: range.f0, f1: range.f1 },
          frame: f,
          done,
          total,
          fps: done / elapsed,
        });
      }
    }
    await encoder.finish();
  } catch (e) {
    encoder.kill();
    throw e;
  }
  const st = statSync(outFile);
  if (st.size <= 0) throw new RenderFrameError(range.f0, 0, undefined, new Error(`分片产物为空: ${outFile}`));
  writeChunkOk(outFile, key8); // v4：size 校验通过才写完整性凭据（截断块不再被误判命中）
  return {
    index: range.index,
    f0: range.f0,
    f1: range.f1,
    file: outFile,
    key: key8,
    cached: false,
    frames: total,
    ms: Date.now() - t0ms,
  };
}

// ---------------------------------------------------------------- 单 range 渲染（预览/范围）

export interface RangeRenderOptions extends RenderCommonOptions {
  outDir?: string;
  /** 仅供测试/低配：限制单次范围渲染帧数 */
  maxFrames?: number;
}

/** 渲染任意帧范围 [f0,f1) 为单个 .ts 分片（缓存键含范围）。规格文档10：renderRange 公共 API */
export async function renderRange(
  ir: KineIR,
  range: { f0: number; f1: number },
  opts: RangeRenderOptions,
): Promise<ChunkArtifact> {
  const frames = ir.time.map.frames;
  const f0 = Math.max(0, Math.floor(range.f0));
  const f1 = Math.min(frames, Math.floor(range.f1));
  if (f1 <= f0) throw new Error(`渲染范围为空：${f0}..${f1}（总帧数 ${frames}）`);
  const total = opts.maxFrames ? Math.min(opts.maxFrames, f1 - f0) : f1 - f0;
  const ranged: ChunkRange = { index: 0, f0, f1: f0 + total };
  const cacheLookup = lookupChunk(opts.workDir, ir.hashes.visualHash, ranged, opts.profile);
  if (!opts.noCache && cacheLookup.hit && cacheLookup.file) {
    const art: ChunkArtifact = {
      index: 0, f0: ranged.f0, f1: ranged.f1, file: cacheLookup.file, key: cacheLookup.key8, cached: true, frames: total, ms: 0,
    };
    opts.onProgress?.({ phase: 'chunk-done', chunk: { index: 0, f0: ranged.f0, f1: ranged.f1 }, ms: 0, cached: true });
    opts.onProgress?.({ phase: 'done', framesRendered: 0, framesCached: total, elapsedMs: 0 });
    return art;
  }
  ensureDir(opts.workDir);
  const session = await openSession({
    width: opts.width,
    height: opts.height,
    userDataDir: path.join(opts.workDir, 'browser', 'range'),
  });
  try {
    await session.load(ir);
    const warmA = pointAtFrame(ir.time.map, Math.min(6, frames - 1)).T;
    const warmB = pointAtFrame(ir.time.map, f0).T;
    await session.warmup([warmA, warmB]);
    const key8 = cacheLookup.key8;
    opts.onProgress?.({ phase: 'chunk-start', chunk: { index: 0, f0: ranged.f0, f1: ranged.f1 }, worker: 0 });
    const art = await captureChunk(session, ir, ranged, key8, opts, 0);
    opts.onProgress?.({ phase: 'chunk-done', chunk: { index: 0, f0: ranged.f0, f1: ranged.f1 }, ms: art.ms, cached: false });
    opts.onProgress?.({ phase: 'done', framesRendered: art.frames, framesCached: 0, elapsedMs: art.ms });
    return art;
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------- 全片编排

export async function renderProject(ir: KineIR, opts: RenderProjectOptions): Promise<RenderResult> {
  const t0 = Date.now();
  const frames = ir.time.map.frames;
  const workers = Math.max(1, Math.min(opts.workers ?? ir.render.workers ?? 4, 8));
  const ranges = planChunks(ir, { workers });
  const results = new Map<number, ChunkArtifact>();
  const errors: Error[] = [];
  const queue: ChunkRange[] = [...ranges];
  let framesRendered = 0;
  let framesCached = 0;

  ensureDir(opts.workDir);
  ensureDir(opts.outDir);

  const workerLoop = async (workerId: number) => {
    await sleep(staggerDelay(workerId));
    const st: { session: KineSession | null } = { session: null };
    const openIt = async () => {
      st.session = await openSession({
        width: opts.width,
        height: opts.height,
        userDataDir: path.join(opts.workDir, 'browser', `w${workerId}`),
      });
      await st.session.load(ir);
      await st.session.warmup([pointAtFrame(ir.time.map, Math.min(6, frames - 1)).T, pointAtFrame(ir.time.map, 0).T]);
    };
    try {
      await openIt();
      for (;;) {
        const range = queue.shift();
        if (!range) break;
        const cacheLookup = lookupChunk(opts.workDir, ir.hashes.visualHash, range, opts.profile);
        if (!opts.noCache && cacheLookup.hit && cacheLookup.file) {
          results.set(range.index, {
            index: range.index, f0: range.f0, f1: range.f1, file: cacheLookup.file, key: cacheLookup.key8,
            cached: true, frames: range.f1 - range.f0, ms: 0,
          });
          framesCached += range.f1 - range.f0;
          opts.onProgress?.({ phase: 'chunk-done', chunk: { index: range.index, f0: range.f0, f1: range.f1 }, ms: 0, cached: true });
          continue;
        }
        opts.onProgress?.({ phase: 'chunk-start', chunk: { index: range.index, f0: range.f0, f1: range.f1 }, worker: workerId });
        try {
          const art = await captureChunk(st.session!, ir, range, cacheLookup.key8, opts, workerId);
          results.set(range.index, art);
          framesRendered += art.frames;
          opts.onProgress?.({ phase: 'chunk-done', chunk: { index: range.index, f0: range.f0, f1: range.f1 }, ms: art.ms, cached: false });
        } catch (e1) {
          // 分片失败：重开 worker 会话后只重抓该片（规格文档04 §4.6）
          try {
            await st.session?.close();
          } catch {
            /* noop */
          }
          try {
            await openIt();
            const art = await captureChunk(st.session!, ir, range, cacheLookup.key8, opts, workerId);
            results.set(range.index, art);
            framesRendered += art.frames;
            opts.onProgress?.({ phase: 'chunk-done', chunk: { index: range.index, f0: range.f0, f1: range.f1 }, ms: art.ms, cached: false });
          } catch (e2) {
            errors.push(e2 instanceof Error ? e2 : new Error(String(e2)));
            void e1;
          }
        }
      }
    } catch (e) {
      errors.push(e instanceof Error ? e : new Error(String(e)));
    } finally {
      try {
        await st.session?.close();
      } catch {
        /* noop */
      }
    }
  };

  await Promise.all(Array.from({ length: workers }, (_, i) => workerLoop(i)));
  if (errors.length > 0 || results.size !== ranges.length) {
    const missing = ranges.filter((r) => !results.has(r.index)).map((r) => `${r.index}[${r.f0},${r.f1})`);
    throw new Error(
      `渲染未完成：失败分片 ${missing.join(', ') || errors.length + ' 个'}。\n` +
        errors.map((e) => `- ${e.message}`).join('\n'),
    );
  }

  const chunks = [...results.values()].sort((a, b) => a.f0 - b.f0);
  opts.onProgress?.({ phase: 'concat', chunks: chunks.length });
  // 版本目录规格（文档08 §8.1/8.6）：out/<version>/{video.mp4,<version>.mp4}
  const versionDir = path.join(opts.outDir, opts.version);
  ensureDir(versionDir);
  const videoFile = path.join(versionDir, 'video.mp4');
  await concatChunks(chunks, videoFile, opts);

  let finalFile: string | null = null;
  if (opts.audioFile) {
    opts.onProgress?.({ phase: 'mux', audio: opts.audioFile });
    finalFile = path.join(versionDir, `${opts.version}.mp4`);
    const r = await ffmpegExec(muxArgs(videoFile, opts.audioFile, finalFile, ir.output.audio.bitrate));
    if (r.code !== 0) throw new Error(`合流失败：${r.stderr.slice(-800)}`);
  }

  const elapsedMs = Date.now() - t0;
  opts.onProgress?.({ phase: 'done', framesRendered, framesCached, elapsedMs });
  return { chunks, videoFile, finalFile, framesTotal: frames, framesRendered, framesCached, elapsedMs };
}

/** 拼接分片 → video.mp4；concat 只写文件名 + 列表放分片目录内（ffmpeg 相对路径以列表文件目录为基准；防 Win32 D:/D:/，规格文档09 §8.6） */
export async function concatChunks(chunks: ChunkArtifact[], outFile: string, opts: { workDir?: string } = {}): Promise<void> {
  if (chunks.length === 0) throw new Error('无分片可拼接');
  // 列表必须与分片同目录：ffmpeg concat demuxer 相对路径以列表文件目录为基准（防 Win32 D:/D:/，规格文档09 §8.6）
  const dir = path.dirname(chunks[0]!.file);
  const listFile = path.join(dir, `${path.basename(outFile, '.mp4')}.concat.txt`);
  ensureDir(path.dirname(outFile));
  atomicWriteFile(listFile, buildConcatList(chunks.map((c) => path.basename(c.file))));
  const r = await ffmpegExec(concatArgs(listFile, outFile), { cwd: dir });
  if (r.code !== 0) throw new Error(`拼接失败：${r.stderr.slice(-800)}`);
  if (!existsSync(outFile) || statSync(outFile).size <= 0) throw new Error(`拼接产物异常：${outFile}`);
}

/** 画面 + 音频合流（规格文档10 公共 API） */
export async function concatMux(
  chunks: ChunkArtifact[],
  opts: { workDir: string; outDir: string; version: string; audioFile?: string | null; bitrate?: string },
): Promise<{ videoFile: string; finalFile: string | null }> {
  // 版本目录规格（文档08 §8.1/8.6）：out/<version>/{video.mp4,<version>.mp4}
  const versionDir = path.join(opts.outDir, opts.version);
  ensureDir(versionDir);
  const videoFile = path.join(versionDir, 'video.mp4');
  await concatChunks(chunks, videoFile, { workDir: opts.workDir });
  let finalFile: string | null = null;
  if (opts.audioFile) {
    finalFile = path.join(versionDir, `${opts.version}.mp4`);
    const r = await ffmpegExec(muxArgs(videoFile, opts.audioFile, finalFile, opts.bitrate));
    if (r.code !== 0) throw new Error(`合流失败：${r.stderr.slice(-800)}`);
  }
  return { videoFile, finalFile };
}

// ---------------------------------------------------------------- 画面导出（抽检/预览）

export interface PreviewOptions extends RenderCommonOptions {
  outDir: string;
  t0: number;
  dur: number;
  audioFile?: string | null;
  version?: string;
  onProgress?: (ev: RenderProgress) => void;
}

/** 成品形态短预览：渲染范围 → 重封装 mp4 → 可选合流音频段（规格文档05 §5.9） */
export async function renderPreview(ir: KineIR, opts: PreviewOptions): Promise<{ file: string; artifact: ChunkArtifact }> {
  const fps = ir.output.fps;
  const f0 = Math.round(opts.t0 * fps);
  const f1 = Math.min(ir.time.map.frames, Math.round((opts.t0 + opts.dur) * fps));
  const artifact = await renderRange(ir, { f0, f1 }, opts);
  ensureDir(opts.outDir);
  const hash8 = short(ir.specHash, 8);
  const base = `preview_${opts.t0.toFixed(2)}s_${(opts.dur).toFixed(2)}s_${hash8}`;
  const mp4 = path.join(opts.outDir, `${base}.mp4`);
  if (opts.audioFile && existsSync(opts.audioFile)) {
    const segWav = path.join(opts.workDir, `${base}.audio.wav`);
    ensureDir(opts.workDir);
    const r1 = await ffmpegExec([
      '-hide_banner', '-loglevel', 'error', '-y',
      '-ss', (f0 / fps).toFixed(4), '-t', ((f1 - f0) / fps).toFixed(4),
      '-i', opts.audioFile, '-c:a', 'pcm_s16le', '-ar', '48000', segWav,
    ]);
    if (r1.code !== 0) throw new Error(`预览音频切片失败：${r1.stderr.slice(-500)}`);
    const r2 = await ffmpegExec(muxArgs(artifact.file, segWav, mp4, ir.output.audio.bitrate));
    if (r2.code !== 0) throw new Error(`预览合流失败：${r2.stderr.slice(-500)}`);
  } else {
    const r = await ffmpegExec(remuxArgs(artifact.file, mp4));
    if (r.code !== 0) throw new Error(`预览重封装失败：${r.stderr.slice(-500)}`);
  }
  return { file: mp4, artifact };
}

export interface ShotCapture {
  frame: number;
  file: string;
}

/** 抓取任意帧号的高质量 PNG（抽检/接缝图用），独立 capture 路径（规格文档04 §4.2） */
export async function capturePngs(
  ir: KineIR,
  frames: number[],
  opts: RenderCommonOptions & { outDir: string; prefix?: string },
): Promise<ShotCapture[]> {
  ensureDir(opts.outDir);
  const session = await openSession({
    width: opts.width,
    height: opts.height,
    userDataDir: path.join(opts.workDir, 'browser', 'shots'),
  });
  const out: ShotCapture[] = [];
  try {
    await session.load(ir);
    await session.warmup([pointAtFrame(ir.time.map, Math.min(6, ir.time.map.frames - 1)).T, pointAtFrame(ir.time.map, frames[0] ?? 0).T]);
    for (const f of frames) {
      const ff = Math.max(0, Math.min(ir.time.map.frames - 1, Math.floor(f)));
      const pt = pointAtFrame(ir.time.map, ff);
      const buf = await session.shoot(pt.T, { firstFrame: ff === 0 });
      const file = path.join(opts.outDir, `${opts.prefix ?? 'shot'}_${String(ff).padStart(6, '0')}.png`);
      atomicWriteFile(file, buf);
      out.push({ frame: ff, file });
    }
  } finally {
    await session.close();
  }
  return out;
}

/** 打开一个渲染会话用于 probe / audit 运行时扫描（调用方负责 close） */
export async function openRenderSession(
  ir: KineIR,
  opts: RenderCommonOptions & { tag?: string },
): Promise<KineSession> {
  const session = await openSession({
    width: opts.width,
    height: opts.height,
    userDataDir: path.join(opts.workDir, 'browser', opts.tag ?? 'session'),
  });
  await session.load(ir);
  return session;
}

// @kine/render — ffmpeg 封装：所有 ffmpeg 命令一律由本文件生成（规格文档04/§4.4）
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';

export interface FfmpegInfo {
  path: string;
  version: string;
  source: 'env' | 'kine-bin' | 'path' | 'common';
}

let cached: FfmpegInfo | null = null;

/** 发现顺序：KINE_FFMPEG → ~/.local/share/kine/bin → PATH → 常见安装位置（规格文档02 §2.5） */
export function findFfmpeg(opts: { refresh?: boolean } = {}): FfmpegInfo {
  if (cached && !opts.refresh) return cached;
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const candidates: Array<{ p: string; source: FfmpegInfo['source'] }> = [];
  if (process.env.KINE_FFMPEG) candidates.push({ p: process.env.KINE_FFMPEG, source: 'env' });
  candidates.push({ p: path.join(homedir(), '.local', 'share', 'kine', 'bin', exe), source: 'kine-bin' });
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (dir) candidates.push({ p: path.join(dir, exe), source: 'path' });
  }
  for (const p of [
    'C:/ffmpeg/bin/ffmpeg.exe',
    'C:/Program Files/ffmpeg/bin/ffmpeg.exe',
    path.join(homedir(), 'scoop', 'shims', 'ffmpeg.exe'),
  ]) {
    candidates.push({ p, source: 'common' });
  }
  const tried: string[] = [];
  for (const c of candidates) {
    if (!c.p || tried.includes(c.p)) continue;
    tried.push(c.p);
    if (!existsSync(c.p)) continue;
    const r = spawnSync(c.p, ['-version'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
    if (r.status === 0) {
      const version = (r.stdout ?? '').split('\n')[0]?.trim() ?? '';
      cached = { path: c.p, version, source: c.source };
      return cached;
    }
  }
  throw new Error(
    `找不到可用的 ffmpeg。已尝试：${tried.slice(0, 6).join('; ')}…\n` +
      `请设置环境变量 KINE_FFMPEG 指向 ffmpeg.exe，或安装 ffmpeg 后重试。`,
  );
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 同步运行 ffmpeg（短命令用） */
export function ffmpegRun(args: string[], opts: { cwd?: string; timeoutMs?: number } = {}): RunResult {
  const info = findFfmpeg();
  const r = spawnSync(info.path, args, {
    encoding: 'utf8',
    windowsHide: true,
    cwd: opts.cwd,
    timeout: opts.timeoutMs ?? 600_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { code: r.status ?? -1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** 异步运行 ffmpeg，返回 stdout/stderr（长命令用） */
export function ffmpegExec(args: string[], opts: { cwd?: string } = {}): Promise<RunResult> {
  const info = findFfmpeg();
  return new Promise((resolve, reject) => {
    const child = spawn(info.path, args, { windowsHide: true, cwd: opts.cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

// ---------------------------------------------------------------- 命令生成器

export interface EncoderProfile {
  codec: 'libx264';
  crf: number;
  preset: string;
  pixFmt: 'yuv420p';
  fr: number;
}

/** 分片编码：PNG 序列（image2pipe）→ mpegts（规格文档04 §4.4） */
export function chunkEncodeArgs(p: EncoderProfile, outFile: string): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'image2pipe',
    '-framerate', String(p.fr),
    '-i', 'pipe:0',
    '-an',
    '-c:v', p.codec,
    '-crf', String(p.crf),
    '-preset', p.preset,
    '-pix_fmt', p.pixFmt,
    '-f', 'mpegts',
    outFile,
  ];
}

/** concat 只写文件名，cwd=分片目录（防 Win32 `D:/D:/` 与中文路径转义，规格文档09 §8.6） */
export function buildConcatList(files: string[]): string {
  return files.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n') + '\n';
}

/** 分片合并（concat demuxer + cwd=分片目录） */
export function concatArgs(listFile: string, outFile: string): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', listFile, '-c', 'copy', outFile];
}

/** mpegts → mp4（范围渲染/预览用，无损重封装） */
export function remuxArgs(inFile: string, outFile: string): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-y', '-i', inFile, '-c', 'copy', '-movflags', '+faststart', outFile];
}

/** 画面 + 音频合流（规格文档04 §4.4：-map 0:v:0 -map 1:a:0；音频转 aac） */
export function muxArgs(videoFile: string, audioFile: string, outFile: string, audioBitrate = '192k'): string[] {
  return [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', videoFile,
    '-i', audioFile,
    '-map', '0:v:0', '-map', '1:a:0',
    '-c:v', 'copy',
    '-c:a', 'aac', '-b:a', audioBitrate, '-ar', '48000',
    '-movflags', '+faststart',
    outFile,
  ];
}

/** 音频格式转换（wav → 目标采样率/声道），kine-py 输出规范化 */
export function audioConvertArgs(inFile: string, outFile: string, fr: number, channels = 2): string[] {
  return ['-hide_banner', '-loglevel', 'error', '-y', '-i', inFile, '-ar', String(fr), '-ac', String(channels), outFile];
}

// ---------------------------------------------------------------- 流式编码

export interface ChunkEncoder {
  /** 写入一帧 PNG */
  writeFrame(buf: Buffer): Promise<void>;
  /** 关闭输入并等待编码完成 */
  finish(): Promise<void>;
  /** 出错时终止 */
  kill(): void;
  stderrTail(): string;
}

/** 启动一个分片编码器；调用 writeFrame 逐帧喂 PNG，最后 finish() */
export function startChunkEncoder(p: EncoderProfile, outFile: string): ChunkEncoder {
  const info = findFfmpeg();
  const child: ChildProcess = spawn(info.path, chunkEncodeArgs(p, outFile), {
    windowsHide: true,
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  const stdin = child.stdin!;
  let stderr = '';
  child.stderr!.on('data', (d: Buffer) => {
    stderr += d.toString('utf8');
    if (stderr.length > 16_384) stderr = stderr.slice(-8192);
  });
  let failed: Error | null = null;
  child.on('error', (e) => (failed = failed ?? e));
  // v5：磁盘写满/管道破裂时 stdin 会 emit EPIPE——必须吞掉为 failed，避免宿主（MCP）进程未处理异常整体崩溃
  stdin.on('error', (e) => (failed = failed ?? (e as Error)));

  const writeFrame = (buf: Buffer) =>
    new Promise<void>((resolve, reject) => {
      if (failed) return reject(failed);
      const ok = stdin.write(buf, (err) => {
        if (err) reject(err);
      });
      if (ok) return resolve();
      stdin.once('drain', () => resolve());
    });

  const finish = () =>
    new Promise<void>((resolve, reject) => {
      if (failed) return reject(failed);
      stdin.end(() => undefined);
      child.once('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg 分片编码失败 (exit ${code})\n${stderr.slice(-2000)}`));
      });
    });

  const kill = () => {
    try {
      stdin.destroy();
    } catch {
      /* noop */
    }
    try {
      child.kill('SIGKILL');
    } catch {
      /* noop */
    }
  };

  return { writeFrame, finish, kill, stderrTail: () => stderr };
}

// ---------------------------------------------------------------- 媒体信息

export interface MediaInfo {
  duration: number | null;
  fps: number | null;
  width: number | null;
  height: number | null;
  hasAudio: boolean;
  hasVideo: boolean;
  raw: string;
}

/** 用 `ffmpeg -i` 解析媒体元数据（本机无 ffprobe，规格文档02 §2.5） */
export function mediaInfo(file: string): MediaInfo {
  const r = ffmpegRun(['-hide_banner', '-i', file]);
  const s = r.stderr;
  const dur = /Duration:\s*(\d+):(\d+):(\d+)\.(\d+)/.exec(s);
  const duration = dur ? Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]) + Number(`0.${dur[4]}`) : null;
  const vid = /Video:[^\n]*?,\s*(\d+)x(\d+)/.exec(s);
  const fpsM = /,\s*([\d.]+)\s*fps/.exec(s);
  // raw 只保留探针有效段（Input/Duration/Stream/Metadata），去掉版本横幅与
  // "At least one output file must be specified" 噪声（无 ffprobe 时的探测方式决定）
  const inputIdx = s.indexOf('Input #');
  const raw = (inputIdx >= 0 ? s.slice(inputIdx) : s)
    .split('\n')
    .filter((l) => !/At least one output file/.test(l))
    .join('\n')
    .trim();
  return {
    duration,
    fps: fpsM ? Number(fpsM[1]) : null,
    width: vid ? Number(vid[1]) : null,
    height: vid ? Number(vid[2]) : null,
    hasAudio: /Stream #\d+:\d+.*: Audio:/.test(s),
    hasVideo: /Stream #\d+:\d+.*: Video:/.test(s),
    raw,
  };
}

/** 数视频总帧数（-progress 解析，替代 ffprobe） */
export async function countVideoFrames(file: string): Promise<number> {
  const info = findFfmpeg();
  return new Promise((resolve, reject) => {
    const child = spawn(
      info.path,
      ['-hide_banner', '-nostats', '-progress', 'pipe:1', '-i', file, '-map', '0:v:0', '-f', 'null', '-'],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let out = '';
    let err = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (err += d.toString('utf8')));
    child.on('error', reject);
    child.on('close', (code) => {
      const matches = [...out.matchAll(/frame=(\d+)/g)].map((m) => Number(m[1]));
      const n = matches.length ? Math.max(...matches) : 0;
      if (code === 0) resolve(n);
      else reject(new Error(`无法统计帧数 ${file}: exit ${code}\n${err.slice(-1000)}`));
    });
  });
}

/** 从视频流提取单帧 PNG（抽检用） */
export async function extractFramePng(file: string, frameNo: number, outPng: string): Promise<void> {
  const r = await ffmpegExec([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', file,
    '-vf', `select=eq(n\\,${frameNo})`,
    '-frames:v', '1',
    outPng,
  ]);
  if (r.code !== 0 || !existsSync(outPng)) throw new Error(`抽帧失败 frame=${frameNo}: ${r.stderr.slice(-500)}`);
}

/** 从成片中抽取音频为 wav（verify 音频终检用：验证成片自身而非中间产物） */
export async function extractAudioWav(file: string, outWav: string, sr = 48000): Promise<void> {
  const r = await ffmpegExec([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-i', file,
    '-vn', '-ac', '2', '-ar', String(sr), '-c:a', 'pcm_s16le',
    outWav,
  ]);
  if (r.code !== 0 || !existsSync(outWav)) throw new Error(`音频抽取失败: ${r.stderr.slice(-500)}`);
}

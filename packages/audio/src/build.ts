// @kine/audio — 音频构建：sfx 离线合成（kine-py）→ 混音 → 缓存登记 / env 生成
import fs from 'node:fs';
import path from 'node:path';
import type { KineIR } from '@kine/dsl';
import { hashValue, short } from '@kine/dsl';
import { getKinePy, registerArtifact, touchEntry } from '@kine/store';
import { synthEvents, type SynthPlan } from './plan';

export interface AudioBuildOptions {
  cacheDir: string;
  locksDir: string;
  sr?: number;
  force?: boolean;
  onProgress?: (ev: { phase: string; detail?: string }) => void;
}

export interface AudioArtifact {
  mixFile: string;
  key: string;
  key8: string;
  cached: boolean;
  sfxFile: string | null;
  musicFile: string | null;
  stats: AudioStats | null;
  events: number;
  limited: boolean;
  ms: number;
}

export interface AudioStats {
  peakDbfs: number;
  rmsDbfs: number;
  t99_9: number | null;
  tailPeakDbfs: number;
  duration: number;
  curvePoints: number;
}

/** 缓存键：musicHash × sfxPlanHash × mixProfile（sr/limit/duration/tailFade） */
export function audioCacheKey(ir: KineIR, sr = 48000): string {
  return hashValue({
    musicHash: ir.hashes.musicHash,
    sfxPlanHash: ir.hashes.sfxPlanHash,
    mixProfile: { sr, limit: ir.output.audio.limit_dbfs, duration: ir.output.duration, tailFade: ir.audioPlan.tailFade },
  });
}

/**
 * 构建混音轨（sfx + music）：
 * 1) kine-py sfx_track（离线合成，clock:output 事件天然免疫 pace 改动）
 * 2) kine-py mix（cut_from/fade_out/全路等比 limit）
 * 3) 缓存登记 .kine/cache/audio/<key8>_mix.wav
 */
export async function buildAudio(ir: KineIR, opts: AudioBuildOptions): Promise<AudioArtifact> {
  const t0 = Date.now();
  const sr = opts.sr ?? 48000;
  const key = audioCacheKey(ir, sr);
  const key8 = short(key, 8);
  const audioDir = path.join(opts.cacheDir, 'audio');
  fs.mkdirSync(audioDir, { recursive: true });
  const mixFile = path.join(audioDir, `${key8}_mix.wav`);
  const sfxFile = path.join(audioDir, `${key8}_sfx.wav`);
  const plan = synthEvents(ir, sr);
  const music = ir.audioPlan.music;
  const musicAbs = music && music.exists ? music.absPath : null;

  if (fs.existsSync(mixFile) && !opts.force) {
    await touchEntry(opts.cacheDir, opts.locksDir, key).catch(() => undefined);
    // 命中同样产出 stats（便宜；与未命中路径返回结构一致）
    let hitStats: AudioStats | null = null;
    try {
      const py = await getKinePy();
      hitStats = (await py.call('audio_stats', { wav: mixFile })) as AudioStats;
    } catch {
      /* stats 获取失败不阻塞缓存命中返回 */
    }
    return {
      mixFile, key, key8, cached: true,
      sfxFile: fs.existsSync(sfxFile) ? sfxFile : null,
      musicFile: musicAbs,
      stats: hitStats,
      events: plan.events.length,
      limited: hitStats ? Math.abs(hitStats.peakDbfs - ir.output.audio.limit_dbfs) < 5e-3 : false,
      ms: Date.now() - t0,
    };
  }

  const py = await getKinePy();
  opts.onProgress?.({ phase: 'sfx', detail: `${plan.events.length} events` });

  let hasSfx = false;
  if (plan.events.length > 0) {
    await py.call('sfx_track', {
      events: plan.events,
      sr,
      duration: plan.duration,
      seed: plan.seed,
      busGains: plan.busGains,
      tailFade: ir.audioPlan.tailFade,
      out: sfxFile,
    });
    hasSfx = fs.existsSync(sfxFile);
  }

  opts.onProgress?.({ phase: 'mix', detail: musicAbs ? 'music + sfx' : 'sfx only' });
  const minfo = (await py.call('mix', {
    music: musicAbs,
    duration: plan.duration,
    out: mixFile,
    sfxPath: hasSfx ? sfxFile : null,
    gain: music?.gain ?? 1.0,
    fadeOut: music?.fadeOut ?? null,
    cutFrom: music?.cutFrom ?? null,
    limitDbfs: ir.output.audio.limit_dbfs,
    sr,
  })) as { limited?: boolean };

  opts.onProgress?.({ phase: 'stats' });
  const stats = (await py.call('audio_stats', { wav: mixFile })) as AudioStats;

  await registerArtifact(opts.cacheDir, opts.locksDir, {
    key,
    kind: 'audio_mix',
    file: mixFile,
    inputs: [ir.hashes.musicHash, ir.hashes.sfxPlanHash, `sr${sr}`, `limit${ir.output.audio.limit_dbfs}`],
  });

  return {
    mixFile, key, key8, cached: false,
    sfxFile: hasSfx ? sfxFile : null,
    musicFile: musicAbs,
    stats,
    events: plan.events.length,
    limited: minfo.limited ?? false,
    ms: Date.now() - t0,
  };
}

export interface EnvArtifact {
  file: string;
  cached: boolean;
  max: number;
  mean: number;
  nframes: number;
  missingMusic?: boolean;
}

/**
 * 生成帧对齐能量包络（STFT 前 10 bin → dB → 0-255，帧对齐）。
 * 仅当音乐存在时可用；无音乐工程返回 missingMusic（beat_delta 等领域 SKIP）。
 */
export async function buildEnv(
  ir: KineIR,
  opts: { cacheDir: string; locksDir: string; force?: boolean },
): Promise<EnvArtifact> {
  const music = ir.audioPlan.music;
  if (!music || !music.exists) {
    return { file: '', cached: false, max: 0, mean: 0, nframes: ir.output.fps * ir.output.duration > 0 ? Math.round(ir.output.fps * ir.output.duration) : 0, missingMusic: true };
  }
  const key = hashValue({ env: ir.hashes.musicHash, fps: ir.output.fps, nframes: Math.round(ir.output.fps * ir.output.duration) });
  const dir = path.join(opts.cacheDir, 'env');
  fs.mkdirSync(dir, { recursive: true });
  const out = path.join(dir, `${short(key, 8)}.json`);
  if (fs.existsSync(out) && !opts.force) {
    const j = JSON.parse(fs.readFileSync(out, 'utf8')) as { max: number; mean: number; nframes: number };
    await touchEntry(opts.cacheDir, opts.locksDir, key).catch(() => undefined);
    return { file: out, cached: true, max: j.max, mean: j.mean, nframes: j.nframes };
  }
  const py = await getKinePy();
  const r = (await py.call('env', {
    music: music.absPath,
    fps: ir.output.fps,
    nframes: Math.round(ir.output.fps * ir.output.duration),
    out,
  })) as { max: number; mean: number; nframes: number };
  await registerArtifact(opts.cacheDir, opts.locksDir, {
    key,
    kind: 'audio_env',
    file: out,
    inputs: [ir.hashes.musicHash, `fps${ir.output.fps}`],
  });
  return { file: out, cached: false, max: r.max, mean: r.mean, nframes: r.nframes };
}

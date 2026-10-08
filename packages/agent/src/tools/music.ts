// @kine/agent — 工具：music（本地音乐库：入库/分析/BPM/拍点/成片适配）
//
// 与 library 的关系：music 是 kind='music' 的库条目 + 分析数据（analysis）。
// 分析走 kine-py（audio_stats/beats），纯函数派生、随条目版本缓存。
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import {
  addBlob,
  addLibraryEntry,
  kineHome,
  kineLibraryRoot,
  libraryBlobPath,
  resolveLibraryEntry,
  type LibraryEntry,
} from '@kine/store';
import { audioConvertArgs, ffmpegExec } from '@kine/render';
import { getKinePy } from '@kine/store';
import { ambiguous, fail, ok, type ToolResult } from '../types';
import type { AgentContext } from '../context';

export const MUSIC_ANALYZER_VERSION = 'kine-music/1';

export interface MusicArgs {
  action: 'add' | 'info' | 'analyze' | 'beats' | 'fit';
  file?: string;
  ref?: string;
  name?: string;
  tags?: string[];
  ns?: 'core' | 'ai' | 'usr';
  limit?: number;
}

export interface MusicAnalysis {
  analyzerVersion: string;
  duration: number;
  sr: number;
  peakDbfs: number;
  rmsDbfs: number;
  t99_9: number;
  beatsCount: number;
  bpm: number | null;
  bpmConfidence: number | null;
  beatIntervalS: number | null;
  firstBeatS: number | null;
  beats: { t: number; strength: number }[];
}

function resolveUserFile(ctx: AgentContext, file: string): string {
  const base = process.env.KINE_CWD ?? process.cwd();
  const p1 = path.isAbsolute(file) ? file : path.resolve(base, file);
  if (existsSync(p1)) return p1;
  const p2 = path.isAbsolute(file) ? file : path.resolve(ctx.dir, file);
  return p2;
}

const stripExt = (f: string) => f.replace(/\.[^.]+$/, '');

async function analyzeMusicWav(wavFile: string): Promise<MusicAnalysis> {
  const py = await getKinePy();
  const stats = (await py.call('audio_stats', { wav: wavFile, window: 0.1 })) as {
    duration: number;
    sr: number;
    peakDbfs: number;
    rmsDbfs: number;
    t99_9: number;
  };
  const beatsRes = (await py.call('beats', { wav: wavFile })) as {
    beats: { t: number; strength: number }[];
    count: number;
  };
  const beats = (beatsRes.beats ?? []).slice().sort((a, b) => a.t - b.t);
  // BPM 估计：中位拍间隔 → 折叠进 [60,180]
  let bpm: number | null = null;
  let bpmConfidence: number | null = null;
  let beatIntervalS: number | null = null;
  let firstBeatS: number | null = null;
  if (beats.length >= 3) {
    const intervals: number[] = [];
    for (let i = 1; i < beats.length; i += 1) intervals.push(beats[i]!.t - beats[i - 1]!.t);
    intervals.sort((a, b) => a - b);
    const med = intervals[Math.floor(intervals.length / 2)]!;
    if (med > 0.05) {
      let b = 60 / med;
      while (b < 60) b *= 2;
      while (b > 180) b /= 2;
      bpm = Math.round(b * 10) / 10;
      beatIntervalS = 60 / bpm;
      firstBeatS = beats[0]!.t;
      const devs = intervals.map((v) => Math.abs(v - med));
      devs.sort((a, b2) => a - b2);
      const mad = devs[Math.floor(devs.length / 2)]!;
      bpmConfidence = Math.max(0, Math.min(1, 1 - mad / med));
    }
  }
  return {
    analyzerVersion: MUSIC_ANALYZER_VERSION,
    duration: stats.duration,
    sr: stats.sr,
    peakDbfs: stats.peakDbfs,
    rmsDbfs: stats.rmsDbfs,
    t99_9: stats.t99_9,
    beatsCount: beatsRes.count ?? beats.length,
    bpm,
    bpmConfidence,
    beatIntervalS,
    firstBeatS,
    beats: beats.slice(0, 4096),
  };
}

function getEntry(ref: string): { entry: LibraryEntry } | { error: ToolResult<unknown> } {
  const res = resolveLibraryEntry(kineLibraryRoot(), ref);
  if (!res.ok) {
    return { error: fail('music', res.error.code, res.error.message, { facts: res.error.facts ?? [], hints: res.error.hints ?? [] }) };
  }
  if (res.entry.kind !== 'music') {
    return { error: fail('music', 'E-MUSIC-004', `条目 ${res.entry.id} 不是 music（kind=${res.entry.kind}）`) };
  }
  return { entry: res.entry };
}

export async function toolMusic(ctx: AgentContext, opts: MusicArgs): Promise<ToolResult<unknown>> {
  switch (opts.action) {
    case 'add': {
      if (!opts.file) return fail('music', 'E-MUSIC-001', 'add 需要 --file <音频文件>', { hints: ['kine music add assets/song.mp3 --name my-song --tags dreamy'] });
      const src = resolveUserFile(ctx, opts.file);
      if (!existsSync(src)) return fail('music', 'E-MUSIC-002', `找不到音频文件：${src}`);
      const tmpDir = path.join(kineHome(), 'tmp');
      mkdirSync(tmpDir, { recursive: true });
      const tmp = path.join(tmpDir, `music-${Date.now()}-${process.pid}.wav`);
      const run = await ffmpegExec(audioConvertArgs(src, tmp, 48000, 2));
      if (run.code !== 0 || !existsSync(tmp)) {
        return fail('music', 'E-MUSIC-003', 'ffmpeg 转码失败（→ 48kHz 无损 wav）', {
          facts: [`ffmpeg exit=${run.code}`],
          hints: ['确认 ffmpeg 可用（kine doctor）；确认文件是常见音频格式'],
        });
      }
      const blob = await addBlob(kineLibraryRoot(), tmp);
      rmSync(tmp, { force: true });
      const analysis = await analyzeMusicWav(path.join(kineLibraryRoot(), blob.blob));
      const entry = await addLibraryEntry(kineLibraryRoot(), {
        name: opts.name ?? stripExt(path.basename(src)),
        kind: 'music',
        ns: opts.ns ?? 'usr',
        tags: opts.tags,
        status: 'library',
        sha256: blob.sha256,
        size: blob.size,
        blob: blob.blob,
        analysis,
        source: path.basename(src),
        data: { sr: 48000, channels: 2, format: 'wav' },
      });
      const facts = [
        `已入库：${entry.id}（v${entry.version}${blob.existed ? ' · 内容已存在，直接引用' : ''}）`,
        `时长 ${analysis.duration.toFixed(3)}s｜峰值 ${analysis.peakDbfs.toFixed(2)}dB｜RMS ${analysis.rmsDbfs.toFixed(2)}dB｜t99.9 ${analysis.t99_9.toFixed(2)}s`,
        analysis.bpm !== null ? `BPM ≈ ${analysis.bpm}（置信度 ${(analysis.bpmConfidence ?? 0).toFixed(2)}，建议值供用户拍板）` : 'BPM：未检测到稳定拍点',
        `sha256:${blob.sha256.slice(0, 12)}…（内容寻址，参与 specHash）`,
        `引用：audio.music.file: library://${entry.id}`,
      ];
      return ok('music', { entry, analysis, dedup: blob.existed }, { verdict: 'PASS', facts, nextActions: [{ tool: 'kine.edit', args: { expr: `set audio.music.file=library://${entry.id}` }, reason: '把该音乐接到工程上' }] });
    }
    case 'info': {
      if (!opts.ref) return fail('music', 'E-MUSIC-001', 'info 需要 --ref <library://id|@tag>');
      const g = getEntry(opts.ref);
      if ('error' in g) return g.error;
      const e = g.entry;
      const a = e.analysis as MusicAnalysis | undefined;
      const facts = [
        `${e.id}（v${e.version} · ${e.status}）`,
        a ? `时长 ${a.duration.toFixed(3)}s｜BPM ${a.bpm ?? '—'}（置信 ${a.bpmConfidence?.toFixed(2) ?? '—'}）｜RMS ${a.rmsDbfs.toFixed(2)}dB` : '（未分析：kine music analyze --ref 补充）',
        e.sha256 ? `sha256:${e.sha256.slice(0, 12)}…` : '（无 blob）',
        `tags: ${e.tags.length ? e.tags.map((t) => `@${t}`).join(' ') : '—'}`,
      ];
      return ok('music', { entry: e }, { verdict: 'PASS', facts });
    }
    case 'analyze': {
      if (!opts.ref) return fail('music', 'E-MUSIC-001', 'analyze 需要 --ref <library://id>');
      const g = getEntry(opts.ref);
      if ('error' in g) return g.error;
      const e = g.entry;
      if (!e.sha256 || !e.blob) return fail('music', 'E-MUSIC-005', `条目 ${e.id} 缺少 blob（无法分析）`);
      const wav = libraryBlobPath(kineLibraryRoot(), e.sha256);
      if (!existsSync(wav)) return fail('music', 'E-MUSIC-005', `blob 缺失：${wav}`);
      const analysis = await analyzeMusicWav(wav);
      const entry = await addLibraryEntry(kineLibraryRoot(), {
        id: e.id, name: e.name, kind: 'music', analysis,
      });
      return ok('music', { entry, analysis }, { verdict: 'PASS', facts: [`已重新分析：${entry.id}（v${entry.version}）`, `时长 ${analysis.duration.toFixed(3)}s｜BPM ${analysis.bpm ?? '—'}`] });
    }
    case 'beats': {
      if (!opts.ref) return fail('music', 'E-MUSIC-001', 'beats 需要 --ref <library://id>');
      const g = getEntry(opts.ref);
      if ('error' in g) return g.error;
      const a = g.entry.analysis as MusicAnalysis | undefined;
      if (!a) return fail('music', 'E-MUSIC-006', '尚无分析数据', { hints: ['kine music analyze --ref <id> 先分析'] });
      const limit = opts.limit ?? 32;
      const facts = [
        `拍点 ${a.beatsCount} 个｜间隔 ${a.beatIntervalS?.toFixed(3) ?? '—'}s｜BPM ${a.bpm ?? '—'}`,
        ...a.beats.slice(0, limit).map((b) => `t=${b.t.toFixed(3)}s 强度 ${b.strength.toFixed(2)}`),
        a.beats.length > limit ? `…（截断显示 ${limit}/${a.beats.length}）` : null,
      ].filter(Boolean) as string[];
      return ok('music', { beats: a.beats.slice(0, limit), total: a.beatsCount, bpm: a.bpm, beatIntervalS: a.beatIntervalS }, { verdict: 'PASS', facts });
    }
    case 'fit': {
      if (!opts.ref) return fail('music', 'E-MUSIC-001', 'fit 需要 --ref <library://id>（对照当前工程成片时长）');
      const g = getEntry(opts.ref);
      if ('error' in g) return g.error;
      const e = g.entry;
      const a = e.analysis as MusicAnalysis | undefined;
      if (!a) return fail('music', 'E-MUSIC-006', '尚无分析数据', { hints: ['kine music analyze --ref <id> 先分析'] });
      const comp = ctx.compile();
      if (comp.issues.some((i) => i.severity === 'error')) {
        return fail('music', 'E-MUSIC-007', '当前工程编译未通过（先修错误再 fit）', { facts: comp.issues.slice(0, 5).map((i) => `${i.code} ${i.message}`) });
      }
      const ir = comp.ir;
      const filmDur = ir.output.duration;
      const musicDur = a.duration;
      const diff = musicDur - filmDur;
      const facts = [
        `音乐 ${e.id}：${musicDur.toFixed(3)}s｜成片：${filmDur.toFixed(3)}s｜差 ${diff >= 0 ? '+' : ''}${diff.toFixed(3)}s`,
        ir.audioPlan.music ? `工程当前音乐引用：${ir.audioPlan.music.file}` : '工程当前未挂音乐（audio.music.file 为空）',
      ];
      if (Math.abs(diff) <= 0.35) {
        return ok('music', { ref: e.id, musicDur, filmDur, diff }, { verdict: 'PASS', facts: [...facts, '长度匹配（±0.35s 内）：无需处理'] });
      }
      const fade = ir.audioPlan.music?.fadeOut ?? null;
      const fadeAt = fade ? (fade as { at: number }).at : Math.max(0, filmDur - 1.2);
      const options: { label: string; id: string; facts: string[] }[] = [];
      if (diff > 0) {
        options.push({
          label: '保持现状：多余部分在成片外截断（推荐先确认）',
          id: 'keep',
          facts: [`成片在 ${filmDur.toFixed(2)}s 结束；音乐 ${(musicDur - filmDur).toFixed(2)}s 的内容不会出现`, '如需干净收尾：把 fade_out 调至成片末段（见“提前淡出”选项）'],
        });
        options.push({
          label: '延长成片至音乐长度',
          id: 'extend-film',
          facts: [`set output.duration=${musicDur.toFixed(2)}（方向性决策：整片时长改变）`, 'impact 显示 map/音频时间表/全部帧受影响'],
        });
        options.push({
          label: '提前淡出（推荐：不改成片长度）',
          id: 'fade-earlier',
          facts: [`set audio.music.fade_out.at=${(filmDur - 1.0).toFixed(2)}`, `set audio.music.fade_out.dur=0.8`, `set audio.music.cut_from=${filmDur.toFixed(2)}`],
        });
      } else {
        const gap = -diff;
        options.push({
          label: '接受尾部留白（可用 drone bed 垫底）',
          id: 'accept-gap',
          facts: [`末 ${gap.toFixed(2)}s 无音乐（drone_levels 仍在）`, '适合终幕单色收束'],
        });
        options.push({
          label: '延长/补段：先在库中准备拼接版音乐',
          id: 'looped',
          facts: [`循环补段不建议对原曲变速（保持原速纪律）`, `可以把“音乐+静音/延音”版本用 kine music add 入库后切换 reference`],
        });
        options.push({
          label: '缩短成片',
          id: 'shorten-film',
          facts: [`set output.duration=${musicDur.toFixed(2)}（方向性决策）`],
        });
      }
      return ambiguous('music', `音乐与成片长度不匹配（差 ${diff.toFixed(2)}s）：如何处理？`, options);
    }
    default:
      return fail('music', 'E-MUSIC-000', `未知 action: ${String(opts.action)}`);
  }
}

export const MUSIC_ACTIONS = ['add', 'info', 'analyze', 'beats', 'fit'] as const;

// 兼容占位：os 导入在部分构建下用于未来（保持 lint 一致性）
import { createHash } from 'node:crypto';

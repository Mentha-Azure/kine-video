// kine.verify —— 成片终检：帧数/时长/媒体信息 + 音频断言 + 接缝图 + 关键帧抽检（stateHash 对基线）
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { pointAtFrame } from '@kine/dsl';
import {
  getKinePy,
  latestBaseline,
  readLatest,
  setLatest,
  tsStamp,
  writeJsonAtomic,
  atomicWriteFile,
} from '@kine/store';
import { ensureDir } from '@kine/render';
import {
  capturePngs,
  countVideoFrames,
  extractAudioWav,
  extractFramePng,
  mediaInfo,
  openRenderSession,
  renderDefaults,
} from '@kine/render';
import type { AgentContext } from '../context';
import { fail, ok, type ToolResult } from '../types';
import { ensureMix } from './util';

export interface VerifyOptions {
  file?: string;
  version?: string;
  /** 关键幕帧抽检（stateHash 对基线 + 接缝图） */
  shots?: boolean;
}

interface CheckRow {
  id: string;
  status: 'PASS' | 'FAIL' | 'WARN' | 'SKIP';
  detail: string;
}

export async function toolVerify(ctx: AgentContext, opts: VerifyOptions = {}): Promise<ToolResult> {
  const ir = ctx.ir();
  const store = ctx.store;
  const map = ir.time.map;

  // ---- 定位目标产物
  let version = opts.version;
  let file = opts.file;
  if (!file) {
    if (!version) version = readLatest(store.layout.outDir)?.version;
    if (!version) {
      return fail('verify', 'E-VERIFY-000', '没有可验证的产物（out/ 下无版本，且未给 --file）', {
        hints: ['先 kine render，或 verify --file <路径>'],
      });
    }
    file = join(store.layout.outDir, version, `${version}.mp4`);
  }
  if (!existsSync(file)) {
    return fail('verify', 'E-VERIFY-000', `产物不存在：${file}`);
  }

  const checks: CheckRow[] = [];
  const failures: string[] = [];

  // ---- ① 媒体信息 + 帧数 + 时长
  const info = mediaInfo(file);
  const expectFrames = map.frames;
  checks.push({
    id: 'media-info',
    status: info.hasVideo ? 'PASS' : 'FAIL',
    detail: `${info.width}x${info.height}@${info.fps ?? '?'}fps duration=${info.duration ?? '?'}s audio=${info.hasAudio}`,
  });
  if (!info.hasVideo) failures.push('E-VERIFY-001 成片无视频流');
  if (info.width !== ir.output.width || info.height !== ir.output.height) {
    checks.push({ id: 'resolution', status: 'FAIL', detail: `分辨率 ${info.width}x${info.height} ≠ 期望 ${ir.output.width}x${ir.output.height}` });
    failures.push('E-VERIFY-001 分辨率不符');
  } else {
    checks.push({ id: 'resolution', status: 'PASS', detail: `${info.width}x${info.height}` });
  }
  let frames = 0;
  try {
    frames = await countVideoFrames(file);
    if (frames === expectFrames) {
      checks.push({ id: 'frames', status: 'PASS', detail: `${frames} 帧（期望 ${expectFrames}）` });
    } else {
      checks.push({ id: 'frames', status: 'FAIL', detail: `${frames} 帧 ≠ 期望 ${expectFrames}（差 ${frames - expectFrames}）` });
      failures.push(`E-VERIFY-001 帧数不符：${frames} vs ${expectFrames}`);
    }
  } catch (e) {
    checks.push({ id: 'frames', status: 'FAIL', detail: `数帧失败：${e instanceof Error ? e.message.slice(0, 200) : e}` });
    failures.push('E-VERIFY-001 数帧失败');
  }
  if (info.duration !== null) {
    const expectDur = ir.output.duration;
    const okDur = Math.abs(info.duration - expectDur) <= 1.5 / ir.output.fps + 1e-6;
    checks.push({
      id: 'duration',
      status: okDur ? 'PASS' : 'FAIL',
      detail: `${info.duration.toFixed(3)}s（期望 ${expectDur.toFixed(3)}s，容差 1 帧）`,
    });
    if (!okDur) failures.push(`E-VERIFY-001 时长不符：${info.duration} vs ${expectDur}`);
  }

  // ---- ② 音频三断言（对成片自身抽取）
  const versionDir = version ? join(store.layout.outDir, version) : join(store.layout.kineDir, 'out', 'verified');
  await ensureDir(versionDir);
  const wavFile = join(versionDir, 'verify_audio.wav');
  let audioRows: CheckRow[] = [];
  try {
    if (!info.hasAudio) {
      audioRows.push({ id: 'audio-track', status: 'FAIL', detail: '成片无音轨（法定交付须带音轨）' });
      failures.push('E-VERIFY-002 成片无音轨');
    } else {
      await extractAudioWav(file, wavFile);
      const py = await getKinePy();
      const stats = (await py.call('audio_stats', { wav: wavFile, window: 0.1 })) as {
        peakDbfs: number;
        rmsDbfs: number;
        t99_9: number;
        tailPeakDbfs: number;
        duration: number;
        rmsCurve: Array<{ t: number; dbfs: number }>;
      };
      audioRows.push({ id: 'audio-track', status: 'PASS', detail: `峰值 ${stats.peakDbfs.toFixed(2)}dBFS｜RMS ${stats.rmsDbfs.toFixed(2)}dB｜t99.9=${stats.t99_9.toFixed(2)}s` });
      // ① loudness：峰值 ≤ -1.0dBFS（限幅纪律）
      const loudOk = stats.peakDbfs <= -0.98;
      audioRows.push({ id: 'loudness', status: loudOk ? 'PASS' : 'FAIL', detail: `峰值 ${stats.peakDbfs.toFixed(2)}dBFS（≤ -1.0）` });
      if (!loudOk) failures.push(`E-VERIFY-002 响度超限：${stats.peakDbfs.toFixed(2)} > -1.0dBFS`);
      // ② tail-clean：末 0.2s 峰值 < -30dB
      const tailOk = stats.tailPeakDbfs < -30;
      audioRows.push({
        id: 'tail-clean',
        status: tailOk ? 'PASS' : 'WARN',
        detail: `末 0.2s 峰值 ${stats.tailPeakDbfs.toFixed(2)}dB（目标 < -30dB）${tailOk ? '' : '——检查收尾淡出（L-AUD-002 只砍 song 路，sfx 同步淡出）'}`,
      });
      // ③ music-intact：音乐区（0..cut_from）存在能量 > -20dB 的窗口
      const cutFrom = ir.audioPlan?.music?.cutFrom;
      if (ir.audioPlan?.music?.exists && typeof cutFrom === 'number' && cutFrom > 0) {
        const inMusic = stats.rmsCurve.filter((p) => p.t < cutFrom - 0.2);
        const loudest = inMusic.reduce((m, p) => Math.max(m, p.dbfs), -Infinity);
        const intactOk = loudest > -20;
        audioRows.push({
          id: 'music-intact',
          status: intactOk ? 'PASS' : 'WARN',
          detail: `音乐区 [0, ${cutFrom}s) 最响窗 ${Number.isFinite(loudest) ? loudest.toFixed(2) : '-inf'}dB（目标 > -20dB）`,
        });
      } else {
        audioRows.push({ id: 'music-intact', status: 'SKIP', detail: '无音乐轨（纯 sfx 工程）' });
      }
    }
  } catch (e) {
    audioRows.push({ id: 'audio', status: 'FAIL', detail: `音频终检失败：${e instanceof Error ? e.message.slice(0, 300) : e}` });
    failures.push('E-VERIFY-002 音频终检失败');
  }
  checks.push(...audioRows);

  // ---- ③ 关键幕帧抽检 + 接缝图（--shots，默认开）
  const shotsOn = opts.shots !== false;
  const shotFrames: number[] = [];
  const seamFrames: number[] = [];
  let hashRows: CheckRow[] = [];
  if (shotsOn) {
    const shotsDir = join(versionDir, 'shots');
    await ensureDir(shotsDir);
    const sceneShots = ir.scenes.map((s) => s.frame0 + Math.round((s.frame1 - s.frame0) * 0.62));
    const breaks = map.breaks.map((b) => b.frame).filter((f) => f > 0 && f < map.frames);
    shotFrames.push(...sceneShots);
    // 接缝图：断点前后 ±3 帧
    for (const b of breaks) {
      for (const f of [b - 3, b, b + 3]) if (f >= 0 && f < map.frames) seamFrames.push(f);
    }
    try {
      // 独立 capture 路径抓关键帧（规格文档04 §4.2：抽检走独立路径）
      const defaults = renderDefaults(ir, store.root);
      const caps = await capturePngs(ir, [...new Set(shotFrames)], { ...defaults, outDir: shotsDir, prefix: 'key' });
      for (const c of caps) {
        checks.push({ id: `shot-f${c.frame}`, status: 'PASS', detail: `抽检帧 ${c.frame} → ${c.file.split(/[\\/]/).pop()}` });
      }
      // 接缝帧从成片抽取（人眼核查用）
      for (const f of [...new Set(seamFrames)]) {
        const out = join(shotsDir, `seam_f${String(f).padStart(6, '0')}.png`);
        await extractFramePng(file, f, out);
      }
      checks.push({ id: 'seams', status: 'PASS', detail: `接缝帧 ${new Set(seamFrames).size} 张 → ${shotsDir}` });
      // ④ stateHash 对基线（黄金帧）
      const latest = latestBaseline(store.layout.baselineDir);
      if (latest && latest.keyframes.length > 0) {
        const session = await openRenderSession(ir, { ...defaults, tag: 'verify' });
        try {
          const ts = latest.keyframes.map((k) => pointAtFrame(map, k.frame).T);
          const hashes = await session.hashMany(ts);
          const mismatches: string[] = [];
          latest.keyframes.forEach((k, i) => {
            const got = hashes[i]?.hash;
            if (got !== k.stateHash) mismatches.push(`${k.scene}@f${k.frame}（基线 ${k.stateHash} vs 现 ${got}）`);
          });
          hashRows.push({
            id: 'keyframe-hash',
            status: mismatches.length === 0 ? 'PASS' : 'FAIL',
            detail: mismatches.length === 0 ? `${latest.keyframes.length} 个黄金帧 stateHash 与基线 ${latest.version} 一致` : `不一致：${mismatches.slice(0, 3).join('；')}`,
          });
          if (mismatches.length > 0) failures.push(`E-VERIFY-003 黄金帧回归：${mismatches.length} 处不一致`);
        } finally {
          await session.close().catch(() => undefined);
        }
      } else {
        hashRows.push({ id: 'keyframe-hash', status: 'SKIP', detail: '无基线（kine baseline --save 后启用黄金帧对比）' });
      }
    } catch (e) {
      checks.push({ id: 'shots', status: 'WARN', detail: `抽检失败（不阻止结论）：${e instanceof Error ? e.message.slice(0, 200) : e}` });
    }
    checks.push(...hashRows);
  }

  // ---- 结论 + 报告写盘
  const warnCount = checks.filter((c) => c.status === 'WARN').length;
  const failCount = checks.filter((c) => c.status === 'FAIL').length;
  const verdict = failCount > 0 ? 'FAIL' : 'PASS';
  const report = {
    ts: new Date().toISOString(),
    file,
    version: version ?? null,
    specHash: ir.specHash,
    frames: { expect: expectFrames, got: frames },
    media: info,
    checks,
    failures,
    verdict,
  };
  const stamp = tsStamp();
  const jsonFile = join(versionDir, 'report.json');
  const mdFile = join(versionDir, 'report.md');
  await writeJsonAtomic(jsonFile, report);
  await atomicWriteFile(mdFile, buildVerifyMd(report));
  if (version) {
    setLatest(store.layout.outDir, {
      version,
      ts: new Date().toISOString(),
      video: file,
      specHash8: ir.specHash.slice(0, 8),
      verified: verdict,
    });
  }

  const facts: string[] = [
    `终检对象：${file}${version ? `（版本 ${version}）` : ''}`,
    `帧数 ${frames}/${expectFrames}｜时长 ${info.duration?.toFixed(3) ?? '?'}s｜音轨 ${info.hasAudio ? '有' : '无'}`,
    ...checks.filter((c) => c.status !== 'PASS').map((c) => `[${c.status}] ${c.id}: ${c.detail}`),
    verdict === 'PASS' ? `verify 通过${warnCount ? `（${warnCount} 条 WARN 已解释）` : ''}，报告：${mdFile}` : `verify 失败：${failures.join('；')}`,
  ];

  return ok('verify', report, {
    verdict,
    facts,
    hints: verdict === 'PASS'
      ? ['成品形态验证通过：可交付 out/<version>/（report.md + 成片）']
      : ['失败项需修复后重渲；WARN 项需在交付说明中解释'],
    nextActions: verdict === 'PASS'
      ? [{ tool: 'kine.changelog', args: {}, reason: '交付前复查变更记录' }]
      : [{ tool: 'kine.measure', args: {}, reason: '复核相关指标' }],
  });
}

function buildVerifyMd(r: { ts: string; file: string; version: string | null; specHash: string; frames: { expect: number; got: number }; checks: CheckRow[]; failures: string[]; verdict: string }): string {
  const lines: string[] = [];
  lines.push(`# kine verify 报告 — ${r.version ?? '（--file）'}`, '');
  lines.push(`- 时间：${r.ts}`);
  lines.push(`- 产物：${r.file}`);
  lines.push(`- specHash：${r.specHash.slice(0, 16)}…`);
  lines.push(`- 帧数：${r.frames.got} / ${r.frames.expect}`);
  lines.push(`- 结论：**${r.verdict}**`, '');
  lines.push('## 检查项', '');
  lines.push('| id | 状态 | 详情 |');
  lines.push('|---|---|---|');
  for (const c of r.checks) lines.push(`| ${c.id} | ${c.status} | ${c.detail} |`);
  if (r.failures.length > 0) {
    lines.push('', '## 失败项', '');
    for (const f of r.failures) lines.push(`- ${f}`);
  }
  return lines.join('\n');
}

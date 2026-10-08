// kine.render —— 全片/区间渲染 + 版本管理（最新版永远占「终版」指针）
import { join } from 'node:path';
import { statSync } from 'node:fs';
import { pointAtFrame } from '@kine/dsl';
import { listVersions, nextVersion, readLatest, setLatest } from '@kine/store';
import { ensureDir, renderDefaults, renderProject, renderPreview, mediaInfo } from '@kine/render';
import type { AgentContext } from '../context';
import { fail, ok, type ToolResult } from '../types';
import { ensureMix } from './util';

export interface RenderOptions {
  /** 区间 a:b（组件默认帧；'s' 后缀=秒，可混用），如 "0:300"、"0:5s" */
  range?: string;
  workers?: number;
  noCache?: boolean;
  keepFrames?: boolean;
  version?: string;
  audio?: boolean;
  /** 编码档位 preset 覆盖（ultrafast…veryslow；缓存按档位隔离） */
  preset?: string;
}

const PRESETS = ['ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'] as const;

/** 解析区间字符串：a:b，组件默认帧；'s' 后缀=秒（×fps），'f' 后缀=帧（显式） */
function parseRange(raw: string, fps: number): { f0: number; f1: number; label: string } | { error: string } {
  const m = /^\s*([\d.]+)([sf]?)\s*:\s*([\d.]+)([sf]?)\s*$/.exec(raw);
  if (!m) return { error: `无法解析区间 "${raw}"（格式 a:b；秒用后缀如 0:5s）` };
  const conv = (v: string, u: string) => (u === 's' ? Math.round(Number(v) * fps) : Math.round(Number(v)));
  const f0 = conv(m[1]!, m[2]!);
  const f1 = conv(m[3]!, m[4]!);
  const label = m[2] === 's' || m[4] === 's' ? `由秒换算 @${fps}fps` : '按帧';
  return { f0, f1, label };
}

export async function toolRender(ctx: AgentContext, opts: RenderOptions = {}): Promise<ToolResult> {
  const ir = ctx.ir();
  const store = ctx.store;
  const defaults = renderDefaults(ir, store.root);
  const map = ir.time.map;
  const audioOn = opts.audio !== false;
  // v3 P0-2：交付路径音频构建必须成功（strict）——不再静默降级出无声成片
  let mixFile: string | null = null;
  if (audioOn) {
    try {
      mixFile = await ensureMix(ctx, ir, { strict: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const hints = (e as { hints?: string[] }).hints ?? [];
      return fail('render', 'E-AUDIO-MIX-001', msg, {
        facts: ['渲染属交付路径：音频构建失败时必须中止（避免无声成片）'],
        hints: [...hints, '可先用 kine check 定位 audio 配置问题；或 --no-audio 显式渲染无声版'],
      });
    }
  }
  let presetNote = '';
  if (opts.preset !== undefined) {
    if (!(PRESETS as readonly string[]).includes(opts.preset)) {
      return fail('render', 'E-RENDER-006', `未知编码档位 preset "${opts.preset}"`, {
        facts: [`可用档位：${PRESETS.join(' / ')}`],
        hints: ['快速迭代推荐 ultrafast 或 veryfast（成片请用默认档）'],
      });
    }
    defaults.profile = { ...defaults.profile, preset: opts.preset };
    presetNote = `编码档位：preset ${opts.preset}（缓存按档位隔离，改动档位会重新渲染）`;
  }

  // ---- 区间渲染：走成品形态预览路径（成片分辨率 + 音轨切片），不写版本目录不改终版指针
  if (opts.range) {
    const parsed = parseRange(opts.range, map.fps);
    if ('error' in parsed) {
      return fail('render', 'E-RENDER-005', parsed.error, {
        facts: [`本片 ${map.frames} 帧 @${map.fps}fps（${map.duration}s）`],
        hints: ['示例：--range 0:300（帧）｜--range 0:5s（秒）'],
      });
    }
    const { f0, f1 } = parsed;
    if (!(f0 >= 0 && f1 > f0 && f1 <= map.frames)) {
      return fail('render', 'E-RENDER-002', `--range ${opts.range} → ${f0}:${f1} 帧超出范围 [0, ${map.frames})`, {
        facts: [`本片 ${map.frames} 帧 @${map.fps}fps（${map.duration}s）`],
        hints: ['帧号区间为 [f0, f1)；示例：--range 0:300 或 --range 0:5s'],
      });
    }
    const t0 = pointAtFrame(map, f0).t;
    const t1 = pointAtFrame(map, Math.min(f1, map.frames - 1)).t;
    const dur = Math.max(0.05, (f1 - f0) / map.fps);
    const rangeDir = join(store.layout.kineDir, 'out', 'ranges');
    try {
      ctx.progress('render', `区间渲染 frame ${f0} → ${f1}（${f1 - f0} 帧）…`);
      const r = await renderPreview(ir, {
        ...defaults,
        outDir: rangeDir,
        t0,
        dur,
        audioFile: mixFile ?? undefined,
        keepFrames: opts.keepFrames,
        onProgress: (ev) => {
          if (ev.phase === 'frame') ctx.progress('render', `抓帧 ${ev.done}/${ev.total}（${ev.fps.toFixed(1)} fps）`, ev.done / ev.total);
        },
      });
      const info = await mediaInfo(r.file);
      return ok('render', {
        file: r.file,
        range: [f0, f1],
        frames: r.artifact.frames,
        cached: r.artifact.cached,
        ms: r.artifact.ms,
        media: info,
      }, {
        verdict: 'PASS',
        facts: [
          `区间产物：${r.file}（${f1 - f0} 帧，${r.artifact.cached ? '缓存命中' : `${r.artifact.ms}ms`}）`,
          `区间解读：${parsed.label} → 帧 ${f0}..${f1} ≈ t ${t0.toFixed(2)}s → ${t1.toFixed(2)}s`,
          info ? `媒体信息：${info.width}x${info.height}@${info.fps}` : '',
          presetNote,
        ].filter(Boolean),
        hints: ['区间产物用于快速审查，不写版本目录、不改终版指针'],
      });
    } catch (e) {
      return fail('render', 'E-RENDER-001', `区间渲染失败：${e instanceof Error ? e.message : String(e)}`, {
        hints: ['失败只影响当前区间：重试会自动只重抓失败分片', '也可用 kine doctor 检查环境'],
      });
    }
  }

  // ---- 全片渲染
  const outDir = store.layout.outDir;
  await ensureDir(outDir);
  const version = opts.version ?? nextVersion(outDir);
  const prev = readLatest(outDir);
  ctx.progress('render', `全片渲染 ${map.frames} 帧，${opts.workers ?? ir.render.workers} worker，版本 ${version}…`);

  try {
    const res = await renderProject(ir, {
      ...defaults,
      outDir,
      version,
      workers: opts.workers ?? ir.render.workers,
      audioFile: mixFile ?? undefined,
      noCache: opts.noCache,
      keepFrames: opts.keepFrames,
      onProgress: (ev) => {
        if (ev.phase === 'frame') {
          ctx.progress('render', `抓帧 ${ev.done}/${ev.total}（${ev.fps.toFixed(1)} fps，分片 ${ev.chunk.index}）`, ev.done / ev.total);
        } else if (ev.phase === 'concat') {
          ctx.progress('render', `拼接 ${ev.chunks} 个分片…`);
        } else if (ev.phase === 'mux') {
          ctx.progress('render', '音视频合流…');
        }
      },
    });

    if (!res.finalFile) {
      return fail('render', 'E-RENDER-004', '渲染完成但未生成合流文件（finalFile 为空）', {
        facts: [`视频分片已合流：${res.videoFile ?? '-'}`],
        hints: ['可能缺少音轨合流，检查音频产物后重试'],
      });
    }
    const finalFile = res.finalFile;
    setLatest(outDir, {
      version,
      ts: new Date().toISOString(),
      video: finalFile,
      specHash8: ir.specHash.slice(0, 8),
      verified: 'pending',
    });
    let size = 0;
    try { size = statSync(finalFile).size; } catch { /* ignore */ }

    const facts = [
      `出片：${finalFile}（${version}）`,
      `帧数 ${res.framesTotal}｜渲染 ${res.framesRendered}｜缓存命中 ${res.framesCached}｜用时 ${(res.elapsedMs / 1000).toFixed(1)}s`,
      `上一版：${prev?.version ?? '（首版）'}（不改名不覆盖）`,
      presetNote,
    ].filter(Boolean);
    return ok('render', {
      version,
      file: finalFile,
      videoFile: res.videoFile,
      outDir,
      framesTotal: res.framesTotal,
      framesRendered: res.framesRendered,
      framesCached: res.framesCached,
      elapsedMs: res.elapsedMs,
      size,
      prevVersion: prev?.version,
      chunks: res.chunks.map((c) => ({ index: c.index, f0: c.f0, f1: c.f1, cached: c.cached, ms: c.ms })),
    }, {
      verdict: 'PASS',
      facts,
      hints: ['下一步：kine verify 做成品终检（帧数/接缝/音频/抽检）'],
      nextActions: [{ tool: 'kine.verify', args: { version }, reason: '成品终检' }],
    });
  } catch (e) {
    const err = e as { code?: string; message?: string; frame?: number; T?: number; scene?: string };
    return fail('render', err.code ?? 'E-RENDER-001', err.message ?? String(e), {
      facts: err.frame !== undefined ? [`失败帧 ${err.frame}（T=${err.T?.toFixed(3)}s，幕 ${err.scene ?? '?'}）`] : [],
      hints: [
        '重试只重抓失败分片（缓存保留）',
        err.frame !== undefined ? `缩小范围排查：kine render --range ${Math.max(0, (err.frame ?? 0) - 60)}:${(err.frame ?? 0) + 60}` : '检查 kine doctor',
      ],
    });
  }
}
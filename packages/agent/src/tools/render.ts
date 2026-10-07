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
  range?: [number, number];
  workers?: number;
  noCache?: boolean;
  keepFrames?: boolean;
  version?: string;
  audio?: boolean;
}

export async function toolRender(ctx: AgentContext, opts: RenderOptions = {}): Promise<ToolResult> {
  const ir = ctx.ir();
  const store = ctx.store;
  const defaults = renderDefaults(ir, store.root);
  const map = ir.time.map;
  const audioOn = opts.audio !== false;
  const mixFile = audioOn ? await ensureMix(ctx, ir) : null;

  // ---- 区间渲染：走成品形态预览路径（成片分辨率 + 音轨切片），不写版本目录不改终版指针
  if (opts.range) {
    const [f0, f1] = opts.range;
    if (!(f0 >= 0 && f1 > f0 && f1 <= map.frames)) {
      return fail('render', 'E-RENDER-002', `--range ${f0}:${f1} 超出帧范围 [0, ${map.frames})`);
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
          info ? `媒体信息：${info.width}x${info.height}@${info.fps}` : '',
          `对应成片秒 t=${t0.toFixed(2)}s → ${t1.toFixed(2)}s`,
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
    ];
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
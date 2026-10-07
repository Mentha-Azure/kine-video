// kine.preview —— 成品形态短片（3-5s、成片分辨率、带音轨）为法定预览形态
import { join } from 'node:path';
import { ensureDir } from '@kine/render';
import { renderDefaults, renderPreview } from '@kine/render';
import { pointAt } from '@kine/dsl';
import type { AgentContext } from '../context';
import { fail, ok, type ToolResult } from '../types';
import { ensureMix } from './util';

export interface PreviewOptions {
  at: number;
  dur?: number;
  audio?: boolean;
  keepFrames?: boolean;
}

export async function toolPreview(ctx: AgentContext, opts: PreviewOptions): Promise<ToolResult> {
  const ir = ctx.ir();
  const dur = opts.dur ?? 4;
  if (!(opts.at >= 0) || opts.at > ir.output.duration) {
    return fail('preview', 'E-TIME-003', `--at ${opts.at} 超出成片时长 ${ir.output.duration}s`);
  }
  if (dur < 2 || dur > 8) {
    return fail('preview', 'E-TIME-002', `--dur ${dur} 超出法定区间：预览须为 3-5s 成品形态（2-8 容差）`, {
      hints: ['用法：kine preview --at 12 --dur 4'],
    });
  }
  const end = Math.min(opts.at + dur, ir.output.duration);
  if (end - opts.at < dur - 1e-6) {
    return fail('preview', 'E-TIME-003', `--at ${opts.at} + --dur ${dur} 超出成片时长 ${ir.output.duration}s`, {
      hints: [`可改为 --at ${Math.max(0, ir.output.duration - dur).toFixed(1)}`],
    });
  }

  const defaults = renderDefaults(ir, ctx.store.root);
  const previewDir = join(ctx.store.layout.kineDir, 'out', 'previews');
  await ensureDir(previewDir);
  const withAudio = opts.audio !== false;
  const mixFile = withAudio ? await ensureMix(ctx, ir) : null;

  const t0 = opts.at;
  try {
    ctx.progress('preview', `渲染预览 ${t0}s +${dur}s（${ir.output.width}x${ir.output.height}@${ir.output.fps}）…`);
    const r = await renderPreview(ir, {
      ...defaults,
      outDir: previewDir,
      t0,
      dur,
      audioFile: mixFile ?? undefined,
      keepFrames: opts.keepFrames,
      onProgress: (ev) => {
        if (ev.phase === 'frame' && ev.fps) ctx.progress('preview', `抓帧 ${ev.done}/${ev.total ?? '?'}（${ev.fps.toFixed(1)} fps）`, ev.total ? (ev.done / ev.total) : undefined);
      },
    });
    const pt = pointAt(ir.time.map, t0);
    return ok(
      'preview',
      {
        file: r.file,
        t0,
        dur,
        frames: r.artifact.frames,
        cached: r.artifact.cached,
        scene: pt.scene,
        hasAudio: !!mixFile,
      },
      {
        verdict: 'PASS',
        facts: [
          `预览已生成：${r.file}`,
          `区间 t=${t0}s → ${(t0 + dur).toFixed(1)}s（${pt.scene ?? '-'} 幕内，T=${pt.T.toFixed(2)}s）`,
          mixFile ? '含音轨（成品形态：分辨率+音轨，可直接播放）' : '无音轨（音乐缺失或 --no-audio）',
        ],
        hints: ['请播放预览确认效果；确认后 kine check → kine render'],
        nextActions: [
          { tool: 'kine.check', args: {}, reason: '断言集' },
          { tool: 'kine.render', args: {}, reason: '全片出片' },
        ],
      }
    );
  } catch (e) {
    return fail('preview', 'E-RENDER-001', `预览渲染失败：${e instanceof Error ? e.message : String(e)}`, {
      hints: ['可尝试更小 --dur 或检查浏览器环境（kine doctor）'],
    });
  }
}
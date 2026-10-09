// @kine/agent — layout：布局体检（v4）——bbox 重叠 / 出画 / 贴边（反馈：布局无任何检查，重叠要手工拼接触表才发现）
import { pointAt } from '@kine/dsl';
import { openRenderSession, renderDefaults } from '@kine/render';
import type { ProbeResult } from '@kine/runtime';
import type { AgentContext } from '../context';
import { fail, ok, type ToolResult } from '../types';

export interface LayoutArgs {
  /** 仅检查指定幕 id（默认全部幕） */
  scene?: string;
  /** 仅检查该成片秒时刻 */
  at?: number | string;
  /** --strict：任何相交都报（默认只报强重叠 ≥25% 较小盒） */
  strict?: boolean;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Placed {
  id: string;
  kind: string;
  widget?: string;
  box: Box;
}

function interArea(a: Box, b: Box): { area: number; ratioSmall: number } {
  const x0 = Math.max(a.x, b.x);
  const y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w);
  const y1 = Math.min(a.y + a.h, b.y + b.h);
  const area = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  const small = Math.min(a.w * a.h, b.w * b.h);
  return { area, ratioSmall: small > 0 ? area / small : 0 };
}

/** 布局体检：逐幕采样 probe → 元素 bbox 重叠/出画/贴边统计 */
export async function toolLayout(ctx: AgentContext, args: LayoutArgs = {}): Promise<ToolResult> {
  const { ir } = ctx.compile();
  const W = ir.output.width;
  const H = ir.output.height;
  const canvasArea = W * H;
  const minRatio = args.strict ? 1e-9 : 0.08; // 默认：相交 ≥8% 较小盒就算重叠线索
  const strongRatio = 0.25;

  // 采样点：默认每幕 25%/50%/62%/75%（幕内 lt 分数）；--at 单点；--scene 限定
  const samples: Array<{ scene: string; t: number }> = [];
  if (args.at !== undefined) {
    const sec = Number(args.at);
    if (!Number.isFinite(sec) || sec < 0 || sec > ir.output.duration) {
      return fail('layout', 'E-TIME-003', `--at 越界：${String(args.at)}（成片秒，0..${ir.output.duration}）`);
    }
    const pt = pointAt(ir.time.map, Math.min(sec, ir.output.duration - 1e-6));
    samples.push({ scene: pt.scene ?? '?', t: pt.t });
  } else {
    for (const sc of ir.scenes) {
      if (args.scene && sc.id !== args.scene) continue;
      for (const f of [0.25, 0.5, 0.62, 0.75]) samples.push({ scene: sc.id, t: sc.t0 + (sc.t1 - sc.t0) * f });
    }
  }
  if (samples.length === 0) {
    return fail('layout', 'E-LAYOUT-001', `未找到可采样的幕${args.scene ? `（--scene ${args.scene}）` : ''}`, {
      facts: [`幕：${ir.scenes.map((s) => s.id).join(' / ')}`],
    });
  }

  const defaults = renderDefaults(ir, ctx.store.root);
  const pairMap = new Map<string, { scene: string; t: number; a: string; b: string; ratio: number; areaPx: number }>();
  const offscreen = new Map<string, { scene: string; t: number; id: string; box: Box }>();
  const edgeHug = new Map<string, { scene: string; t: number; id: string; margin: number }>();
  let bgPairsIgnored = 0;

  let session: Awaited<ReturnType<typeof openRenderSession>> | null = null;
  try {
    session = await openRenderSession(ir, { ...defaults, tag: 'layout' });
    for (const s of samples) {
      const pt = pointAt(ir.time.map, Math.min(s.t, ir.time.map.duration - 1e-6));
      const pr = (await session.probe(pt.T)) as ProbeResult;
      const els: Placed[] = (pr.elements ?? [])
        .filter((e) => e.box && e.box.w > 1 && e.box.h > 1)
        .map((e) => ({ id: e.id, kind: String((e as { kind?: string }).kind ?? ''), widget: e.widget, box: { x: e.box.x, y: e.box.y, w: e.box.w, h: e.box.h } }));
      for (let i = 0; i < els.length; i++) {
        for (let j = i + 1; j < els.length; j++) {
          const a = els[i];
          const b = els[j];
          // 背景/全屏层（覆盖 ≥55% 画布）与任何元素的相交视为构成关系，不计重叠
          const aBig = (a.box.w * a.box.h) / canvasArea >= 0.55;
          const bBig = (b.box.w * b.box.h) / canvasArea >= 0.55;
          const r = interArea(a.box, b.box);
          if (r.area <= 0) continue;
          if (aBig || bBig) {
            if (r.ratioSmall >= minRatio) bgPairsIgnored += 1;
            continue;
          }
          if (r.ratioSmall < minRatio || r.area < 100) continue;
          const key = `${[a.id, b.id].sort().join('|')}`;
          const prev = pairMap.get(key);
          if (!prev || prev.ratio < r.ratioSmall) {
            pairMap.set(key, { scene: s.scene, t: +pt.t.toFixed(3), a: a.id, b: b.id, ratio: r.ratioSmall, areaPx: Math.round(r.area) });
          }
        }
      }
      for (const e of els) {
        const overL = -e.box.x;
        const overT = -e.box.y;
        const overR = e.box.x + e.box.w - W;
        const overB = e.box.y + e.box.h - H;
        const worst = Math.max(overL, overT, overR, overB);
        if (worst > 8) {
          offscreen.set(e.id, { scene: s.scene, t: +pt.t.toFixed(3), id: e.id, box: e.box });
        } else {
          const m = Math.min(e.box.x, e.box.y, W - (e.box.x + e.box.w), H - (e.box.y + e.box.h));
          if (m < 24) {
            const prev = edgeHug.get(e.id);
            if (!prev || m < prev.margin) edgeHug.set(e.id, { scene: s.scene, t: +pt.t.toFixed(3), id: e.id, margin: Math.round(m) });
          }
        }
      }
    }
  } catch (e) {
    return fail('layout', 'E-RUNTIME-001', `布局探针会话失败：${e instanceof Error ? e.message : String(e)}`, {
      hints: ['确认浏览器可用（KINE_BROWSER）与工程可编译；kine audit --syntax-only 可先排除语法问题'],
    });
  } finally {
    if (session) await session.close().catch(() => undefined);
  }

  const overlaps = [...pairMap.values()].sort((a, b) => b.ratio - a.ratio);
  const strong = overlaps.filter((o) => o.ratio >= strongRatio);
  const off = [...offscreen.values()];
  const hug = [...edgeHug.values()];
  const verdict = off.length > 0 || strong.length > 0 ? 'FAIL' : 'PASS';

  const facts: string[] = [
    `采样 ${samples.length} 点（每幕 25/50/62/75% lt；--at/--scene 可限定）`,
    `重叠 ${overlaps.length} 对${strong.length > 0 ? `（其中强重叠 ≥25%：${strong.length} 对）` : ''}${bgPairsIgnored > 0 ? `；与背景/全屏层相交 ${bgPairsIgnored} 处已忽略` : ''}`,
  ];
  for (const o of overlaps.slice(0, 6)) {
    facts.push(`  ⚠ ${o.a} × ${o.b}：相交占较小盒 ${(o.ratio * 100).toFixed(0)}%（scene=${o.scene} t=${o.t}s，约 ${o.areaPx}px²）`);
  }
  facts.push(`出画（越界 >8px）：${off.length} 个`);
  for (const o of off.slice(0, 4)) {
    facts.push(`  ✖ ${o.id} 出画（scene=${o.scene} t=${o.t}s box=${o.box.x},${o.box.y} ${o.box.w}×${o.box.h}）`);
  }
  facts.push(`贴边（距画布边 <24px）：${hug.length} 个${hug.length > 0 ? `（如 ${hug.slice(0, 3).map((h) => h.id).join(', ')}）` : ''}`);
  facts.push(verdict === 'PASS' ? `布局体检 PASS（强重叠 0、出画 0）` : `布局体检 FAIL：${strong.length} 对强重叠 / ${off.length} 个出画`);

  return ok(
    'layout',
    {
      verdict,
      samples: samples.length,
      overlaps,
      strongOverlap: strong.length,
      offscreen: off,
      edgeHug: hug,
      bgPairsIgnored,
    },
    {
      verdict,
      facts,
      hints:
        verdict === 'PASS'
          ? ['轻微重叠（<25%）未拦截——如需全部列出：kine layout --strict']
          : [
              '重叠：调 place.x/y/w/h 或图层顺序；强重叠通常是设计失误',
              '出画：bbox 越出画布边缘会被裁切（注意 camera.z1>1 时更窄）；用 place 收进安全区',
            ],
      nextActions: [{ tool: 'kine.contact', args: {}, reason: '生成接触表肉眼复核（重叠/贴边在接触表上一目了然）' }],
    },
  );
}

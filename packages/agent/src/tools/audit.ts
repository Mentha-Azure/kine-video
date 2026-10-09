// kine.audit —— 三层检查：①DSL schema ②purity lint ③0.25s 步进全轴运行时扫错（v4：+ widget props 静态检查）
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { TtoT, sceneAtT, type Issue } from '@kine/dsl';
import { kineRepoRoot } from '@kine/store';
import { openRenderSession, renderDefaults } from '@kine/render';
import { WIDGET_META } from '@kine/widgets';
import type { AgentContext } from '../context';
import { fail, ok, type ToolResult } from '../types';

export interface AuditOptions {
  strict?: boolean;
  step?: number;
  /** 跳过运行时全轴扫描（快速语法 audit） */
  syntaxOnly?: boolean;
}

interface PurityFinding {
  code: string;
  file: string;
  line: number;
  token: string;
  message: string;
}

const PURITY_RULES: Array<{ code: string; re: RegExp; message: string; allowComment: string }> = [
  { code: 'L-PURE-001', re: /\bMath\.random\b|crypto\.getRandomValues/, message: '禁止非确定性随机（用 rng(channel,index)）', allowComment: 'kine-purity-allow' },
  { code: 'L-PURE-003', re: /\bDate\.now\b|performance\.now|\bnew Date\s*\(/, message: '禁止墙钟时间（渲染只依赖 T）', allowComment: 'kine-purity-allow' },
  { code: 'L-PURE-004', re: /\.style\.animation\b|@keyframes\b/, message: '禁止 CSS 自走动画（仅由 jump(T) 驱动）', allowComment: 'kine-purity-allow' },
];

function scanPurity(): PurityFinding[] {
  const out: PurityFinding[] = [];
  const root = kineRepoRoot();
  for (const pkg of ['runtime', 'widgets']) {
    const dir = join(root, 'packages', pkg, 'src');
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir, { recursive: true })) {
      const name = String(f);
      if (!name.endsWith('.ts')) continue;
      const abs = join(dir, name);
      const src = readFileSync(abs, 'utf8');
      const lines = src.split(/\r?\n/);
      lines.forEach((line, i) => {
        const allow = line.includes('kine-purity-allow');
        // 去掉注释部分再匹配（规则说明文字本身不算违规）
        const code = line.replace(/\/\/.*$/, '').replace(/\/\*.*?\*\//g, '');
        if (!code.trim()) return;
        for (const rule of PURITY_RULES) {
          if (allow) continue;
          const m = rule.re.exec(code);
          if (m) {
            out.push({
              code: rule.code,
              file: `${pkg}/src/${name}`,
              line: i + 1,
              token: m[0],
              message: rule.message,
            });
          }
          rule.re.lastIndex = 0;
        }
      });
    }
  }
  return out;
}

export async function toolAudit(ctx: AgentContext, opts: AuditOptions = {}): Promise<ToolResult> {
  const t0 = Date.now();
  const step = opts.step ?? 0.25;

  // ---- ① syntax：fresh 编译 + lint
  let comp;
  try {
    comp = ctx.compile({ fresh: true, strict: opts.strict });
  } catch (e) {
    const err = e as { code?: string; message?: string; issues?: Issue[] };
    const issues = err.issues ?? [];
    return fail('audit', err.code ?? 'E-SCHEMA-001', err.message ?? String(e), {
      verdict: 'FAIL',
      facts: issues.slice(0, 20).map((i) => `[${i.code}] ${i.message}${i.where?.line ? ` @ ${i.where.file}:${i.where.line}` : ''}`),
      hints: ['先修语法层错误（它可能伪装成运行时 FATAL）'],
    });
  }
  const syntaxIssues: Issue[] = [...comp.issues, ...comp.lintIssues];
  const syntaxErrors = syntaxIssues.filter((i) => i.severity === 'error');

  // ---- ①b W-WIDGET-001：widget props 未知键静态检查（对照 @kine/widgets WIDGET_META；反馈：props 只能读源码）
  const wWidget: Array<{ code: string; message: string; scene: string; layer: string; prop: string; hint: string }> = [];
  try {
    const rawScenes = ((comp.loaded.raw as { scenes?: Array<Record<string, unknown>> } | undefined)?.scenes) ?? [];
    for (const sc of rawScenes) {
      const sid = String(sc.id ?? '?');
      const layers = (sc.layers as Array<Record<string, unknown>> | undefined) ?? [];
      for (const ly of layers) {
        if (ly.kind !== 'widget') continue;
        const widget = String(ly.widget ?? '');
        const meta = WIDGET_META[widget];
        if (!meta) continue; // 未注册 widget 由运行时（占位框）报出，静态层不重复
        const props = (ly.props as Record<string, unknown> | undefined) ?? {};
        const known = new Set(meta.props.map((p) => p.name));
        for (const k of Object.keys(props)) {
          if (!known.has(k)) {
            wWidget.push({
              code: 'W-WIDGET-001',
              message: `${widget} 不认识 props.${k}（将被忽略）— scene=${sid} layer=${String(ly.id ?? '?')}`,
              scene: sid,
              layer: String(ly.id ?? '?'),
              prop: k,
              hint: `kine widgets info ${widget} 查看支持参数：${meta.props.map((p) => p.name).join(' / ') || '（无 props）'}`,
            });
          }
        }
      }
    }
  } catch {
    // 静态扫描失败不阻塞 audit
  }

  // ---- ② purity lint（widget/runtime 源码扫描）
  const purity = scanPurity();

  // ---- ③ runtime：0.25s 步进全轴
  const ir = comp.ir;
  const runtimeErrors: Array<{ T: number; t: number; scene: string; message: string }> = [];
  let steps = 0;
  if (!opts.syntaxOnly && syntaxErrors.length === 0) {
    const defaults = renderDefaults(ir, ctx.store.root);
    let session = null as Awaited<ReturnType<typeof openRenderSession>> | null;
    try {
      ctx.progress('audit', `运行时全轴扫描（T 0 → ${ir.time.map.durationT.toFixed(1)}s，步进 ${step}s）…`);
      session = await openRenderSession(ir, { ...defaults, tag: 'audit' });
      const errs = await session.scan(0, ir.time.map.durationT, step);
      steps = Math.floor(ir.time.map.durationT / step) + 1;
      for (const e of errs) {
        // scan 的 t 字段是 T 值；换算成成片秒与幕
        const clampT = Math.min(e.t, ir.time.map.durationT - 1e-6);
        runtimeErrors.push({
          T: e.t,
          t: TtoT(ir.time.map, clampT),
          scene: sceneAtT(ir.time.map, clampT).id,
          message: e.message,
        });
      }
    } catch (e) {
      runtimeErrors.push({ T: -1, t: -1, scene: '-', message: `audit 运行时会话失败：${e instanceof Error ? e.message : String(e)}` });
    } finally {
      if (session) await session.close().catch(() => undefined);
    }
  } else if (syntaxErrors.length > 0) {
    // 语法错时不做运行时扫描（避免伪 FATAL 噪音）
  }

  const errorCount = syntaxErrors.length + purity.length + runtimeErrors.length;
  const warns = syntaxIssues.filter((i) => i.severity === 'warn');
  const ms = Date.now() - t0;
  const pass = errorCount === 0;

  const data = {
    verdict: pass ? 'PASS' : 'FAIL',
    counts: { syntax: syntaxErrors.length, purity: purity.length, runtime: runtimeErrors.length, warnings: warns.length + wWidget.length },
    syntaxErrors: syntaxErrors.slice(0, 50).map((i) => ({
      code: i.code,
      message: i.message,
      where: i.where,
      hints: i.hints,
    })),
    purity,
    runtimeErrors: runtimeErrors.slice(0, 50),
    warnings: [
      ...warns.slice(0, 50).map((i) => ({ code: i.code, message: i.message, where: i.where })),
      ...wWidget.slice(0, 20).map((w2) => ({ code: w2.code, message: w2.message, where: { scene: w2.scene, layer: w2.layer, prop: w2.prop }, hints: [w2.hint] })),
    ],
    steps,
    ms,
  };

  const facts: string[] = [
    `语法层：错误 ${syntaxErrors.length} / 警告 ${warns.length}`,
    `purity 扫描：${purity.length} 个违规（runtime/widgets 源码）`,
    opts.syntaxOnly ? '运行时：已跳过（--syntax-only）' : `运行时：${steps} 步全轴扫描，错误 ${runtimeErrors.length}`,
    pass ? `audit PASS（${ms}ms）` : `audit FAIL：共 ${errorCount} 个错误`,
  ];
  if (wWidget.length > 0) {
    facts.push(`W-WIDGET-001：${wWidget.length} 个 widget props 未知键（将被静默忽略）`);
    for (const w2 of wWidget.slice(0, 5)) facts.push(`  ${w2.message} → ${w2.hint}`);
  }
  for (const e of runtimeErrors.slice(0, 5)) {
    facts.push(`E-RUNTIME @ t=${e.t.toFixed(2)}s scene=${e.scene}: ${e.message}`);
  }
  for (const p of purity.slice(0, 5)) {
    facts.push(`${p.code} ${p.file}:${p.line} — ${p.message}`);
  }
  if (syntaxErrors.length > 0) {
    for (const e of syntaxErrors.slice(0, 5)) {
      facts.push(`[${e.code}] ${e.message}${e.where?.line ? ` @ timeline.yaml:${e.where.line}` : ''}`);
    }
  }

  return ok('audit', data, {
    verdict: pass ? 'PASS' : 'FAIL',
    facts,
    hints: pass
      ? ['audit 通过：可执行 kine check（断言集）']
      : [
          'E-RUNTIME 类错误：用 probe 定位该 t；E-PURE：改源码消除违规；语法错：修 timeline.yaml',
          'audit 内部顺序固定：先 syntax 后 runtime（防伪 FATAL）',
        ],
    nextActions: pass
      ? [{ tool: 'kine.check', args: {}, reason: '运行断言集' }]
      : [{ tool: 'kine.probe', args: { at: runtimeErrors[0]?.t ?? 0 }, reason: '定位首个运行时错误' }],
  });
}
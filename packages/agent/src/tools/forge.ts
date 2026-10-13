// @kine/agent — forge：创作层（M11a）
//
// 创作与注册分离：create/save 自由创作（draft 即可被 library:// 引用使用）；
// register 只做「自动验证」，通过才入册（library），失败不阻断创作（保持 draft）。
// 可创作对象（kind）：theme / palette / layout / blueprint / preset / sfx-preset / music-preset / xf-suite / kit
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  addLibraryEntry,
  kineLibraryRoot,
  listLibraryEntries,
  resolveLibraryEntry,
  type LibraryKind,
} from '@kine/store';
import { getKinePy } from '@kine/store';
import { capturePngs, ensureDir, renderDefaults } from '@kine/render';
import { SYNTH_PARAM_KEYS, SFX_NAMES, TRANSITION_NAMES, loadAndCompile, validatePaletteData } from '@kine/dsl';
import { WIDGET_NAMES } from '@kine/widgets';
import type { AgentContext } from '../context';
import { fail, ok, type ToolResult } from '../types';

export const FORGE_KINDS = [
  'theme',
  'palette',
  'layout',
  'blueprint',
  'preset',
  'sfx-preset',
  'music-preset',
  'xf-suite',
  'kit',
] as const;
export type ForgeKind = (typeof FORGE_KINDS)[number];

export interface ForgeArgs {
  action: 'create' | 'save' | 'list' | 'register';
  kind?: ForgeKind;
  name?: string;
  ref?: string;
  file?: string;
  tags?: string[];
  ns?: 'core' | 'ai' | 'usr';
  visual?: boolean;
  force?: boolean;
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function skeleton(kind: ForgeKind, name: string): Record<string, unknown> {
  const colors = {
    bg: ['#060609', '#0a0a12'],
    text: '#e8e8ea',
    text_dim: '#9a9aa2',
    accent: '#ff2e3f',
  };
  switch (kind) {
    case 'theme':
    case 'palette':
      return { ...colors, name };
    case 'layout':
      return { safe_margin: 0.095, grid: { cols: 12, rows: 8 } };
    case 'blueprint':
      return {
        scenes: [{ id: 'main', dur: 6, layers: [{ kind: 'particles', id: 'p_far', depth: 'far' }] }],
        pace: [{ id: 'full', until: 6, ratio: 1 }],
      };
    case 'preset':
      return { widget: 'bdTerminal', props: {} };
    case 'sfx-preset':
      return { events: [{ at: 0.5, sfx: 'glitch', gain: 0.7, bus: 'hits' }] };
    case 'music-preset':
      return { analyzer: 'kine-music/1' };
    case 'xf-suite':
      return { transitions: ['wipe_redbar', 'wipe_h'] };
    case 'kit':
      return { items: [] };
  }
}

/** 静态校验：返回 { errors, warnings } */
export function validateForgeData(kind: ForgeKind, data: unknown): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!isObj(data)) return { errors: ['数据必须是对象（YAML 映射）'], warnings: [] };

  const checkHex = (v: unknown, label: string) => {
    if (typeof v !== 'string' || !HEX_RE.test(v)) errors.push(`${label} 必须是 #rrggbb 颜色`);
  };
  const checkBg = (v: unknown) => {
    if (!Array.isArray(v) || v.length !== 2 || !v.every((x) => typeof x === 'string' && HEX_RE.test(x))) {
      errors.push('bg 必须是两个 #rrggbb 组成的数组');
      return;
    }
    // v6：dark/light 分流校验与 dsl/palette.ts 的 validatePaletteData 共用（此前只看 max>32，浅色色板注册不了）
    for (const issue of validatePaletteData({ bg: v, text: data.text, mode: data.mode })) {
      errors.push(`${issue.message}（${issue.code}）`);
    }
  };

  if (kind === 'palette' || kind === 'theme') {
    checkBg(data.bg);
    if (data.mode !== undefined && data.mode !== 'light' && data.mode !== 'dark') {
      errors.push("mode 仅支持 'light' 或 'dark'");
    }
    if (kind === 'theme') {
      // theme 只约束显式给出的字段；缺省部分由规格默认值补齐
      if (data.text !== undefined) checkHex(data.text, 'text');
      if (data.text_dim !== undefined) checkHex(data.text_dim, 'text_dim');
    }
    checkHex(data.accent, 'accent');
    const sec = data.accent_secondary;
    if (sec !== undefined) {
      if (!isObj(sec)) errors.push('accent_secondary 必须是对象');
      else {
        checkHex(sec.color, 'accent_secondary.color');
        if (typeof sec.max_frames === 'number' && sec.max_frames > 2) {
          errors.push('accent_secondary.max_frames 不得超过 2（唯一例外：glitch 色差）');
        }
      }
    }
    const post = data.post;
    if (post !== undefined) {
      if (!isObj(post)) errors.push('post 必须是对象');
      else {
        const vg = post.vignette;
        if (isObj(vg) && typeof vg.max === 'number' && vg.max > 0.9) errors.push('post.vignette.max ≤ 0.90');
        const sc = post.scanline;
        if (isObj(sc) && typeof sc.max === 'number' && sc.max > 0.12) errors.push('post.scanline.max ≤ 0.12');
        const fl = post.flash;
        if (isObj(fl)) {
          if (typeof fl.max_alpha === 'number' && fl.max_alpha > 0.085) errors.push('post.flash.max_alpha ≤ 0.085');
          if (fl.mode === 'env') errors.push('post.flash.mode 不得为 env（灰白病根因，E-AUD-003）');
        }
      }
    }
  } else if (kind === 'sfx-preset') {
    const evs = data.events;
    if (!Array.isArray(evs) || evs.length === 0) errors.push('events 必须是非空数组');
    else {
      evs.forEach((ev, i) => {
        if (!isObj(ev)) {
          errors.push(`events[${i}] 必须是对象`);
          return;
        }
        if (typeof ev.sfx !== 'string' || !(SFX_NAMES as readonly string[]).includes(ev.sfx)) {
          errors.push(`events[${i}].sfx 未知（可用：${SFX_NAMES.join(' / ')}）`);
        } else if (isObj(ev.params)) {
          const allowed = SYNTH_PARAM_KEYS[ev.sfx as keyof typeof SYNTH_PARAM_KEYS] ?? [];
          for (const k of Object.keys(ev.params)) {
            if (!(allowed as readonly string[]).includes(k)) errors.push(`events[${i}].params.${k} 不被 ${ev.sfx} 识别（W-SYNTH-001）`);
          }
          if (ev.sfx === 'piano_motif' && typeof ev.params.gain === 'number' && ev.params.gain > 0.5) {
            warnings.push(`events[${i}].params.gain>0.5 将被内部上限覆盖（W-SYNTH-002）`);
          }
        }
        if (typeof ev.gain === 'number' && (ev.gain < 0 || ev.gain > 1)) warnings.push(`events[${i}].gain 建议 0..1`);
      });
    }
  } else if (kind === 'blueprint') {
    const scenes = data.scenes;
    if (!Array.isArray(scenes) || scenes.length === 0) errors.push('scenes 必须是非空数组');
    else {
      scenes.forEach((sc, i) => {
        if (!isObj(sc)) errors.push(`scenes[${i}] 必须是对象`);
        else {
          if (typeof sc.id !== 'string' || sc.id.length === 0) errors.push(`scenes[${i}].id 缺失`);
          if (typeof sc.dur !== 'number' || !(sc.dur > 0)) errors.push(`scenes[${i}].dur 必须是正数`);
        }
      });
    }
  } else if (kind === 'preset') {
    if (typeof data.widget !== 'string' || data.widget.length === 0) errors.push('widget 字段缺失（widget 名称）');
    else if (!(WIDGET_NAMES as readonly string[]).includes(data.widget) && !data.widget.startsWith('custom.')) {
      warnings.push(`widget "${data.widget}" 不在当前注册表（自定义 pack 可忽略此提示）`);
    }
    if (data.props !== undefined && !isObj(data.props)) errors.push('props 必须是对象');
  } else if (kind === 'xf-suite') {
    const list = data.transitions;
    if (!Array.isArray(list) || list.length === 0) errors.push('transitions 必须是非空数组（内置 15 种名称）');
    else {
      list.forEach((t, i) => {
        if (typeof t !== 'string' || !(TRANSITION_NAMES as readonly string[]).includes(t)) {
          errors.push(`transitions[${i}]="${String(t)}" 不是内置转场（禁自造：${TRANSITION_NAMES.join(' / ')}）`);
        }
      });
    }
  } else if (kind === 'kit') {
    if (data.items !== undefined && !Array.isArray(data.items)) errors.push('items 必须是数组');
  }
  return { errors, warnings };
}

/** 自动标签：主色相桶（AI 可后续覆盖） */
function autoColorTags(kind: ForgeKind, data: unknown): string[] {
  if ((kind !== 'palette' && kind !== 'theme') || !isObj(data) || typeof data.accent !== 'string') return [];
  const c = data.accent;
  if (!HEX_RE.test(c)) return [];
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const s = max === min ? 0 : (max - min) / (1 - Math.abs(2 * l - 1));
  let h = 0;
  if (max !== min) {
    if (max === r) h = ((g - b) / (max - min) + 6) % 6;
    else if (max === g) h = (b - r) / (max - min) + 2;
    else h = (r - g) / (max - min) + 4;
    h *= 60;
  }
  const bucket =
    s < 0.15 ? 'neutral' : h < 15 || h >= 345 ? 'red' : h < 45 ? 'orange' : h < 70 ? 'yellow' : h < 165 ? 'green' : h < 200 ? 'cyan' : h < 260 ? 'blue' : h < 300 ? 'purple' : 'magenta';
  return [bucket];
}

/** 视觉门槛（--visual）：用临时探针工程渲 1 帧，检查 black_level / density / edge_band */
async function visualGate(ctx: AgentContext, entryId: string, accent: string): Promise<{ ok: boolean; facts: string[]; errors: string[] }> {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'kine-forge-probe-'));
  const facts: string[] = [];
  const errors: string[] = [];
  try {
    const yaml = [
      'schema: kine/1',
      `project: { id: probe, title: palette-probe, version: v0.1, seed: 7 }`,
      `output: { width: 1920, height: 1080, fps: 60, duration: 6 }`,
      'theme:',
      '  profile: extended',
      `  palette: library://${entryId}`,
      `  accent: ${accent}`,
      'pace:',
      '  segments: [{ id: full, until: 6, ratio: 1 }]',
      'scenes:',
      '  - id: main',
      '    dur: 6',
      '    layers:',
      '      - { kind: particles, id: p_far, depth: far, count: 80 }',
      '      - { kind: widget, id: term, widget: bdTerminal, place: { x: 960, y: 540, w: 900, h: 520, anchor: center } }',
    ].join('\n');
    const file = path.join(tmp, 'timeline.yaml');
    ensureDir(tmp);
    writeFileSync(file, yaml, 'utf8');
    const comp = loadAndCompile(file, { projectDir: tmp });
    if (comp.issues.some((i) => i.severity === 'error')) {
      errors.push(`探针工程编译失败：${comp.issues.find((i) => i.severity === 'error')?.message ?? '未知'}`);
      return { ok: false, facts, errors };
    }
    const ir = comp.ir;
    const f = ir.scenes[0]!.frame0 + Math.floor(0.62 * (ir.scenes[0]!.frame1 - ir.scenes[0]!.frame0));
    const shots = await capturePngs(ir, [f], { ...renderDefaults(ir, tmp), outDir: path.join(tmp, 'shots'), prefix: 'probe' });
    const png = shots[0]?.file;
    if (!png) {
      errors.push('探针渲染未产出帧');
      return { ok: false, facts, errors };
    }
    const py = await getKinePy();
    const bl = (await py.call('black_level', { png })) as { value: number };
    const dn = (await py.call('density', { png })) as { value: number };
    const eb = (await py.call('edge_band', { png })) as { value: number };
    facts.push(`black_level ${bl.value.toFixed(2)}（目标 6..9）`, `density ${(dn.value * 100).toFixed(2)}%（≥0.9）`, `edge_band ${(eb.value * 100).toFixed(2)}%（≤60）`);
    if (bl.value > 9.5) errors.push(`black_level ${bl.value.toFixed(2)} 偏亮（防灰白病）`);
    if (bl.value < 5) errors.push(`black_level ${bl.value.toFixed(2)} 死黑`);
    if (dn.value < 0.009) errors.push(`density ${(dn.value * 100).toFixed(2)}% 低于 0.9%`);
    if (eb.value > 0.6) errors.push(`edge_band ${(eb.value * 100).toFixed(2)}% 超过 60%`);
    return { ok: errors.length === 0, facts, errors };
  } catch (e) {
    errors.push(`视觉门槛执行失败：${(e as Error).message}`);
    return { ok: false, facts, errors };
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* 临时目录清理失败不阻断 */
    }
  }
}

export async function toolForge(ctx: AgentContext, args: ForgeArgs): Promise<ToolResult<unknown>> {
  const root = kineLibraryRoot();
  const action = args.action;

  if (action === 'create') {
    if (!args.kind || !FORGE_KINDS.includes(args.kind)) {
      return fail('forge', 'E-LIB-021', `create 需要 --kind ∈ {${FORGE_KINDS.join(' / ')}}`);
    }
    const name = args.name;
    if (!name) return fail('forge', 'E-LIB-021', 'create 需要 --name');
    let data: unknown = skeleton(args.kind, name);
    if (args.file) {
      const text = readFileSync(resolveForgeFile(args.file, ctx), 'utf8');
      data = parseYaml(text);
      const { errors } = validateForgeData(args.kind, data);
      if (errors.length > 0) {
        return fail('forge', 'E-LIB-022', `创作数据未通过结构校验（${errors.length} 项）`, { facts: errors, hints: ['修正后重跑；draft 阶段允许不完整——register 才会正式校验'] });
      }
    }
    const entry = await addLibraryEntry(root, {
      name,
      kind: args.kind as LibraryKind,
      ns: args.ns ?? 'ai',
      tags: args.tags,
      status: 'draft',
      data,
      source: args.file ?? null,
    });
    return ok('forge', { entry }, {
      facts: [
        `已创建 draft：${entry.id}（${entry.kind} · v${entry.version}${entry.tags.length ? ' · ' + entry.tags.map((t) => '@' + t).join(' ') : ''}）`,
        `引用：library://${entry.id}`,
        `入册：kine forge register --ref ${entry.id}`,
      ],
      nextActions: [
        { tool: 'forge', args: { action: 'register', ref: entry.id } },
        { tool: 'library', args: { action: 'list', kind: entry.kind } },
      ],
    });
  }

  if (action === 'save') {
    if (!args.file) return fail('forge', 'E-LIB-021', 'save 需要 --file（YAML/JSON 创作文件）');
    const target = args.ref ?? args.name;
    if (!target) return fail('forge', 'E-LIB-021', 'save 需要 --ref（已有条目）或 --name（新建）');
    const text = readFileSync(resolveForgeFile(args.file, ctx), 'utf8');
    const data = parseYaml(text);
    const existing = resolveLibraryEntry(root, target);
    if (!existing.ok) {
      if (!args.kind || !FORGE_KINDS.includes(args.kind)) {
        return fail('forge', existing.error.code, `${existing.error.message}（新建时请一并给出 --kind）`, { facts: existing.error.facts ?? [], hints: existing.error.hints ?? [] });
      }
      const entry = await addLibraryEntry(root, { name: args.name ?? target, kind: args.kind as LibraryKind, ns: args.ns ?? 'ai', tags: args.tags, status: 'draft', data, source: args.file });
      return ok('forge', { entry }, { facts: [`已新建 draft：${entry.id}（v${entry.version}）`, `引用：library://${entry.id}`] });
    }
    const e = existing.entry;
    const kind = (args.kind ?? e.kind) as ForgeKind;
    if (!FORGE_KINDS.includes(kind)) return fail('forge', 'E-LIB-020', `条目 ${e.id} 不是创作类（kind=${e.kind}）`);
    const { errors } = validateForgeData(kind, data);
    const wasLibrary = e.status === 'library';
    const entry = await addLibraryEntry(root, { name: e.name, kind: kind as LibraryKind, id: e.id, tags: args.tags ?? e.tags, status: 'draft', data, source: args.file });
    return ok('forge', { entry }, {
      facts: [
        `已保存 ${entry.id} → v${entry.version}（draft）`,
        wasLibrary ? '原为已入册条目：已回到 draft，需重新 register' : '仍为 draft；register 才会入册',
        ...(errors.length > 0 ? [`结构提醒 ${errors.length} 项（register 时会拦截）`] : []),
      ],
      nextActions: [{ tool: 'forge', args: { action: 'register', ref: entry.id } }],
    });
  }

  if (action === 'list') {
    const all = listLibraryEntries(root, { kind: args.kind as LibraryKind | undefined });
    const forged = all.filter((e) => (FORGE_KINDS as readonly string[]).includes(e.kind));
    const facts = forged.slice(0, 40).map((e) => `${e.id} · ${e.kind} · ${e.status === 'draft' ? 'draft' : 'library'} · v${e.version}${e.tags.length ? ' · ' + e.tags.map((t) => '@' + t).join(' ') : ''}`);
    return ok('forge', { entries: forged }, {
      facts: forged.length === 0 ? ['（尚无创作条目）用 kine forge create --kind palette --name my-01 开始'] : [`共 ${forged.length} 个创作条目：`, ...facts],
      nextActions: [{ tool: 'forge', args: { action: 'create', kind: 'palette', name: 'my-palette' } }],
    });
  }

  if (action === 'register') {
    if (!args.ref) return fail('forge', 'E-LIB-021', 'register 需要 --ref');
    const res = resolveLibraryEntry(root, args.ref);
    if (!res.ok) return fail('forge', res.error.code, res.error.message, { facts: res.error.facts ?? [], hints: res.error.hints ?? [] });
    const e = res.entry;
    const kind = e.kind as ForgeKind;
    if (!FORGE_KINDS.includes(kind)) return fail('forge', 'E-LIB-020', `条目 ${e.id} 不是创作类（kind=${e.kind}）`);
    const { errors, warnings } = validateForgeData(kind, e.data);
    const facts: string[] = [`条目 ${e.id}（${kind} · v${e.version}）`];
    if (errors.length > 0) {
      return fail('forge', 'E-LIB-023', `注册校验未通过（${errors.length} 项）——保持 draft，不阻断创作`, {
        facts: [...facts, ...errors.map((x) => `✖ ${x}`)],
        hints: ['修正数据后 kine forge save --ref … --file …，再 register'],
        verdict: 'FAIL',
      });
    }
    const isStyle = kind === 'palette' || kind === 'theme';
    if (args.visual === true && isStyle) {
      const accent = isObj(e.data) && typeof e.data.accent === 'string' ? e.data.accent : '#ff2e3f';
      const vg = await visualGate(ctx, e.id, accent);
      facts.push(...vg.facts);
      if (!vg.ok) {
        return fail('forge', 'E-LIB-024', '视觉门槛未通过——保持 draft', {
          facts: [...facts, ...vg.errors.map((x) => `✖ ${x}`)],
          hints: ['修正调色后重试；或先不入册，draft 仍可被 library:// 引用'],
          verdict: 'FAIL',
        });
      }
    } else if (isStyle) {
      facts.push('静态校验通过（视觉门槛未启用；入册前建议 --visual 跑黑电平/密度/边缘带）');
    }
    if (warnings.length > 0) facts.push(...warnings.map((x) => `⚠ ${x}`));
    const entry = await addLibraryEntry(root, {
      name: e.name,
      kind: e.kind,
      id: e.id,
      tags: [...new Set([...e.tags, ...autoColorTags(kind, e.data)])],
      status: 'library',
    });
    facts.push(`已入册：${entry.id} · v${entry.version} · ${entry.tags.map((t) => '@' + t).join(' ')}`);
    return ok('forge', { entry }, {
      verdict: 'PASS',
      facts,
      nextActions: [
        { tool: 'library', args: { action: 'list', kind: entry.kind } },
        { tool: 'style', args: { action: 'apply', ref: `library://${entry.id}` } },
      ],
    });
  }

  return fail('forge', 'E-LIB-021', `未知 action "${String(action)}"（create/save/list/register）`);
}

function resolveForgeFile(file: string, ctx: AgentContext): string {
  const base = process.env.KINE_CWD ?? process.cwd();
  const first = path.isAbsolute(file) ? file : path.resolve(base, file);
  if (existsSync(first)) return first;
  return path.isAbsolute(file) ? file : path.resolve(ctx.dir, file);
}

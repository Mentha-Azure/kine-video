// @kine/dsl — lint：踩坑防护规则（09-踩坑防护 §9.5）
import type { Issue } from './errors';
import { KNOWN_KEYS, SYNTH_PARAM_KEYS, validateSynthParamValue, type ProjectSpecT } from './schema';
import type { LineLookup } from './load';
import { kineHomeDir, resolveLibraryRefLite } from './library';
import { applyPalette, CORE_PALETTE, resolvePalette, type PaletteSpec } from './palette';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export interface LintOptions {
  file: string;
  lineOf?: LineLookup;
  /** --strict：W-* 升级为 error */
  strict?: boolean;
}

function loc(opts: LintOptions, path: (string | number)[]): { file: string; line?: number; path: string } {
  return { file: opts.file, line: opts.lineOf?.(path), path: path.join('.') };
}

// ---------------------------------------------------------------- 未知字段检测
interface UnknownHit { path: (string | number)[]; key: string; shape: string }

function scanUnknown(node: unknown, shape: string, path: (string | number)[], hits: UnknownHit[]): void {
  if (node == null) return;
  if (Array.isArray(node)) {
    const itemShape = shapeEndingArrayShape(shape);
    node.forEach((it, i) => scanUnknown(it, itemShape, [...path, i], hits));
    return;
  }
  if (typeof node !== 'object') return;
  const known = KNOWN_KEYS[shape];
  const obj = node as Record<string, unknown>;
  if (known) {
    for (const k of Object.keys(obj)) {
      if (!known.includes(k)) hits.push({ path, key: k, shape });
    }
  }
  const childShapes: Record<string, string> = {};
  for (const k of ['project', 'output', 'pace', 'theme', 'render', 'audio', 'scenes', 'asserts', 'camera', 'shot', 'layer', 'place', 'post', 'music', 'sfx', 'fade_out', 'accent_secondary', 'font', 'vignette', 'scanline', 'flash', 'black_level', 'scope']) {
    childShapes[k] = k;
  }
  const sub = (k: string, childShape: string) => {
    if (obj[k] !== undefined) scanUnknown(obj[k], childShape, [...path, k], hits);
  };
  switch (shape) {
    case 'root':
      sub('project', 'project'); sub('output', 'output'); sub('pace', 'pace'); sub('theme', 'theme');
      sub('render', 'render'); sub('audio', 'audio'); sub('scenes', 'scene[]'); sub('asserts', 'assert[]');
      break;
    case 'output': sub('video', 'output.video'); sub('audio', 'output.audio'); break;
    case 'pace': sub('segments', 'pace.segment[]'); break;
    case 'theme': sub('font', 'theme.font'); sub('post', 'theme.post'); sub('accent_secondary', 'theme.accent_secondary'); break;
    case 'theme.post': sub('vignette', 'theme.post.vignette'); sub('scanline', 'theme.post.scanline'); sub('flash', 'theme.post.flash'); sub('black_level', 'theme.post.black_level'); break;
    case 'audio': sub('music', 'audio.music'); sub('sfx', 'audio.sfx'); break;
    case 'audio.music': sub('fade_out', 'audio.music.fade_out'); break;
    case 'audio.sfx': sub('events', 'audio.sfx.event[]'); sub('buses', 'audio.sfx.bus[]'); break;
    case 'scene':
      sub('camera', 'camera'); sub('layers', 'layer[]'); sub('shots', 'shot[]'); sub('effects', 'scene.effect[]'); sub('post', 'scene.post'); sub('audio', 'scene.audio[]'); sub('asserts', 'assert[]');
      break;
    case 'shot': sub('transition', 'shot.transition'); sub('camera_override', 'camera'); break;
    case 'assert': sub('scope', 'assert.scope'); break;
    default:
      if (shape.startsWith('layer')) { sub('place', 'place'); sub('style', 'layer.text.style'); }
      break;
  }
}

function shapeEndingArrayShape(shape: string): string {
  if (shape.endsWith('[]')) return shape.slice(0, -2);
  return shape;
}

// ---------------------------------------------------------------- 主入口
export function lint(spec: ProjectSpecT, raw: unknown, opts: LintOptions): Issue[] {
  const issues: Issue[] = [];
  const strict = opts.strict === true;
  const push = (i: Issue & { code: string }) => {
    if (strict && i.severity === 'warn') i = { ...i, severity: 'warn', code: i.code, hints: [...(i.hints ?? []), '--strict 模式下 W-* 视为 error'] };
    issues.push(i);
  };

  // ---- L-SCHEMA-001 未知字段
  const hits: UnknownHit[] = [];
  scanUnknown(raw, 'root', [], hits);
  for (const h of hits) {
    push({
      code: 'W-SCHEMA-001',
      severity: 'warn',
      message: `未知字段 "${h.key}"（shape=${h.shape}）`,
      where: loc(opts, [...h.path, h.key]),
      hints: ['未知字段不会参与渲染；确认拼写或删除'],
    });
  }

  // ---- L-ID-001 唯一性
  const seen = new Map<string, string>();
  const dup = (id: string, what: string, path: (string | number)[]) => {
    const prev = seen.get(id);
    if (prev) {
      push({
        code: 'E-ID-001',
        severity: 'error',
        message: `id "${id}" 重复（${what} 与 ${prev}）`,
        where: loc(opts, path),
        facts: [`${what} 与 ${prev} 使用同一 id`],
        hints: ['id 必须全工程唯一（P5 语义寻址依赖）'],
      });
    } else seen.set(id, what);
  };
  spec.scenes.forEach((sc, si) => {
    dup(sc.id, `scene`, ['scenes', si, 'id']);
    sc.layers.forEach((l, li) => dup(l.id, `layer@${sc.id}`, ['scenes', si, 'layers', li, 'id']));
    sc.asserts.forEach((a, ai) => dup(a.id, `assert@${sc.id}`, ['scenes', si, 'asserts', ai, 'id']));
  });
  spec.asserts.forEach((a, ai) => dup(a.id, 'assert', ['asserts', ai, 'id']));
  spec.pace.segments.forEach((s, si) => dup(s.id, 'pace segment', ['pace', 'segments', si, 'id']));
  spec.audio.sfx.buses.forEach((b, bi) => dup(b.id, 'bus', ['audio', 'sfx', 'buses', bi, 'id']));

  // ---- 事件 bus 引用
  const busIds = new Set(spec.audio.sfx.buses.map((b) => b.id));
  spec.audio.sfx.events.forEach((ev, i) => {
    if (!busIds.has(ev.bus)) {
      push({
        code: 'E-AUD-004',
        severity: 'error',
        message: `sfx 事件 bus "${ev.bus}" 未在 audio.sfx.buses 中定义`,
        where: loc(opts, ['audio', 'sfx', 'events', i, 'bus']),
        facts: [`已定义 bus：${[...busIds].join(', ')}`],
      });
    }
  });

  // ---- W-SYNTH-001 sfx 参数表校验（未知键会被合成器静默忽略 → 显式警告）
  spec.audio.sfx.events.forEach((ev, i) => {
    const allowed = SYNTH_PARAM_KEYS[ev.sfx] ?? [];
    const unknown = Object.keys(ev.params ?? {}).filter((k) => !allowed.includes(k));
    if (unknown.length > 0) {
      push({
        code: 'W-SYNTH-001',
        severity: 'warn',
        message: `sfx "${ev.sfx}" 的 params 含未知键：${unknown.join(', ')}（合成器会静默忽略）`,
        where: loc(opts, ['audio', 'sfx', 'events', i, 'params']),
        facts: [`支持：${allowed.length ? allowed.join(', ') : '（无参数）'}`],
        hints: ['拼写检查；参数表见 py/kine-py/kine_py/synth.py 与 AGENTS.md'],
      });
    }
    const pgain = ev.params?.gain;
    if (ev.sfx === 'piano_motif' && typeof pgain === 'number' && pgain > 0.5 + 1e-9) {
      push({
        code: 'W-SYNTH-002',
        severity: 'warn',
        message: `piano_motif.gain=${pgain} 超过合成器有效上限 0.5（超出部分被内部截断——静默降级）`,
        where: loc(opts, ['audio', 'sfx', 'events', i, 'params', 'gain']),
        facts: ['合成器有效区间 0–0.5（上限截断）'],
        hints: ['要更响请提升事件级 gain（混音层），而不是 params.gain'],
      });
    }
    // v3 P0-4：参数值类型/范围校验（非法值曾在 render 期才炸：notes:4 → TypeError → 无声成片）
    for (const [k, v] of Object.entries(ev.params ?? {})) {
      if (!allowed.includes(k)) continue; // 未知键已由 W-SYNTH-001 处理
      const verr = validateSynthParamValue(ev.sfx, k, v);
      if (verr) {
        push({
          code: 'E-SYNTH-001',
          severity: 'error',
          message: verr,
          where: loc(opts, ['audio', 'sfx', 'events', i, 'params', k]),
          facts: ['此类非法参数会在音频合成阶段失败（audit 期即挡下，避免 render 才发现）'],
          hints: ev.sfx === 'piano_motif' && k === 'notes' ? ['示例：notes: [220.0, 261.63, 329.63]'] : ['参数表见 AGENTS.md「SFX 合成参数速查」'],
        });
      }
    }
  });

  // ---- L-COLOR 色彩纪律前置：先解析色板得到「有效主题」（v3 P0-3：lint 与 compile 校验同一对象）
  const profile = spec.theme.profile;
  if (profile === 'core' && spec.theme.palette !== undefined) {
    push({
      code: 'E-COLOR-003', severity: 'error',
      message: `profile: core 不允许 palette（当前 ${spec.theme.palette}）——色板需 profile: extended 或 free`,
      where: loc(opts, ['theme', 'palette']),
      facts: ['core = v1 固定风格（#ff2e3f 唯一强调色）'],
      hints: ['改为 profile: extended 并保留 palette 引用'],
    });
  }
  let palette: PaletteSpec | null = null;
  if (spec.theme.palette !== undefined && profile !== 'core') {
    const pr = resolvePalette(spec.theme.palette, kineHomeDir());
    if (!pr.ok) {
      push({
        code: pr.error.code, severity: 'error',
        message: `palette "${spec.theme.palette}" 解析失败：${pr.error.message}`,
        where: loc(opts, ['theme', 'palette']),
        facts: pr.error.candidates ?? [],
        hints: ['kine library list --kind palette 查看可用色板'],
      });
    } else {
      palette = pr.palette;
    }
  }
  const effTheme = palette ? applyPalette(spec.theme, palette) : spec.theme;

  // ---- L-POST-001..004 色彩后处理硬上限（作用于有效主题：palette 可覆盖 post 默认值）
  const post = effTheme.post;
  const W = (code: string, path: (string | number)[], message: string, facts: string[], hints: string[]) => push({ code, severity: 'warn', message, where: loc(opts, path), facts, hints });
  if (palette) {
    const sameBg = palette.bg[0].toLowerCase() === CORE_PALETTE.bg[0].toLowerCase() && palette.bg[1].toLowerCase() === CORE_PALETTE.bg[1].toLowerCase();
    const sameAccent = palette.accent.toLowerCase() === CORE_PALETTE.accent.toLowerCase();
    const fontChanged = typeof palette.font === 'string' && palette.font !== spec.theme.font.family;
    if (sameBg && sameAccent && !fontChanged) {
      W('W-LIB-002', ['theme', 'palette'], `色板 "${spec.theme.palette}" 与 core 视觉完全相同（accent/bg 一致且字体未变）——profile: extended 形同虚设`, ['v3 实测：多数 extended 工程 accent 仍 #ff2e3f、字体同 core'], ['换用差异化色板（kine library list --kind palette），或回到 profile: core']);
    }
    // v4：色板生效时显式写死的 theme 颜色会被静默覆盖（实测「改了不生效、无法排查」）——必须提示
    const rawTheme = (raw as { theme?: Record<string, unknown> } | undefined)?.theme;
    if (rawTheme) {
      const overridden: string[] = [];
      if (rawTheme.bg !== undefined) {
        const bgArr = Array.isArray(rawTheme.bg) ? rawTheme.bg.map((x) => String(x).toLowerCase()) : [];
        if (bgArr.length !== 2 || bgArr[0] !== palette.bg[0].toLowerCase() || bgArr[1] !== palette.bg[1].toLowerCase()) overridden.push('bg');
      }
      for (const k of ['text', 'text_dim'] as const) {
        if (rawTheme[k] !== undefined && String(rawTheme[k]).toLowerCase() !== palette[k].toLowerCase()) overridden.push(k);
      }
      const rawSec = rawTheme.accent_secondary as { color?: unknown } | undefined;
      if (rawSec && rawSec.color !== undefined && String(rawSec.color).toLowerCase() !== palette.accent_secondary.color.toLowerCase()) overridden.push('accent_secondary');
      if (overridden.length > 0) {
        W(
          'W-COLOR-004',
          ['theme', 'palette'],
          `palette 生效中：theme.${overridden.join(' / theme.')} 的显式值会被色板覆盖（改了不生效）`,
          [`色板值：bg=${palette.bg.join('+')} text=${palette.text} text_dim=${palette.text_dim} secondary=${palette.accent_secondary.color}`],
          ['改色请改色板条目本身（kine forge save palette <name> --file …），或删除这些字段避免误导排查'],
        );
      }
    }
  }
  if (post.vignette.base > 0.20 + 1e-9) W('W-POST-001', ['theme', 'post', 'vignette', 'base'], `暗角 base=${post.vignette.base} 超过硬上限 0.20`, [`当前 ${post.vignette.base}`, '上限 0.20'], ['改为 0.20：k=clamp(.20+tw*.11+beat*.09,0,1)']);
  if (post.vignette.max > 0.90 + 1e-9) W('W-POST-001', ['theme', 'post', 'vignette', 'max'], `暗角 max=${post.vignette.max} 超过 0.90（最外圈）`, [`当前 ${post.vignette.max}`, '上限 0.90'], ['改为 0.90']);
  if (post.scanline.base > 0.085 + 1e-9) W('W-POST-002', ['theme', 'post', 'scanline', 'base'], `扫描线 base=${post.scanline.base} 超过 0.085`, [`当前 ${post.scanline.base}`, '上限 0.085'], ['改为 0.085：(≤0.085+tw*0.020)']);
  if (post.scanline.max > 0.12 + 1e-9) W('W-POST-002', ['theme', 'post', 'scanline', 'max'], `扫描线 max=${post.scanline.max} 超过硬上限 0.12`, [`当前 ${post.scanline.max}`, '上限 0.12'], ['改为 0.12']);
  if (post.flash.max_alpha > 0.085 + 1e-9) W('W-POST-003', ['theme', 'post', 'flash', 'max_alpha'], `强拍白闪 max_alpha=${post.flash.max_alpha} 超过 0.085`, [`当前 ${post.flash.max_alpha}`, '上限 0.085'], ['改为 0.085（瞬态驱动）']);
  if (post.flash.mode === 'env') {
    push({
      code: 'E-AUD-003', severity: 'error',
      message: '强拍提亮禁止由能量包络（env）驱动：历史灰白病根因（LOC.energy 常年 0.87 → 整屏发灰，黑电平 RGB(6,6,8)→(28,28,32)）',
      where: loc(opts, ['theme', 'post', 'flash', 'mode']),
      facts: ['必须用瞬态驱动：GATE .005 / GAIN 130 / DECAY .80 的 flash²'],
      hints: ["改为 mode: transient（或删除该字段，默认即 transient）"],
    });
  }
  if (post.black_level.rgb_min < 6 || post.black_level.rgb_max > 9) W('W-POST-004', ['theme', 'post', 'black_level'], `黑电平窗口 [${post.black_level.rgb_min}, ${post.black_level.rgb_max}] 超出规范 [6, 9]`, [`当前 [${post.black_level.rgb_min}, ${post.black_level.rgb_max}]`], ['背景 RGB 应在 6–9 之间（防发灰/死黑）']);

  // ---- L-COLOR-001..003 强调色一致性（色板已在前置块解析）
  const expectedAccent = palette ? palette.accent.toLowerCase() : '#ff2e3f';
  if (spec.theme.accent.toLowerCase() !== expectedAccent) {
    push({
      code: 'E-COLOR-001', severity: 'error',
      message: palette
        ? `extended 模式下强调色必须来自色板（${palette.accent}），当前 ${spec.theme.accent}`
        : `唯一强调色必须为 #ff2e3f，当前 ${spec.theme.accent}`,
      where: loc(opts, ['theme', 'accent']),
      hints: [palette ? '与色板保持一致（layer 颜色也应同源）' : '不允许第二强调色（风格六不做）；或声明 profile: extended + palette'],
    });
  }
  const sec = spec.theme.accent_secondary;
  const expectedSec = palette ? palette.accent_secondary : { color: '#4da3ff', max_frames: 2 };
  if (sec.color.toLowerCase() !== expectedSec.color.toLowerCase() || sec.max_frames > expectedSec.max_frames) {
    push({
      code: 'E-COLOR-001', severity: 'error',
      message: `第二色只允许 ${expectedSec.color} 且仅 glitch 色差 ≤${expectedSec.max_frames} 帧（当前 ${sec.color} / max_frames=${sec.max_frames}）`,
      where: loc(opts, ['theme', 'accent_secondary']),
    });
  }
  // v5：地色模式——dark：通道 ≤32（防发灰）；light：通道 ≥180 + 正文对比度（E-COLOR-005）
  const groundMode: string = (effTheme as { mode?: string }).mode ?? 'dark';
  for (const [i, c] of effTheme.bg.entries()) {
    const rgb = hexToRgb(c);
    if (groundMode === 'light') {
      if (Math.min(rgb.r, rgb.g, rgb.b) < 180) {
        push({
          code: 'E-COLOR-002', severity: 'error',
          message: `浅色模式背景 ${c} 过暗（通道应 ≥180）`,
          where: loc(opts, ['theme', 'bg', i]),
          facts: [`RGB=${rgb.r},${rgb.g},${rgb.b}`, 'light 模式 = 浅底深字；指标按浅底口径采样（black_level 报告白电平）'],
          hints: ['深底请去掉 theme.mode: light（或色板 mode: light）'],
        });
      }
    } else if (Math.max(rgb.r, rgb.g, rgb.b) > 32) {
      push({
        code: 'E-COLOR-002', severity: 'error',
        message: `背景色 ${c} 过亮（通道应 ≤32，防发灰；实际黑电平由 black_level 指标在成片帧上把关）`,
        where: loc(opts, ['theme', 'bg', i]),
        facts: [`RGB=${rgb.r},${rgb.g},${rgb.b}`, '目标黑电平 6–9（渲染后可测）'],
        hints: ['浅色需求请声明 theme.mode: light（v5）'],
      });
    }
  }
  if (groundMode === 'light') {
    const relLum = (c: string): number => {
      const { r, g, b } = hexToRgb(c);
      const f = (x: number) => {
        const y = x / 255;
        return y <= 0.03928 ? y / 12.92 : Math.pow((y + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    for (const c of effTheme.bg) {
      const t = relLum(effTheme.text);
      const b2 = relLum(c);
      const ratio = (Math.max(t, b2) + 0.05) / (Math.min(t, b2) + 0.05);
      if (ratio < 4.5) {
        push({
          code: 'E-COLOR-005', severity: 'error',
          message: `浅色模式正文对比度不足（${ratio.toFixed(2)}:1 < 4.5:1；text ${effTheme.text} vs bg ${c}）`,
          where: loc(opts, ['theme', 'text']),
          facts: ['WCAG 相对亮度对比（正文 4.5:1 为常规可读下限）'],
          hints: ['调深 text 或调浅 bg'],
        });
      }
    }
  }

  // ---- L-FONT-001
  if (!/mono/i.test(effTheme.font.family)) {
    W('W-FONT-001', ['theme', 'font', 'family'], `字体族 "${spec.theme.font.family}" 未声明等宽字体`, ['全站统一等宽字体'], ['family 应包含 monospace/等宽族名']);
  }

  // ---- W-TEXT-001 文本插值占位符（v4：{frame}/{t}/{T}/{lt}；未知占位符会按字面显示）
  const INTERP_OK = /^\{(frame|t|T|lt)(?::\.[0-9]f)?\}$/;
  spec.scenes.forEach((sc, si) => {
    sc.layers.forEach((ly, li) => {
      if (ly.kind !== 'text') return;
      const content = String(ly.content ?? '');
      if (!content.includes('{')) return;
      const toks = content.match(/\{[^{}]*\}/g) ?? [];
      const bad = toks.filter((t2) => !INTERP_OK.test(t2));
      if (bad.length > 0) {
        W('W-TEXT-001', ['scenes', si, 'layers', li, 'content'], `未知文本占位符 ${bad.join('、')} 将按字面显示`, ['支持：{frame}（帧号）、{t}/{T}/{lt}（秒，可带格式如 {t:.2f}）'], ['检查拼写；受支持列表：{frame} {t} {T} {lt}']);
      }
    });
  });

  // ---- v5：资产/字幕通路检查（反馈：image/video 静默失败，引擎服务不了的层必须报出）
  const projDir = opts.file ? dirname(resolve(opts.file)) : process.cwd();
  spec.scenes.forEach((sc, si) => {
    sc.layers.forEach((ly, li) => {
      if (ly.kind === 'video') {
        push({
          code: 'E-ASSET-002', severity: 'error',
          message: `video 图层（scene=${sc.id} layer=${ly.id}）当前版本无加载通路——请改用 image 或序列帧`,
          where: loc(opts, ['scenes', si, 'layers', li, 'kind']),
          facts: ['image 已接资产管线（v5）；video 缺确定性丢帧方案'],
          hints: ['序列帧 = 多张 image + window；或关注后续版本 video 支持'],
        });
      }
      if (ly.kind === 'image') {
        const src = String(ly.src ?? '');
        let okAsset = true;
        let detail = '';
        if (src.startsWith('library://')) {
          const r2 = resolveLibraryRefLite(src, kineHomeDir());
          okAsset = !('error' in r2) && Boolean((r2 as { file: string | null }).file);
          detail = okAsset ? `库文件 ${(r2 as { file: string }).file}` : 'error' in r2 ? r2.error.message : '库条目无 blob';
        } else {
          const abs = resolve(projDir, src);
          okAsset = existsSync(abs);
          detail = abs;
        }
        if (!okAsset) {
          push({
            code: 'E-ASSET-001', severity: 'error',
            message: `image 资产不可解析：${src}（scene=${sc.id} layer=${ly.id}）`,
            where: loc(opts, ['scenes', si, 'layers', li, 'src']),
            facts: [`解析结果：${detail}`],
            hints: ['相对路径以 timeline.yaml 所在目录为基准；库资产用 library://<id> 引用'],
          });
        }
      }
      if (ly.kind === 'subtitles') {
        const cues = ly.cues ?? [];
        if (!ly.src && cues.length === 0) {
          push({
            code: 'E-ASSET-001', severity: 'error',
            message: `subtitles 层（scene=${sc.id} layer=${ly.id}）需要 src（SRT 路径）或内联 cues`,
            where: loc(opts, ['scenes', si, 'layers', li]),
          });
        }
        if (ly.src) {
          const abs = resolve(projDir, ly.src);
          if (!existsSync(abs)) {
            push({
              code: 'E-ASSET-001', severity: 'error',
              message: `字幕 SRT 不可解析：${ly.src}`,
              where: loc(opts, ['scenes', si, 'layers', li, 'src']),
              facts: [`解析结果：${abs}`],
              hints: ['相对路径以 timeline.yaml 所在目录为基准'],
            });
          }
        }
        let prevTo = -1;
        let overlaps = 0;
        for (const cu of [...cues].sort((a, b) => a.from - b.from)) {
          if (cu.to <= cu.from) {
            push({
              code: 'E-SUB-001', severity: 'error',
              message: `字幕 cue 时间非法（to ≤ from）：${cu.text.slice(0, 24)}`,
              where: loc(opts, ['scenes', si, 'layers', li, 'cues']),
            });
          }
          if (cu.from < prevTo) overlaps += 1;
          prevTo = Math.max(prevTo, cu.to);
        }
        if (overlaps > 0) {
          W('W-SUB-001', ['scenes', si, 'layers', li, 'cues'], `字幕 cue 有 ${overlaps} 处重叠（按顺序显示，后者覆盖）`, [`重叠 ${overlaps} 处`], ['整理 cues 时间轴避免重叠']);
        }
      }
    });
  });

  // ---- L-CAM-001 摄影机纪律
  spec.scenes.forEach((sc, si) => {
    const cam = sc.camera;
    if (cam.tw > 2.0 + 1e-9) {
      push({
        code: 'E-CAM-001', severity: 'error',
        message: `幕 "${sc.id}" camera.tw=${cam.tw} 超过默认上限 2.0`,
        where: loc(opts, ['scenes', si, 'camera', 'tw']),
        facts: [`tw=${cam.tw}`, '默认幅度 ≤ 源项目值/4，见 L-CAM-001'],
        hints: ['tw 一旋钮驱动震屏/暗角/扫描线/强拍提亮，无需更大'],
      });
    }
    if (cam.bpm != null && (cam.bpm < 40 || cam.bpm > 220)) {
      W('W-CAM-002', ['scenes', si, 'camera', 'bpm'], `bpm=${cam.bpm} 超出合理区间 [40,220]`, [], ['确认歌曲真实 BPM']);
    }
    if (cam.z1 < 0.5 || cam.z1 > 2.0) {
      W('W-CAM-003', ['scenes', si, 'camera', 'z1'], `z1=${cam.z1} 超出 [0.5,2.0]`, [], []);
    }
  });

  // ---- L-XF-001 & 转场完整性
  spec.scenes.forEach((sc, si) => {
    for (let i = 1; i < sc.shots.length; i++) {
      const cur = sc.shots[i].transition;
      const prev = sc.shots[i - 1].transition;
      const kindOf = (t: unknown) => (t && typeof t === 'object' && 'kind' in t ? (t as { kind: number | string }).kind : undefined);
      if (cur && prev && kindOf(cur) === kindOf(prev)) {
        W('W-XF-001', ['scenes', si, 'shots', i, 'transition'], `相邻镜头使用同种转场（${String(kindOf(cur))}）`, [], ['转场库分配策略：xfKindFor=(si*4+shotIndex*7)%15']);
      }
    }
  });

  // ---- L-ACC-001
  spec.scenes.forEach((sc, si) => {
    if (sc.accel === 'cut') {
      W('W-ACC-001', ['scenes', si, 'accel'], `accel=cut：动画时钟 lt 被压缩（系数 = min(镜头数, ${spec.render.max_acc})），阈值类断言需重校`, ['accel=cut', `shots=${sc.shots.length}`], ['用 kine explain scenes[].accel 查看有效 lt 映射']);
    }
  });

  // ---- L-AUD-001 淡出/砍尾纪律
  const mus = spec.audio.music;
  if (mus?.fade_out && mus.cut_from != null) {
    const fadeEnd = mus.fade_out.at + mus.fade_out.dur;
    if (mus.cut_from + 1e-6 < fadeEnd) {
      push({
        code: 'E-AUD-001', severity: 'error',
        message: `cut_from=${mus.cut_from}s 早于淡出结束 ${fadeEnd}s，余弦淡出会被截断`,
        where: loc(opts, ['audio', 'music', 'cut_from']),
        facts: [`fade_out: [${mus.fade_out.at}, ${fadeEnd}]`, `cut_from=${mus.cut_from}`],
        hints: [`把 cut_from 改为 ≥ ${fadeEnd}`, '或把 fade_out.at 提前'],
      });
    }
  }
  if (mus?.cut_from != null && mus.cut_from > spec.output.duration - 0.4) {
    W('W-AUD-005', ['audio', 'music', 'cut_from'], `cut_from=${mus.cut_from}s 距片尾不足 0.4s（sfx 尾段淡出窗口）`, [], []);
  }

  // ---- L-HUD-001 贴边 HUD 与 z1 安全边距（静态部分：仅对显式给出尺寸的图层）
  const M = Math.max(96, spec.output.width * 0.095);
  spec.scenes.forEach((sc, si) => {
    const z1 = sc.camera.z1;
    for (const [li, l] of sc.layers.entries()) {
      if (l.kind !== 'widget' && l.kind !== 'text') continue;
      const place = l.place;
      const bleed = (l.tags ?? []).includes('bleed');
      if (bleed) continue;
      const w = place.w, h = place.h;
      const checkBox = w != null && h != null;
      if (z1 > 1 && checkBox) {
        const cropX = ((1 - 1 / z1) / 2) * spec.output.width;
        const cropY = ((1 - 1 / z1) / 2) * spec.output.height;
        const anP = place.anchor;
        const x0 = place.x - (anP === 'center' ? w / 2 : anP === 'tr' || anP === 'br' ? w : 0);
        const y0 = place.y - (anP === 'center' ? h / 2 : anP === 'bl' || anP === 'br' ? h : 0);
        if (x0 < cropX || y0 < cropY || x0 + w > spec.output.width - cropX || y0 + h > spec.output.height - cropY) {
          push({
            code: 'E-HUD-001', severity: 'error',
            message: `幕 "${sc.id}" 图层 "${l.id}" 落在 z1=${z1} 的裁切带内（安全区外）`,
            where: loc(opts, ['scenes', si, 'layers', li, 'place']),
            facts: [`box=[${x0.toFixed(0)},${y0.toFixed(0)},${w.toFixed(0)}x${h.toFixed(0)}]`, `裁切带=${cropX.toFixed(0)}px`, `安全边距 M=${M.toFixed(0)}px`],
            hints: ['缩小 z1、把元素移入安全区，或加 tags:[bleed] 声明有意出血'],
          });
        }
      }
      if (place.x < 0 || place.y < 0 || place.x > spec.output.width || place.y > spec.output.height) {
        W('W-HUD-002', ['scenes', si, 'layers', li, 'place'], `图层 "${l.id}" 的 place 在画布外（${place.x},${place.y}）`, [], []);
      }
    }
  });

  // 排序：error 在前
  issues.sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
  return issues;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const m = hex.match(/^#([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/);
  if (!m) return { r: 255, g: 255, b: 255 };
  return { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) };
}

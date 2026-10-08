// @kine/dsl — lint：踩坑防护规则（09-踩坑防护 §9.5）
import type { Issue } from './errors';
import { KNOWN_KEYS, SYNTH_PARAM_KEYS, type ProjectSpecT } from './schema';
import type { LineLookup } from './load';
import { kineHomeDir } from './library';
import { resolvePalette, type PaletteSpec } from './palette';

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
  });

  // ---- L-POST-001..004 色彩后处理硬上限
  const post = spec.theme.post;
  const W = (code: string, path: (string | number)[], message: string, facts: string[], hints: string[]) => push({ code, severity: 'warn', message, where: loc(opts, path), facts, hints });
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

  // ---- L-COLOR-001..003 色彩纪律（M10：profile/palette 感知）
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
  for (const [i, c] of spec.theme.bg.entries()) {
    const rgb = hexToRgb(c);
    if (Math.max(rgb.r, rgb.g, rgb.b) > 32) {
      push({
        code: 'E-COLOR-002', severity: 'error',
        message: `背景色 ${c} 过亮（通道应 ≤32，防发灰；实际黑电平由 black_level 指标在成片帧上把关）`,
        where: loc(opts, ['theme', 'bg', i]),
        facts: [`RGB=${rgb.r},${rgb.g},${rgb.b}`, '目标黑电平 6–9（渲染后可测）'],
      });
    }
  }

  // ---- L-FONT-001
  if (!/mono/i.test(spec.theme.font.family)) {
    W('W-FONT-001', ['theme', 'font', 'family'], `字体族 "${spec.theme.font.family}" 未声明等宽字体`, ['全站统一等宽字体'], ['family 应包含 monospace/等宽族名']);
  }

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
        const x0 = place.anchor === 'center' ? place.x - w / 2 : place.x;
        const y0 = place.anchor === 'center' ? place.y - h / 2 : place.y;
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

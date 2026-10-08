// @kine/dsl — 风格档案（v2 M10）：色板解析 / 应用 / 哈希投影。
// profile: core（默认，旧行为）| extended | free。palette 仅 extended/free 生效。
// 哈希纪律：core 且无 palette 时，profile/palette 字段从哈希输入中省略 —— 旧工程 specHash/themeHash 逐字节不变。
import type { ThemeSpecT } from './schema';
import { resolveLibraryRefLite } from './library';

export interface PalettePostSpec {
  vignette?: { base?: number; tw_gain?: number; beat_gain?: number; max?: number };
  scanline?: { base?: number; tw_gain?: number; max?: number };
  flash?: { max_alpha?: number };
  black_level?: { rgb_min?: number; rgb_max?: number };
}

export interface PaletteSpec {
  bg: [string, string];
  text: string;
  text_dim: string;
  accent: string;
  accent_secondary: { color: string; max_frames: number; use: string };
  post?: PalettePostSpec;
  font?: string;
}

export const CORE_PALETTE: PaletteSpec = {
  bg: ['#060609', '#0a0a12'],
  text: '#e8e8ea',
  text_dim: '#9a9aa2',
  accent: '#ff2e3f',
  accent_secondary: { color: '#4da3ff', max_frames: 2, use: 'glitch' },
};

export type PaletteResolution =
  | { ok: true; palette: PaletteSpec; source: 'core' | 'library'; entryId?: string }
  | { ok: false; error: { code: string; message: string; candidates?: string[] } };

export function resolvePalette(ref: string | undefined, home?: string): PaletteResolution {
  if (!ref || ref === 'core') return { ok: true, palette: CORE_PALETTE, source: 'core' };
  const res = resolveLibraryRefLite(ref, home);
  if ('error' in res) return { ok: false, error: res.error };
  const data = res.entry.data as Partial<PaletteSpec> | undefined;
  if (
    !data ||
    typeof data !== 'object' ||
    !Array.isArray(data.bg) ||
    data.bg.length !== 2 ||
    typeof data.accent !== 'string' ||
    typeof data.text !== 'string'
  ) {
    return {
      ok: false,
      error: { code: 'E-LIB-003', message: `条目 ${res.entry.id} 不是有效色板（data 需含 bg[2]/text/accent）` },
    };
  }
  // v3 P0-3：注册期就把关背景亮度（否则可绕过 lint 的 bg≤32 检查造成发灰）
  for (const c of data.bg as unknown[]) {
    const mm = /^#?([0-9a-fA-F]{6})$/.exec(String(c).trim());
    if (!mm) {
      return {
        ok: false,
        error: { code: 'E-LIB-003', message: `色板 ${res.entry.id} 的 bg 颜色非法：${String(c)}（需 #rrggbb）` },
      };
    }
    const v = parseInt(mm[1]!, 16);
    if (Math.max((v >> 16) & 255, (v >> 8) & 255, v & 255) > 32) {
      return {
        ok: false,
        error: {
          code: 'E-COLOR-002',
          message: `色板 ${res.entry.id} 的背景 ${String(c)} 过亮（通道应 ≤32，防发灰/白纱；v3 P0-3 注册期把关）`,
          candidates: ['目标黑电平 6–9 由 black_level 指标在成片帧上把关'],
        },
      };
    }
  }
  return {
    ok: true,
    source: 'library',
    entryId: res.entry.id,
    palette: {
      bg: [String(data.bg[0]), String(data.bg[1])],
      text: data.text,
      text_dim: typeof data.text_dim === 'string' ? data.text_dim : CORE_PALETTE.text_dim,
      accent: data.accent,
      accent_secondary: { ...CORE_PALETTE.accent_secondary, ...(data.accent_secondary ?? {}) },
      post: data.post,
      font: data.font,
    },
  };
}

// 主题默认值（用于「palette.post 仅覆盖未被显式修改的字段」语义）
const POST_DEFAULTS = {
  vignette: { base: 0.2, tw_gain: 0.11, beat_gain: 0.09, max: 0.9 },
  scanline: { base: 0.085, tw_gain: 0.02, max: 0.12 },
  flash: { max_alpha: 0.085 },
  black_level: { rgb_min: 6, rgb_max: 9 },
} as const;

/** 把色板应用到主题（颜色全量覆盖；post/font 仅在字段等于默认值时被色板覆盖）。 */
export function applyPalette(theme: ThemeSpecT, palette: PaletteSpec | null): ThemeSpecT {
  if (!palette) return theme;
  const pick = <T>(cur: T, def: T, from: T | undefined): T => (from === undefined ? cur : cur === def ? from : cur);
  const post = theme.post;
  const p = palette.post ?? {};
  const eff: ThemeSpecT = {
    ...theme,
    bg: [palette.bg[0], palette.bg[1]],
    text: palette.text,
    text_dim: palette.text_dim,
    accent: palette.accent,
    accent_secondary: { ...palette.accent_secondary },
    font: palette.font ? { ...theme.font, family: palette.font } : theme.font,
    post: {
      vignette: {
        base: pick(post.vignette.base, POST_DEFAULTS.vignette.base, p.vignette?.base),
        tw_gain: pick(post.vignette.tw_gain, POST_DEFAULTS.vignette.tw_gain, p.vignette?.tw_gain),
        beat_gain: pick(post.vignette.beat_gain, POST_DEFAULTS.vignette.beat_gain, p.vignette?.beat_gain),
        max: pick(post.vignette.max, POST_DEFAULTS.vignette.max, p.vignette?.max),
      },
      scanline: {
        base: pick(post.scanline.base, POST_DEFAULTS.scanline.base, p.scanline?.base),
        tw_gain: pick(post.scanline.tw_gain, POST_DEFAULTS.scanline.tw_gain, p.scanline?.tw_gain),
        max: pick(post.scanline.max, POST_DEFAULTS.scanline.max, p.scanline?.max),
      },
      flash: {
        max_alpha: pick(post.flash.max_alpha, POST_DEFAULTS.flash.max_alpha, p.flash?.max_alpha),
        mode: post.flash.mode,
      },
      black_level: {
        rgb_min: pick(post.black_level.rgb_min, POST_DEFAULTS.black_level.rgb_min, p.black_level?.rgb_min),
        rgb_max: pick(post.black_level.rgb_max, POST_DEFAULTS.black_level.rgb_max, p.black_level?.rgb_max),
      },
    },
  };
  return eff;
}

/** 哈希投影：core 且无 palette → 省略 profile/palette（旧工程哈希逐字节不变）。 */
export function canonicalTheme(theme: ThemeSpecT): Record<string, unknown> {
  const { profile, palette, ...rest } = theme;
  const out: Record<string, unknown> = { ...rest };
  if (profile !== 'core') out.profile = profile;
  if (palette !== undefined) out.palette = palette;
  return out;
}

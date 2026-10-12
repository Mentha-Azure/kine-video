// @kine/dsl — schema for timeline.yaml (kine/1)
// Spec: 03-时间轴DSL规范.md
import { z } from 'zod';

export const SCHEMA_ID = 'kine/1' as const;

const HexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a #RRGGBB color');

// ---------------------------------------------------------------- project
export const ProjectMeta = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  version: z.string().min(1).default('v0.1'),
  seed: z.number().int().default(7),
});

// ---------------------------------------------------------------- output
export const VideoSpec = z.object({
  codec: z.literal('libx264').default('libx264'),
  crf: z.number().int().min(0).max(51).default(15),
  preset: z.string().default('slow'),
}).default({ codec: 'libx264', crf: 15, preset: 'slow' });

export const OutputAudioSpec = z.object({
  codec: z.literal('aac').default('aac'),
  bitrate: z.string().default('192k'),
  limit_dbfs: z.number().max(0).default(-1.0),
}).default({ codec: 'aac', bitrate: '192k', limit_dbfs: -1.0 });

export const OutputSpec = z.object({
  width: z.number().int().positive().default(1920),
  height: z.number().int().positive().default(1080),
  fps: z.number().int().positive().default(60),
  /** 成片时长（成片秒，唯一时间真源） */
  duration: z.number().positive(),
  video: VideoSpec,
  audio: OutputAudioSpec,
});

// ---------------------------------------------------------------- pace
export const PaceSegment = z.object({
  id: z.string().min(1),
  /** 该段结束时刻（成片秒），严格递增，末项 == output.duration */
  until: z.number().positive(),
  /** 成片秒 → 渲染秒 的斜率，1.0 为原速；T(t) 的分段线性映射 */
  ratio: z.number().positive(),
});

export const PaceSpec = z.object({
  segments: z.array(PaceSegment).min(1),
});

// ---------------------------------------------------------------- theme
export const VignetteSpec = z.object({
  base: z.number().min(0).default(0.20),
  tw_gain: z.number().min(0).default(0.11),
  beat_gain: z.number().min(0).default(0.09),
  max: z.number().min(0).default(0.90),
}).default({ base: 0.20, tw_gain: 0.11, beat_gain: 0.09, max: 0.90 });

export const ScanlineSpec = z.object({
  base: z.number().min(0).default(0.085),
  tw_gain: z.number().min(0).default(0.020),
  max: z.number().min(0).default(0.12),
}).default({ base: 0.085, tw_gain: 0.020, max: 0.12 });

export const FlashSpec = z.object({
  max_alpha: z.number().min(0).default(0.085),
  /** 驱动源：transient=瞬态包络（默认，#ff2e3f 纪律）；env=能量包络——历史灰白病根因，lint 拒绝 */
  mode: z.enum(['transient', 'env']).default('transient'),
}).default({ max_alpha: 0.085, mode: 'transient' });

export const BlackLevelSpec = z.object({
  rgb_min: z.number().default(6),
  rgb_max: z.number().default(9),
}).default({ rgb_min: 6, rgb_max: 9 });

export const PostSpec = z.object({
  vignette: VignetteSpec,
  scanline: ScanlineSpec,
  flash: FlashSpec,
  black_level: BlackLevelSpec,
}).default({
  vignette: { base: 0.20, tw_gain: 0.11, beat_gain: 0.09, max: 0.90 },
  scanline: { base: 0.085, tw_gain: 0.020, max: 0.12 },
  flash: { max_alpha: 0.085, mode: 'transient' },
  black_level: { rgb_min: 6, rgb_max: 9 },
});

export const FontSpec = z.object({
  family: z.string().default('Consolas, "JetBrains Mono", "Cascadia Mono", monospace'),
  /** 全局字号系数（唯一排版旋钮） */
  scale: z.number().positive().default(1.0),
  /** 基准字号（相对排版基准 S=min(W,H) 的像素值） */
  base: z.number().positive().default(32),
}).default({ family: 'Consolas, "JetBrains Mono", "Cascadia Mono", monospace', scale: 1.0, base: 32 });

export const AccentSecondarySpec = z.object({
  color: HexColor.default('#4da3ff'),
  /** 仅 glitch 色差允许，且 ≤2 帧 */
  max_frames: z.number().int().min(0).default(2),
  use: z.string().default('glitch'),
}).default({ color: '#4da3ff', max_frames: 2, use: 'glitch' });

export const ThemeSpec = z.object({
  bg: z.tuple([HexColor, HexColor]).default(['#060609', '#0a0a12']),
  text: HexColor.default('#e8e8ea'),
  text_dim: HexColor.default('#9a9aa2'),
  accent: HexColor.default('#ff2e3f'),
  accent_secondary: AccentSecondarySpec,
  font: FontSpec,
  post: PostSpec,
  /** 风格档案层级（v2 M10）：core=旧行为（唯一强调色纪律全量生效）；extended/free 允许 palette 色板 */
  profile: z.enum(['core', 'extended', 'free']).default('core'),
  /** 色板引用：'core' 或 library://<id>（仅 profile: extended|free 下生效） */
  palette: z.string().min(1).optional(),
  /** v5：地色模式。light → E-COLOR-002 改判浅底色与对比度，指标以浅底口径采样（black_level 报告白电平） */
  mode: z.enum(['dark', 'light']).default('dark'),
});

// ---------------------------------------------------------------- render
export const PurityRule = z.enum(['no_random', 'no_accumulate', 'no_wallclock', 'no_css_autoplay']);

export const RenderSpec = z.object({
  surface: z.enum(['canvas', 'overlay']).default('canvas'),
  workers: z.number().int().min(1).max(16).default(4),
  purity: z.array(PurityRule).default(['no_random', 'no_accumulate', 'no_wallclock', 'no_css_autoplay']),
  /** accel=cut 的压缩上限 */
  max_acc: z.number().positive().max(4).default(1.62),
}).default({
  surface: 'canvas',
  workers: 4,
  purity: ['no_random', 'no_accumulate', 'no_wallclock', 'no_css_autoplay'],
  max_acc: 1.62,
});

// ---------------------------------------------------------------- audio
export const FadeOutSpec = z.object({
  /** 淡出开始时间（成片秒） */
  at: z.number().min(0),
  /** 淡出时长（秒） */
  dur: z.number().positive(),
  shape: z.literal('cosine').default('cosine'),
});

export const MusicSpec = z.object({
  file: z.string().min(1),
  gain: z.number().min(0).default(1.0),
  fade_out: FadeOutSpec.optional(),
  /** 硬静音起点（成片秒）；只砍 song 路 */
  cut_from: z.number().min(0).optional(),
});

export const SFX_NAMES = ['heartbreak', 'rain', 'piano_motif', 'keyboard', 'tape', 'drone', 'glitch'] as const;
export const SfxName = z.enum(SFX_NAMES);

/** 各合成器支持的 params 键（W-SYNTH-001 校验；与 py/kine-py/kine_py/synth.py 参数表对齐） */
export const SYNTH_PARAM_KEYS: Record<string, string[]> = {
  heartbreak: [],
  rain: ['drops_per_sec', 'bed_gain', 'dur'],
  piano_motif: ['notes', 'spacing', 'gain', 'chord', 'chord_at', 'dur'],
  keyboard: ['period', 'count', 'dur'],
  tape: ['dur'],
  drone: ['freq', 'dur'],
  glitch: ['rate', 'blue_freq', 'dur'],
};

/** 合成器参数值规格（v3 P0-4）：类型+范围——lint 阶段挡住非法值，避免 render 期才炸 */
export interface SynthParamSpec {
  type: 'number' | 'number[]';
  min?: number;
  max?: number;
  /** number[] 元素范围 */
  itemMin?: number;
  itemMax?: number;
  note?: string;
}

export const SYNTH_PARAM_SPECS: Record<string, Record<string, SynthParamSpec>> = {
  heartbreak: {},
  rain: {
    drops_per_sec: { type: 'number', min: 0, max: 200 },
    bed_gain: { type: 'number', min: 0, max: 4 },
    dur: { type: 'number', min: 0.05, max: 120 },
  },
  piano_motif: {
    notes: { type: 'number[]', itemMin: 20, itemMax: 4000, note: '频率数组（Hz），如 [220.0, 261.63, 329.63]' },
    spacing: { type: 'number', min: 0.05, max: 4 },
    gain: { type: 'number', min: 0, max: 4 },
    chord: { type: 'number[]', itemMin: 20, itemMax: 4000, note: '频率数组（Hz）' },
    chord_at: { type: 'number', min: 0, max: 120 },
    dur: { type: 'number', min: 0.05, max: 120 },
  },
  keyboard: {
    period: { type: 'number', min: 0.02, max: 2 },
    count: { type: 'number', min: 1, max: 400 },
    dur: { type: 'number', min: 0.05, max: 120 },
  },
  tape: { dur: { type: 'number', min: 0.05, max: 120 } },
  drone: {
    freq: { type: 'number', min: 20, max: 2000 },
    dur: { type: 'number', min: 0.05, max: 120 },
  },
  glitch: {
    rate: { type: 'number', min: 100, max: 48000 },
    blue_freq: { type: 'number', min: 100, max: 20000 },
    dur: { type: 'number', min: 0.01, max: 10 },
  },
};

/** 校验单个合成器参数值；返回错误消息（含修复提示）或 null（未知键交由 W-SYNTH-001） */
export function validateSynthParamValue(sfx: string, key: string, value: unknown): string | null {
  const spec = SYNTH_PARAM_SPECS[sfx]?.[key];
  if (!spec) return null;
  if (spec.type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return `${sfx}.${key} 应为数字（当前 ${JSON.stringify(value)}，类型 ${Array.isArray(value) ? 'array' : typeof value}）`;
    }
    if ((spec.min !== undefined && value < spec.min) || (spec.max !== undefined && value > spec.max)) {
      return `${sfx}.${key}=${value} 超出允许范围 ${spec.min ?? '-∞'}..${spec.max ?? '+∞'}`;
    }
    return null;
  }
  // number[]
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
    return `${sfx}.${key} 应为数字数组${spec.note ? `（${spec.note}）` : ''}——当前 ${JSON.stringify(value)}（提示：单个数字不是数组，需写成 [220.0] 形式）`;
  }
  for (const v of value as number[]) {
    if ((spec.itemMin !== undefined && v < spec.itemMin) || (spec.itemMax !== undefined && v > spec.itemMax)) {
      return `${sfx}.${key} 的元素 ${v} 超出范围 ${spec.itemMin ?? '-∞'}..${spec.itemMax ?? '+∞'}${spec.note ? `（${spec.note}）` : ''}`;
    }
  }
  return null;
}

export const SfxEvent = z.object({
  /** 触发时间；clock=output 时为成片秒，clock=render 时为渲染秒（全局 T） */
  at: z.number().min(0),
  clock: z.enum(['output', 'render']).default('output'),
  sfx: SfxName,
  gain: z.number().min(0).default(1.0),
  bus: z.string().default('hits'),
  params: z.record(z.string(), z.any()).default({}),
});

export const SfxBus = z.object({
  id: z.string().min(1),
  gain: z.number().min(0).default(1.0),
});

export const SfxSpec = z.object({
  /** offline：离线纯函数合成（默认，确定性）；record：实时录制回退（特殊场合） */
  synth: z.enum(['offline', 'record']).default('offline'),
  events: z.array(SfxEvent).default([]),
  buses: z.array(SfxBus).default([{ id: 'bed', gain: 1.0 }, { id: 'hits', gain: 1.0 }]),
}).default({ synth: 'offline', events: [], buses: [{ id: 'bed', gain: 1.0 }, { id: 'hits', gain: 1.0 }] });

export const AudioSpec = z.object({
  music: MusicSpec.optional(),
  sfx: SfxSpec,
  /** 逐幕 drone 电平（0..2），缺省全 0 */
  drone_levels: z.array(z.number().min(0)).optional(),
  /** sfx 路末段同步淡出时长（秒）；只作用于 sfx 路（L-AUD-002 禁止硬砍 mix 总路） */
  tail_fade: z.number().min(0.1).max(3).default(0.4),
}).default({
  sfx: { synth: 'offline', events: [], buses: [{ id: 'bed', gain: 1.0 }, { id: 'hits', gain: 1.0 }] },
  tail_fade: 0.4,
});

// ---------------------------------------------------------------- camera
export const CameraSpec = z.object({
  /** 缩放：1.0 为无缩放 */
  z1: z.number().positive().default(1.0),
  dx: z.number().default(0),
  dy: z.number().default(0),
  /** 滚转（度） */
  roll: z.number().default(0),
  /** 抖动强度旋钮（一维），0 关闭 */
  tw: z.number().min(0).default(0),
  /** 节拍 BPM（缺省则该幕无节拍脉冲） */
  bpm: z.number().positive().optional(),
  /** 节拍网格相位偏移（秒） */
  beat_offset: z.number().default(0),
});

/** 镜头级相机覆盖：仅覆盖显式给出的字段（无默认值展开） */
export const CameraOverride = z.object({
  z1: z.number().positive().optional(),
  dx: z.number().optional(),
  dy: z.number().optional(),
  roll: z.number().optional(),
  tw: z.number().min(0).optional(),
  bpm: z.number().positive().optional(),
  beat_offset: z.number().optional(),
});

// ---------------------------------------------------------------- layers
export const PlaceSpec = z.object({
  x: z.number(),
  y: z.number(),
  w: z.number().positive().optional(),
  h: z.number().positive().optional(),
  anchor: z.enum(['tl', 'tr', 'bl', 'br', 'center']).default('tl'),
});

const LayerBase = {
  id: z.string().min(1),
  tags: z.array(z.string()).default([]),
  alias: z.string().optional(),
  /** 活跃窗口（幕内 lt 秒区间），缺省全幕 */
  window: z.tuple([z.number(), z.number()]).optional(),
  fade_in: z.number().min(0).default(0),
  fade_out: z.number().min(0).default(0),
};

export const ParticlesLayer = z.object({
  kind: z.literal('particles'),
  ...LayerBase,
  depth: z.enum(['far', 'near']).default('far'),
  count: z.number().int().min(0).default(60),
  /** 尺寸区间（对数分布） */
  size: z.tuple([z.number().positive(), z.number().positive()]).default([1.0, 2.4]),
  /** 视差系数：远层 0.062 / 近层 0.085 */
  parallax: z.number().default(0.062),
  speed: z.number().default(1.0),
  /** 回避区（中心矩形，勿覆盖主体） */
  keepout: z.object({ x: z.number(), y: z.number(), w: z.number().optional(), h: z.number().optional() }).optional(),
  color: HexColor.optional(),
});

export const WidgetLayer = z.object({
  kind: z.literal('widget'),
  ...LayerBase,
  widget: z.string().min(1),
  props: z.record(z.string(), z.any()).default({}),
  place: PlaceSpec.default({ x: 96, y: 96, anchor: 'tl' }),
});

export const TextStyleSpec = z.object({
  size: z.number().positive().default(1.0),
  color: HexColor.optional(),
  weight: z.number().int().min(100).max(900).default(500),
  align: z.enum(['left', 'center', 'right']).default('left'),
  max_width: z.number().positive().optional(),
  /** v5：行高倍数（默认 1.4；px = size × base × fontScale × ds × 1.06） */
  line_height: z.number().positive().optional(),
});

export const TextLayer = z.object({
  kind: z.literal('text'),
  ...LayerBase,
  content: z.string(),
  style: TextStyleSpec.default({ size: 1.0, weight: 500, align: 'left' }),
  place: PlaceSpec.default({ x: 96, y: 96, anchor: 'tl' }),
  /** 打字机周期（秒/字符）；0 = 一次显示 */
  type_period: z.number().min(0).default(0),
});

export const ImageLayer = z.object({
  kind: z.literal('image'),
  ...LayerBase,
  src: z.string().min(1),
  fit: z.enum(['cover', 'contain']).default('cover'),
  place: PlaceSpec.default({ x: 0, y: 0, anchor: 'tl' }),
});

export const VideoLayer = z.object({
  kind: z.literal('video'),
  ...LayerBase,
  src: z.string().min(1),
  fit: z.enum(['cover', 'contain']).default('cover'),
  place: PlaceSpec.default({ x: 0, y: 0, anchor: 'tl' }),
});

/** v5：字幕 cue（成片秒 t） */
export const CueSpec = z.object({
  from: z.number().min(0),
  to: z.number().positive(),
  text: z.string(),
});

/** v5：字幕层——cue 列表或 SRT 文件（工程相对路径，编译期内联进 IR）；render 时另导出 .srt */
export const SubtitlesLayer = z.object({
  kind: z.literal('subtitles'),
  ...LayerBase,
  src: z.string().optional(),
  cues: z.array(CueSpec).optional(),
  style: z
    .object({
      size: z.number().positive().default(1.0),
      color: HexColor.optional(),
      max_width: z.number().positive().optional(),
    })
    .default({ size: 1.0 }),
  /** 字幕中心锚点（画布像素坐标，默认画面下方） */
  zone: z.object({ x: z.number().default(960), y: z.number().default(950) }).default({ x: 960, y: 950 }),
});

export const FX_KINDS = ['scanlines', 'vignette', 'grain', 'chroma', 'redbar', 'pulse'] as const;

export const FxLayer = z.object({
  kind: z.literal('fx'),
  ...LayerBase,
  fx: z.enum(FX_KINDS),
  params: z.record(z.string(), z.any()).default({}),
});

export const LayerSpec = z.discriminatedUnion('kind', [
  ParticlesLayer,
  WidgetLayer,
  TextLayer,
  ImageLayer,
  VideoLayer,
  SubtitlesLayer,
  FxLayer,
]);

// ---------------------------------------------------------------- shots & transitions
export const TRANSITION_NAMES = [
  'wipe_redbar', 'wipe_line', 'wipe_blinds', 'wipe_diagonal', 'wipe_burst', 'wipe_vbars', 'wipe_close',
  'push_in', 'push_out', 'push_up', 'push_down',
  'zoom_in', 'zoom_out',
  'whip_h', 'whip_v',
] as const;

export const TransitionSpec = z.object({
  /** 0..14 数字，或上表名称 */
  kind: z.union([z.number().int().min(0).max(14), z.enum(TRANSITION_NAMES)]),
  /** 方向/样式变体：可为 0|1 或方向串 */
  variant: z.union([z.number().int(), z.string()]).optional(),
});

export const ShotSpec = z.object({
  dur: z.number().positive(),
  transition: TransitionSpec.optional(),
  /** 该镜头可见的图层 id 列表；缺省 = 全幕图层 */
  on: z.array(z.string()).optional(),
  camera_override: CameraOverride.optional(),
});

// ---------------------------------------------------------------- asserts
export const AssertScope = z.object({
  scene: z.string().optional(),
  range: z.tuple([z.number(), z.number()]).optional(),
  at: z.union([z.number(), z.string()]).optional(),
}).default({});

export const AssertSpec = z.object({
  id: z.string().min(1),
  metric: z.string().min(1),
  scope: AssertScope,
  /** 形如 ">= 0.9 %" / "<= 2 px" / "== PASS" / "in 0.23..0.36 %" */
  expect: z.string().min(1),
  severity: z.enum(['error', 'warn']).default('error'),
});

// ---------------------------------------------------------------- scene
export const ScenePost = z.object({
  vignette: z.number().min(0).optional(),
  scanline: z.number().min(0).optional(),
  flash: z.number().min(0).optional(),
}).default({});

export const SceneAudioEvent = z.object({
  /** 幕内渲染秒（lt 基准） */
  at: z.number().min(0),
  sfx: SfxName,
  gain: z.number().min(0).default(1.0),
  bus: z.string().default('hits'),
  params: z.record(z.string(), z.any()).default({}),
});

export const SceneSpec = z.object({
  id: z.string().min(1),
  act: z.string().optional(),
  name: z.string().optional(),
  /** 渲染秒时长（改 dur = 改总长） */
  dur: z.number().positive(),
  /** 幕内加速比（不改总长） */
  rate: z.number().positive().default(1.0),
  /** 分镜动画压缩策略 */
  accel: z.enum(['none', 'cut']).default('none'),
  camera: CameraSpec.default({ z1: 1, dx: 0, dy: 0, roll: 0, tw: 0, beat_offset: 0 }),
  layers: z.array(LayerSpec).default([]),
  shots: z.array(ShotSpec).default([]),
  effects: z.array(z.object({
    fx: z.enum(FX_KINDS),
    params: z.record(z.string(), z.any()).default({}),
    window: z.tuple([z.number(), z.number()]).optional(),
  })).default([]),
  post: ScenePost,
  audio: z.array(SceneAudioEvent).default([]),
  asserts: z.array(AssertSpec).default([]),
});

// ---------------------------------------------------------------- root
export const ProjectSpec = z.object({
  schema: z.literal(SCHEMA_ID),
  project: ProjectMeta,
  output: OutputSpec,
  pace: PaceSpec,
  theme: ThemeSpec,
  render: RenderSpec,
  audio: AudioSpec,
  scenes: z.array(SceneSpec).min(1),
  asserts: z.array(AssertSpec).default([]),
});

export type ProjectSpecT = z.infer<typeof ProjectSpec>;
export type PaceSpecT = z.infer<typeof PaceSpec>;
export type ParticlesLayerT = z.infer<typeof ParticlesLayer>;
export type WidgetLayerT = z.infer<typeof WidgetLayer>;
export type TextLayerT = z.infer<typeof TextLayer>;
export type ImageLayerT = z.infer<typeof ImageLayer>;
export type VideoLayerT = z.infer<typeof VideoLayer>;
export type FxLayerT = z.infer<typeof FxLayer>;
export type SceneSpecT = z.infer<typeof SceneSpec>;
export type LayerSpecT = z.infer<typeof LayerSpec>;
export type ShotSpecT = z.infer<typeof ShotSpec>;
export type AssertSpecT = z.infer<typeof AssertSpec>;
export type CameraSpecT = z.infer<typeof CameraSpec>;
export type ThemeSpecT = z.infer<typeof ThemeSpec>;
export type SfxEventT = z.infer<typeof SfxEvent>;
export type SceneAudioEventT = z.infer<typeof SceneAudioEvent>;

/** 顶层/嵌套对象已知键表（用于 W-SCHEMA-001 未知字段检测） */
export const KNOWN_KEYS: Record<string, string[]> = {
  root: ['schema', 'project', 'output', 'pace', 'theme', 'render', 'audio', 'scenes', 'asserts'],
  project: ['id', 'title', 'version', 'seed'],
  output: ['width', 'height', 'fps', 'duration', 'video', 'audio'],
  'output.video': ['codec', 'crf', 'preset'],
  'output.audio': ['codec', 'bitrate', 'limit_dbfs'],
  pace: ['segments'],
  'pace.segment': ['id', 'until', 'ratio'],
  theme: ['bg', 'text', 'text_dim', 'accent', 'accent_secondary', 'font', 'post', 'profile', 'palette', 'mode'],
  'theme.accent_secondary': ['color', 'max_frames', 'use'],
  'theme.font': ['family', 'scale', 'base'],
  'theme.post': ['vignette', 'scanline', 'flash', 'black_level'],
  'theme.post.vignette': ['base', 'tw_gain', 'beat_gain', 'max'],
  'theme.post.scanline': ['base', 'tw_gain', 'max'],
  'theme.post.flash': ['max_alpha', 'mode'],
  'theme.post.black_level': ['rgb_min', 'rgb_max'],
  render: ['surface', 'workers', 'purity', 'max_acc'],
  audio: ['music', 'sfx', 'drone_levels', 'tail_fade'],
  'audio.music': ['file', 'gain', 'fade_out', 'cut_from'],
  'audio.music.fade_out': ['at', 'dur', 'shape'],
  'audio.sfx': ['synth', 'events', 'buses'],
  'audio.sfx.event': ['at', 'clock', 'sfx', 'gain', 'bus', 'params'],
  'audio.sfx.bus': ['id', 'gain'],
  scene: ['id', 'act', 'name', 'dur', 'rate', 'accel', 'camera', 'layers', 'shots', 'effects', 'post', 'audio', 'asserts'],
  camera: ['z1', 'dx', 'dy', 'roll', 'tw', 'bpm', 'beat_offset'],
  shot: ['dur', 'transition', 'on', 'camera_override'],
  'shot.transition': ['kind', 'variant'],
  'scene.post': ['vignette', 'scanline', 'flash'],
  'scene.audio': ['at', 'sfx', 'gain', 'bus', 'params'],
  'scene.effect': ['fx', 'params', 'window'],
  assert: ['id', 'metric', 'scope', 'expect', 'severity'],
  'assert.scope': ['scene', 'range', 'at'],
  'layer.common': ['kind', 'id', 'tags', 'alias', 'window', 'fade_in', 'fade_out'],
  'layer.particles': ['kind', 'id', 'tags', 'alias', 'window', 'fade_in', 'fade_out', 'depth', 'count', 'size', 'parallax', 'speed', 'keepout', 'color'],
  'layer.widget': ['kind', 'id', 'tags', 'alias', 'window', 'fade_in', 'fade_out', 'widget', 'props', 'place'],
  'layer.text': ['kind', 'id', 'tags', 'alias', 'window', 'fade_in', 'fade_out', 'content', 'style', 'place', 'type_period'],
  'layer.text.style': ['size', 'color', 'weight', 'align', 'max_width', 'line_height'],
  'layer.subtitles': ['kind', 'id', 'tags', 'alias', 'window', 'fade_in', 'fade_out', 'src', 'cues', 'style', 'zone'],
  'layer.subtitles.cue': ['from', 'to', 'text'],
  'layer.subtitles.style': ['size', 'color', 'max_width'],
  'layer.subtitles.zone': ['x', 'y'],
  'layer.image': ['kind', 'id', 'tags', 'alias', 'window', 'fade_in', 'fade_out', 'src', 'fit', 'place'],
  'layer.video': ['kind', 'id', 'tags', 'alias', 'window', 'fade_in', 'fade_out', 'src', 'fit', 'place'],
  'layer.fx': ['kind', 'id', 'tags', 'alias', 'window', 'fade_in', 'fade_out', 'fx', 'params'],
  place: ['x', 'y', 'w', 'h', 'anchor'],
};

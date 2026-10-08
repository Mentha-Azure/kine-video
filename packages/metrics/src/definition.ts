// 指标注册表：名称 → 元数据（单位、方向、采样需求、人读解释模板）
export type MetricDirection = 'higher' | 'lower' | 'range' | 'zero' | 'info';
export type ScopeKind = 'scene' | 'range' | 'at';

export interface MetricDef {
  name: string;
  /** 标准单位（density/frame_diff/edge_band 为比例；其余按字面） */
  unit: string;
  direction: MetricDirection;
  /** 需要成对帧（0.4s 间隔） */
  pair?: boolean;
  /** 需要密采样（0.1s 步进窗口） */
  dense?: boolean;
  /** 纯解析复算（不需要帧） */
  analytic?: boolean;
  /** 需要音频输入 */
  audio?: 'mix' | 'music';
  description: string;
}

export const METRICS: Record<string, MetricDef> = {
  density: {
    name: 'density', unit: 'ratio', direction: 'higher',
    description: '内容密度：灰度>40 像素占比（≥0.9%）。防「空」——黑屏/画面过空。',
  },
  frame_diff: {
    name: 'frame_diff', unit: 'ratio', direction: 'higher', pair: true,
    description: '帧间差：相隔 0.4s 两帧 |Δ|>8 的像素占比（≥4%）。<4% 判静态。',
  },
  static_ratio: {
    name: 'static_ratio', unit: 'ratio', direction: 'lower', pair: true,
    description: '静止占比：单幕内静态采样（frame_diff<4%）的比例（≤30%）。',
  },
  edge_band: {
    name: 'edge_band', unit: 'ratio', direction: 'lower',
    description: '边缘带：最外 34px 环带内容占比（≤0.6）。防贴边 HUD 被切。',
  },
  black_level: {
    name: 'black_level', unit: 'level', direction: 'range',
    description: '背景黑电平：最暗 30% 像素 RGB 均值 (6..9)。>9 发灰，<6 死黑。',
  },
  cam_jitter: {
    name: 'cam_jitter', unit: 'px', direction: 'lower', analytic: true,
    description: '摄影机抖动：逐帧解析复算位移/滚转的 p99（水平≤2px，滚转≤0.01°）。看 p99 不看 max。',
  },
  audio_rms: {
    name: 'audio_rms', unit: 'dB', direction: 'higher', audio: 'mix',
    description: '音频响度：0.1s 窗 RMS/峰值曲线（scope range 时取区间峰值 dBFS）。',
  },
  audio_cumenergy: {
    name: 'audio_cumenergy', unit: 's', direction: 'info', audio: 'mix',
    description: '累积能量 99.9% 时刻（秒）。用于定位「最后发生了什么」。',
  },
  beat_delta: {
    name: 'beat_delta', unit: 'ms', direction: 'lower', audio: 'music',
    description: '卡点偏差：音乐重拍 ↔ 音效事件的 |Δ| 最大值（≤60ms）。',
  },
  transition_spike: {
    name: 'transition_spike', unit: 'count', direction: 'zero', dense: true,
    description: '转场孤立跳变：本帧差 > 邻域均值×2.2 的命中数（期望 0）；设计内边界（幕头装置/镜头转场/硬切瞬间）自动豁免。',
  },
};

export function metricDef(name: string): MetricDef {
  const d = METRICS[name];
  if (!d) throw new Error(`未知指标 "${name}"（可用：${Object.keys(METRICS).join(', ')}）`);
  return d;
}

export function listMetricNames(): string[] {
  return Object.keys(METRICS);
}

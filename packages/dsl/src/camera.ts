// @kine/dsl — 摄影机模型（单一真源：runtime 绘制与 metrics 解析复算共用同一公式）
//   纪律 L-CAM-001：
//     - 震屏频率 ≤ 5Hz；全部为时间连续函数（禁 exp(-k·frac) 式不连续 pump）
//     - 幅度按 tw 线性缩放，验收看 p99（≤2px）不看 max
//     - mot = (1+cos(2π·frac((T+offset)·bpm/60)))/2 连续呼吸
//     - 幕头冲击 +0.038·exp(-lt/0.15)
//     - 强拍增益用 flash²（禁能量包络直接当提亮）
import { fnv1a32, mulberry32, frac } from './rand';
import type { CameraSpecT } from './schema';

export interface CameraState {
  /** 有效缩放（含幕头冲击与呼吸微缩放） */
  z1: number;
  dx: number;
  dy: number;
  /** 度 */
  roll: number;
  tw: number;
  /** 呼吸 0..1（无 bpm 时 0.5） */
  mot: number;
  /** 幕头冲击分量 */
  head: number;
  /** 节拍相位 0..1 */
  beatPhase: number;
  /** 节拍包络 exp(-phase*6) 0..1 */
  beatEnv: number;
  /** 强拍提亮量（瞬态驱动 flash²，0..1） */
  flash2: number;
  shakeX: number;
  shakeY: number;
  shakeRoll: number;
}

const TWO_PI = Math.PI * 2;

export function cameraAt(
  cam: CameraSpecT,
  p: { T: number; lt: number; seed: number | string; S?: number },
): CameraState {
  const s = (p.S ?? 1080) / 1080;
  const tw = cam.tw;
  const bpm = cam.bpm ?? 0;
  const ph = bpm > 0 ? frac((p.T + cam.beat_offset) * (bpm / 60)) : 0;
  const mot = bpm > 0 ? (1 + Math.cos(TWO_PI * ph)) / 2 : 0.5;
  const beatEnv = bpm > 0 ? Math.exp(-ph * 6.0) : 0;
  const flash2 = beatEnv * beatEnv;
  const head = 0.038 * Math.exp(-Math.max(p.lt, 0) / 0.15);

  const sd = String(p.seed);
  const phase = (i: number) => mulberry32(fnv1a32(`${sd}:shake:${i}`))() * TWO_PI;
  const p0 = phase(0), p1 = phase(1), p2 = phase(2), p3 = phase(3), p4 = phase(4);

  // 连续正弦叠加，频率 ≤ 5Hz（1.7 / 4.3 / 1.3 / 3.9 / 0.9 / 2.3）
  const shakeX = tw * 3.0 * s * (0.60 * Math.sin(TWO_PI * 1.7 * p.T + p0) + 0.40 * Math.sin(TWO_PI * 4.3 * p.T + p1));
  const shakeY = tw * 2.4 * s * (0.55 * Math.sin(TWO_PI * 1.3 * p.T + p2) + 0.45 * Math.sin(TWO_PI * 3.9 * p.T + p3));
  const shakeRoll = tw * 0.05 * (0.70 * Math.sin(TWO_PI * 0.9 * p.T + p4) + 0.30 * Math.sin(TWO_PI * 2.3 * p.T + p0));

  return {
    z1: cam.z1 * (1 + head + tw * (0.006 + 0.008 * mot)),
    dx: cam.dx + shakeX,
    dy: cam.dy + shakeY,
    roll: cam.roll + shakeRoll,
    tw,
    mot,
    head,
    beatPhase: ph,
    beatEnv,
    flash2,
    shakeX,
    shakeY,
    shakeRoll,
  };
}

export interface PostState {
  vignette: number;
  scanline: number;
  flash: number;
}

/** 后处理参数（tw 一旋钮驱动震屏/暗角/扫描线/强拍提亮） */
export function postAt(
  cam: CameraState,
  theme: { post: { vignette: { base: number; tw_gain: number; beat_gain: number; max: number }; scanline: { base: number; tw_gain: number; max: number }; flash: { max_alpha: number } } },
  extraFlash = 0,
): PostState {
  const beat = cam.tw * cam.flash2;
  const vignette = Math.min(cam.tw > 0 ? theme.post.vignette.base + cam.tw * theme.post.vignette.tw_gain + beat * theme.post.vignette.beat_gain : theme.post.vignette.base, theme.post.vignette.max);
  const scanline = Math.min(theme.post.scanline.base + cam.tw * theme.post.scanline.tw_gain, theme.post.scanline.max);
  const flash = Math.min(theme.post.flash.max_alpha, theme.post.flash.max_alpha * Math.max(cam.flash2 * (0.35 + 0.65 * cam.tw), extraFlash));
  return { vignette, scanline, flash };
}

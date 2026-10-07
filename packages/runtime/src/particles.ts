// @kine/runtime — 粒子层（远/近两层；L-PURE-002：位置一律由 T 全量重算，无累积）
import type { Rng } from '@kine/dsl';
import type { ParticlesLayerT } from '@kine/dsl';
import { rgba } from './theme';
import type { ResolvedTheme } from './theme';

const TWO_PI = Math.PI * 2;

export interface ParticleCtx {
  T: number;
  theme: ResolvedTheme;
  rng: Rng;
  W: number;
  H: number;
}

function rng4(rng: Rng, ch: string, i: number): [number, number, number, number] {
  return [rng(ch, i * 4), rng(ch, i * 4 + 1), rng(ch, i * 4 + 2), rng(ch, i * 4 + 3)];
}

/** 绘制一个粒子层（调用方已在镜头变换内） */
export function drawParticles(ctx: CanvasRenderingContext2D, layer: ParticlesLayerT, c: ParticleCtx): void {
  const { T, W, H, theme } = c;
  const count = layer.count | 0;
  if (count <= 0) return;
  const ch = `particles.${layer.id}`;
  const ds = theme.S / 1080;
  const sizeMin = (layer.size[0] || 1) * ds;
  const sizeMax = (layer.size[1] || 2.4) * ds;
  const depthBoost = layer.depth === 'near' ? 1.55 : 1.0;
  const parallaxK = layer.parallax / 0.062;
  const margin = Math.max(W, H) * 0.05;
  const color = layer.color ?? (layer.depth === 'near' ? theme.text : theme.textDim);
  const keep = layer.keepout;

  for (let i = 0; i < count; i++) {
    const [u, v, sz, ph] = rng4(c.rng, ch, i);
    if (keep) {
      const kx = keep.x, ky = keep.y;
      const kw = keep.w ?? W * 0.42;
      const kh = keep.h ?? H * 0.36;
      const px = u * (W + 2 * margin) - margin;
      const py = v * (H + 2 * margin) - margin;
      if (px > kx && px < kx + kw && py > ky && py < ky + kh) continue;
    }
    const sp = (10 + 26 * v) * layer.speed * parallaxK * depthBoost;
    const spanX = W + 2 * margin;
    let x = (u * spanX - margin - T * sp) % spanX;
    if (x < -margin) x += spanX;
    const yBase = v * (H + 2 * margin) - margin;
    const yWob = Math.sin(TWO_PI * (0.05 * T + ph)) * (6 + 14 * sz) * ds;
    const y = yBase + yWob;
    const s = (sizeMin + (sizeMax - sizeMin) * Math.pow(sz, 2.2)) * depthBoost;
    const twinkle = 0.5 + 0.5 * Math.sin(TWO_PI * (0.11 * T + ph * 2.3));
    const alpha = (0.18 + 0.5 * twinkle) * (0.45 + 0.55 * sz) * (layer.depth === 'near' ? 0.95 : 0.7);
    if (alpha <= 0.01) continue;
    ctx.globalAlpha = Math.min(1, alpha);
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(x, y, Math.max(0.4, s * 0.5), 0, TWO_PI);
    ctx.fill();
    // 亮点核心（近层 20% 粒子）
    if (layer.depth === 'near' && sz > 0.8) {
      ctx.globalAlpha = Math.min(1, alpha * 1.4);
      ctx.fillStyle = theme.text;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(0.3, s * 0.22), 0, TWO_PI);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

/** 粒子层在探针中的可量参照物（密度代理：数量密度） */
export function particlesMeasure(layer: ParticlesLayerT, W: number, H: number): Record<string, number> {
  return { count: layer.count, density: +(layer.count / ((W * H) / 1e6)).toFixed(2) };
}

export { rgba };

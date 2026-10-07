// @kine/runtime — 转场库 4 类 15 种（03 文档 §3.6）
//   A 遮罩 wipe 0-6：不移动内容，只做揭示裁剪 + 边缘红条；方向纪律：新内容随 p=0→1 揭示（勿传 1-p）
//   B 位移 push 7-10：旧/新画面互相推挤（需快照——调用方传入已渲染的两幅位图）
//   C 缩放 zoom 11-12：新内容 ov=1+.15*(1-d) 收回 / 1-.15*(1-d) 展开
//   D 甩镜 whip 13-14：高速平移 + 少量残影（模糊仅 0.34s 窗口内，此处由转场时长保证）
import { rgba } from './theme';
import type { ResolvedTheme } from './theme';

export interface TransitionView {
  kind: number;
  name: string;
  variant: number;
  /** 进度 0..1 */
  d: number;
}

const smooth = (x: number) => {
  const c = Math.max(0, Math.min(1, x));
  return c * c * (3 - 2 * c);
};
const easeOutCubic = (x: number) => 1 - Math.pow(1 - Math.max(0, Math.min(1, x)), 3);
const easeOutQuint = (x: number) => 1 - Math.pow(1 - Math.max(0, Math.min(1, x)), 5);
// 甩镜/爆开用：两端速度→0（防 0.1s 采样下的孤立大跳）；中段更锐利
const easeInOutCubic = (x: number) => {
  const t = Math.max(0, Math.min(1, x));
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
};

const N_BLINDS = 14;
const N_VBARS = 12;

export function drawTransition(
  ctx: CanvasRenderingContext2D,
  oldC: CanvasImageSource,
  newC: CanvasImageSource,
  tr: TransitionView,
  theme: ResolvedTheme,
  W: number,
  H: number,
): void {
  const d = Math.max(0, Math.min(1, tr.d));
  const dir = tr.variant % 2; // 0 = 正向（左→右 / 上→下）；1 = 反向
  const p = dir === 0 ? d : 1 - d;
  const e = smooth(d);
  const name = tr.name;

  switch (name) {
    // ---------------------------------------------------------- A 遮罩
    case 'wipe_redbar': {
      ctx.drawImage(oldC, 0, 0, W, H);
      ctx.save();
      ctx.beginPath();
      if (dir === 0) ctx.rect(0, 0, W * e, H);
      else ctx.rect(W * (1 - e), 0, W * e, H);
      ctx.clip();
      ctx.drawImage(newC, 0, 0, W, H);
      ctx.restore();
      // 红色擦除条
      const x = (dir === 0 ? e : 1 - e) * W;
      const bw = Math.max(8, W * 0.012);
      ctx.fillStyle = rgba(theme.accent, 0.85);
      ctx.fillRect(x - bw / 2, 0, bw, H);
      return;
    }
    case 'wipe_line': {
      ctx.drawImage(oldC, 0, 0, W, H);
      ctx.save();
      ctx.beginPath();
      if (dir === 0) ctx.rect(0, 0, W * e, H);
      else ctx.rect(W * (1 - e), 0, W * e, H);
      ctx.clip();
      ctx.drawImage(newC, 0, 0, W, H);
      ctx.restore();
      const x = (dir === 0 ? e : 1 - e) * W;
      ctx.fillStyle = rgba(theme.text, 0.9);
      ctx.fillRect(x - 1.5, 0, 3, H);
      return;
    }
    case 'wipe_blinds': {
      ctx.drawImage(oldC, 0, 0, W, H);
      const sh = H / N_BLINDS;
      for (let k = 0; k < N_BLINDS; k++) {
        const order = dir === 0 ? k : N_BLINDS - 1 - k;
        const pk = Math.max(0, Math.min(1, (e - (order / N_BLINDS) * 0.45) / 0.55));
        if (pk <= 0) continue;
        const y = k * sh;
        const hh = sh * pk;
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, y + (sh - hh) / 2, W, hh);
        ctx.clip();
        ctx.drawImage(newC, 0, 0, W, H);
        ctx.restore();
      }
      return;
    }
    case 'wipe_diagonal': {
      ctx.drawImage(oldC, 0, 0, W, H);
      const k = e * 2;
      ctx.save();
      ctx.beginPath();
      if (dir === 0) {
        ctx.moveTo(0, 0);
        ctx.lineTo(Math.min(1, k) * W, 0);
        ctx.lineTo(Math.max(0, k - 1) * W, H);
        ctx.lineTo(0, H);
      } else {
        ctx.moveTo(W, 0);
        ctx.lineTo(W - Math.min(1, k) * W, 0);
        ctx.lineTo(W - Math.max(0, k - 1) * W, H);
        ctx.lineTo(W, H);
      }
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(newC, 0, 0, W, H);
      ctx.restore();
      return;
    }
    case 'wipe_burst': {
      ctx.drawImage(oldC, 0, 0, W, H);
      const maxR = Math.hypot(W, H) * 0.62;
      ctx.save();
      ctx.beginPath();
      ctx.arc(W / 2, H / 2, easeInOutCubic(d) * maxR, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(newC, 0, 0, W, H);
      ctx.restore();
      const r = easeInOutCubic(d) * maxR;
      if (r > 4 && r < Math.hypot(W, H) * 0.62 - 4) {
        ctx.strokeStyle = rgba(theme.accent, 0.7 * (1 - d));
        ctx.lineWidth = Math.max(2, W * 0.004);
        ctx.beginPath();
        ctx.arc(W / 2, H / 2, r, 0, Math.PI * 2);
        ctx.stroke();
      }
      return;
    }
    case 'wipe_vbars': {
      ctx.drawImage(oldC, 0, 0, W, H);
      const bw = W / N_VBARS;
      for (let k = 0; k < N_VBARS; k++) {
        const group = k % 2;
        const pk = Math.max(0, Math.min(1, (e - group * 0.5) / 0.5));
        if (pk <= 0) continue;
        const x = dir === 0 ? k * bw : W - (k + 1) * bw;
        ctx.save();
        ctx.beginPath();
        ctx.rect(x, 0, bw * pk, H);
        ctx.clip();
        ctx.drawImage(newC, 0, 0, W, H);
        ctx.restore();
      }
      return;
    }
    case 'wipe_close': {
      // 上下合拢（中缝展开）
      ctx.drawImage(oldC, 0, 0, W, H);
      const hh = H * e;
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, (H - hh) / 2, W, hh);
      ctx.clip();
      ctx.drawImage(newC, 0, 0, W, H);
      ctx.restore();
      ctx.fillStyle = rgba(theme.accent, 0.5 * (1 - e));
      ctx.fillRect(0, (H - hh) / 2 - 2, W, 2);
      ctx.fillRect(0, (H + hh) / 2, W, 2);
      return;
    }

    // ---------------------------------------------------------- B 位移
    case 'push_in': {
      const off = (dir === 0 ? 1 : -1) * e;
      ctx.drawImage(oldC, -off * W, 0, W, H);
      ctx.drawImage(newC, (1 - off) * W, 0, W, H);
      return;
    }
    case 'push_out': {
      const off = (dir === 0 ? -1 : 1) * e;
      ctx.drawImage(oldC, -off * W, 0, W, H);
      ctx.drawImage(newC, (1 - off) * W, 0, W, H);
      return;
    }
    case 'push_up': {
      const off = (dir === 0 ? 1 : -1) * e;
      ctx.drawImage(oldC, 0, -off * H, W, H);
      ctx.drawImage(newC, 0, (1 - off) * H, W, H);
      return;
    }
    case 'push_down': {
      const off = (dir === 0 ? -1 : 1) * e;
      ctx.drawImage(oldC, 0, -off * H, W, H);
      ctx.drawImage(newC, 0, (1 - off) * H, W, H);
      return;
    }

    // ---------------------------------------------------------- C 缩放（收回/展开）
    case 'zoom_in': {
      drawZoom(ctx, oldC, newC, W, H, 1 + 0.15 * e, 1 + 0.15 * (1 - e), 1 - 0.55 * e);
      return;
    }
    case 'zoom_out': {
      drawZoom(ctx, oldC, newC, W, H, 1 - 0.15 * e, 1 - 0.15 * (1 - e), 1 - 0.55 * e);
      return;
    }

    // ---------------------------------------------------------- D 甩镜（残影仅在 0.34s 窗口内，转场时长已保证）
    case 'whip_h': {
      const f = easeInOutCubic(d);
      const off = (dir === 0 ? 1 : -1) * f;
      ctx.drawImage(oldC, -off * W, 0, W, H);
      ctx.globalAlpha = 0.18 * (1 - f);
      ctx.drawImage(newC, (1 - off) * W - off * W * 0.06, 0, W, H);
      ctx.drawImage(newC, (1 - off) * W - off * W * 0.12, 0, W, H);
      ctx.globalAlpha = 1;
      ctx.drawImage(newC, (1 - off) * W, 0, W, H);
      return;
    }
    case 'whip_v': {
      const f = easeInOutCubic(d);
      const off = (dir === 0 ? 1 : -1) * f;
      ctx.drawImage(oldC, 0, -off * H, W, H);
      ctx.globalAlpha = 0.18 * (1 - f);
      ctx.drawImage(newC, 0, (1 - off) * H - off * H * 0.06, W, H);
      ctx.drawImage(newC, 0, (1 - off) * H - off * H * 0.12, W, H);
      ctx.globalAlpha = 1;
      ctx.drawImage(newC, 0, (1 - off) * H, W, H);
      return;
    }
    default: {
      ctx.drawImage(newC, 0, 0, W, H);
      return;
    }
  }
}

function drawZoom(
  ctx: CanvasRenderingContext2D,
  oldC: CanvasImageSource,
  newC: CanvasImageSource,
  W: number,
  H: number,
  oldScale: number,
  newScale: number,
  oldAlpha: number,
): void {
  ctx.save();
  ctx.globalAlpha = Math.max(0, Math.min(1, oldAlpha));
  ctx.translate(W / 2, H / 2);
  ctx.scale(oldScale, oldScale);
  ctx.drawImage(oldC, -W / 2, -H / 2, W, H);
  ctx.restore();
  ctx.save();
  ctx.translate(W / 2, H / 2);
  ctx.scale(newScale, newScale);
  ctx.drawImage(newC, -W / 2, -H / 2, W, H);
  ctx.restore();
}

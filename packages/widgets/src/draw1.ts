// @kine/widgets — draw* 族 上半：motes globe tesseract heart pcb grid membank disk life
import { registerWidget, P, rgba } from '@kine/runtime';
import { clamp, font, frac, hexByte, lerp, phase, smooth, textColor } from './util';

const TAU = Math.PI * 2;

// ── motes：浮尘 ─────────────────────────────────────────────────────
registerWidget({
  name: 'motes',
  defaultSize: { w: 640, h: 400 },
  draw(c) {
    const { ctx, w, h, theme } = c;
    const n = Math.max(10, Math.floor(P(c.props, 'count', 48)));
    const smax = P(c.props, 'size', 2.4) * c.env.ds;
    for (let i = 0; i < n; i++) {
      const u = c.rng(`widget.${c.id}.x`, i);
      const v = c.rng(`widget.${c.id}.y`, i);
      const s = 0.4 + 1.6 * Math.pow(c.rng(`widget.${c.id}.s`, i), 2);
      const ph = c.rng(`widget.${c.id}.ph`, i) * TAU;
      const x = frac(u + c.t * 0.012 * (0.5 + v)) * w;
      const y = frac(v + c.t * 0.006 * (1.2 - u)) * h + Math.sin(c.t * 0.5 + ph) * 6;
      const tw = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(c.t * (0.6 + u) + ph));
      ctx.fillStyle = rgba(theme.text, 0.1 + 0.28 * tw);
      ctx.beginPath();
      ctx.arc(x, y % h, s * smax, 0, TAU);
      ctx.fill();
    }
    c.report({ state: 'motes', measure: { count: n } });
  },
});

// ── globe：线框地球（旋转经线） ─────────────────────────────────────
registerWidget({
  name: 'globe',
  defaultSize: { w: 320, h: 320 },
  draw(c) {
    const { ctx, w, h, theme } = c;
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(w, h) * 0.44;
    const rot = c.t * 0.42;
    ctx.lineWidth = 1;
    // 球面轮廓
    ctx.strokeStyle = rgba(theme.textDim, 0.7);
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, TAU);
    ctx.stroke();
    // 纬线
    for (let k = -2; k <= 2; k++) {
      const lat = (k / 2.6) * (Math.PI / 2);
      const ry = R * Math.cos(lat);
      const yy = cy - R * Math.sin(lat);
      ctx.strokeStyle = rgba(theme.textDim, 0.35);
      ctx.beginPath();
      ctx.ellipse(cx, yy, ry, ry * 0.16, 0, 0, TAU);
      ctx.stroke();
    }
    // 经线（随 rot 相位变化）
    for (let k = 0; k < 6; k++) {
      const ph = rot + (k * Math.PI) / 6;
      const rx = Math.abs(Math.cos(ph)) * R;
      ctx.strokeStyle = rgba(k === 0 ? theme.accent : theme.textDim, k === 0 ? 0.75 : 0.32);
      ctx.beginPath();
      ctx.ellipse(cx, cy, Math.max(1.5, rx), R, 0, 0, TAU);
      ctx.stroke();
    }
    // 城市光点（位于前半球：仅当 cos 相位>0）
    for (let i = 0; i < 14; i++) {
      const lon = c.rng(`widget.${c.id}.lon`, i) * TAU;
      const lat = (c.rng(`widget.${c.id}.lat`, i) - 0.5) * Math.PI * 0.75;
      const rel = lon + rot;
      const zz = Math.cos(rel);
      if (zz <= 0) continue;
      const x = cx + R * Math.cos(lat) * Math.sin(rel);
      const y = cy - R * Math.sin(lat);
      ctx.fillStyle = rgba(theme.text, 0.25 + 0.55 * zz);
      ctx.beginPath();
      ctx.arc(x, y, 1.7, 0, TAU);
      ctx.fill();
    }
    c.report({ state: 'globe', measure: { rotation: +frac(rot / TAU).toFixed(3) } });
  },
});

// ── tesseract：旋转超立方体 ─────────────────────────────────────────
registerWidget({
  name: 'tesseract',
  defaultSize: { w: 320, h: 320 },
  draw(c) {
    const { ctx, w, h, theme } = c;
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(w, h) * 0.4;
    const a1 = c.t * 0.31;
    const a2 = c.t * 0.21;
    const pts: [number, number][] = [];
    for (let i = 0; i < 16; i++) {
      let x = (i & 1) ? 1 : -1;
      let y = (i & 2) ? 1 : -1;
      let z = (i & 4) ? 1 : -1;
      let vw = (i & 8) ? 1 : -1;
      // 平面旋转 x-vw
      const x2 = x * Math.cos(a1) - vw * Math.sin(a1);
      const w2 = x * Math.sin(a1) + vw * Math.cos(a1);
      x = x2;
      // y-z
      const y2 = y * Math.cos(a2) - z * Math.sin(a2);
      const z2 = y * Math.sin(a2) + z * Math.cos(a2);
      y = y2;
      z = z2;
      vw = w2;
      const k = 2.1 / (2.1 + vw);
      pts.push([cx + x * k * R * 0.9, cy + y * k * R * 0.9 - z * k * 8]);
    }
    // 边：顶点 i 与 i^1,i^2,i^4,i^8
    ctx.lineWidth = 1.4;
    for (let i = 0; i < 16; i++) {
      for (const bit of [1, 2, 4, 8]) {
        const j = i ^ bit;
        if (j < i) continue;
        const a = pts[i];
        const b = pts[j];
        const isOuter = bit === 8;
        ctx.strokeStyle = rgba(isOuter ? theme.accent : theme.textDim, isOuter ? 0.75 : 0.4);
        ctx.beginPath();
        ctx.moveTo(a[0], a[1]);
        ctx.lineTo(b[0], b[1]);
        ctx.stroke();
      }
    }
    // 顶点
    ctx.fillStyle = rgba(theme.text, 0.9);
    for (const [x, y] of pts) {
      ctx.beginPath();
      ctx.arc(x, y, 2.2, 0, TAU);
      ctx.fill();
    }
    c.report({ state: 'tesseract', measure: { a1: +frac(a1 / TAU).toFixed(3), a2: +frac(a2 / TAU).toFixed(3) } });
  },
});

// ── heart：粒子心脏（脉搏） ─────────────────────────────────────────
registerWidget({
  name: 'heart',
  defaultSize: { w: 300, h: 300 },
  draw(c) {
    const { ctx, w, h, theme } = c;
    const period = P(c.props, 'period', 1.15);
    const pts = Math.max(150, Math.floor(P(c.props, 'points', 220))); // 下限纪律：figure ≥150
    const cx = w / 2;
    const cy = h * 0.46;
    const scale = Math.min(w, h) * 0.02;
    // 双跳脉冲：ut 一周期内两次收缩
    const ut = frac(c.t / period);
    const beat = Math.exp(-ut * 6) + 0.7 * Math.exp(-Math.abs(ut - 0.24) * 9);
    const pulse = 1 + 0.075 * beat;
    for (let i = 0; i < pts; i++) {
      const u = c.rng(`widget.${c.id}.u`, i);
      const v = c.rng(`widget.${c.id}.v`, i);
      const th = u * TAU;
      // 心形参数方程
      const hx = 16 * Math.pow(Math.sin(th), 3);
      const hy = -(13 * Math.cos(th) - 5 * Math.cos(2 * th) - 2 * Math.cos(3 * th) - Math.cos(4 * th));
      // 内部散点（v 决定径向穿透）
      const rr = Math.pow(v, 0.5);
      const jitter = 1 + 0.05 * Math.sin(c.t * 2.2 + i);
      const x = cx + hx * scale * pulse * rr * jitter;
      const y = cy + hy * scale * pulse * rr * jitter + Math.sin(c.t * 3 + i) * 0.6;
      const a = 0.25 + 0.6 * (1 - rr) + 0.15 * beat;
      ctx.fillStyle = i % 28 === 0 ? rgba(theme.accent, clamp(a, 0, 1)) : rgba(theme.text, clamp(a * 0.75, 0, 1));
      ctx.beginPath();
      ctx.arc(x, y, 1.4 + (i % 5) * 0.16, 0, TAU);
      ctx.fill();
    }
    c.report({ state: 'heart', measure: { beat: +beat.toFixed(3), pulse: +pulse.toFixed(4), points: pts } });
  },
});

// ── pcb：电路板 + 流动脉冲 ──────────────────────────────────────────
registerWidget({
  name: 'pcb',
  defaultSize: { w: 520, h: 320 },
  draw(c) {
    const { ctx, w, h, theme } = c;
    const traces = Math.max(4, Math.floor(P(c.props, 'traces', 10)));
    ctx.lineWidth = 1.4;
    for (let i = 0; i < traces; i++) {
      // 每条走线由 rng 决定：水平/垂直段交替的曼哈顿路径
      const segs = 3 + Math.floor(c.rng(`widget.${c.id}.ns`, i) * 3);
      let x = c.rng(`widget.${c.id}.x`, i) * w * 0.8;
      let y = c.rng(`widget.${c.id}.y`, i) * h * 0.8;
      const pts: [number, number][] = [[x, y]];
      let horiz = c.rng(`widget.${c.id}.dir`, i) > 0.5;
      for (let s = 0; s < segs; s++) {
        const len = (0.12 + 0.3 * c.rng(`widget.${c.id}.len`, i * 17 + s)) * (horiz ? w : h);
        const sign = c.rng(`widget.${c.id}.sg`, i * 29 + s) > 0.5 ? 1 : -1;
        if (horiz) x = clamp(x + len * sign, 4, w - 4);
        else y = clamp(y + len * sign, 4, h - 4);
        pts.push([x, y]);
        horiz = !horiz;
      }
      ctx.strokeStyle = rgba(theme.textDim, 0.42);
      ctx.beginPath();
      ctx.moveTo(pts[0][0], pts[0][1]);
      for (let k = 1; k < pts.length; k++) ctx.lineTo(pts[k][0], pts[k][1]);
      ctx.stroke();
      // 端点焊盘
      for (const [px, py] of [pts[0], pts[pts.length - 1]]) {
        ctx.fillStyle = rgba(theme.text, 0.5);
        ctx.beginPath();
        ctx.arc(px, py, 2.4, 0, TAU);
        ctx.fill();
      }
      // 流量脉冲：沿路径前进（总长参数化）
      let total = 0;
      const lens: number[] = [];
      for (let k = 1; k < pts.length; k++) {
        const d = Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
        lens.push(d);
        total += d;
      }
      const speed = 0.5 + 0.5 * c.rng(`widget.${c.id}.sp`, i);
      const ppos = frac(c.t * speed * 0.42 + c.rng(`widget.${c.id}.ph`, i));
      let rem = ppos * total;
      for (let k = 0; k < lens.length; k++) {
        if (rem <= lens[k]) {
          const u = lens[k] > 0 ? rem / lens[k] : 0;
          const px = lerp(pts[k][0], pts[k + 1][0], u);
          const py = lerp(pts[k][1], pts[k + 1][1], u);
          ctx.fillStyle = rgba(theme.accent, 0.9);
          ctx.beginPath();
          ctx.arc(px, py, 2.6, 0, TAU);
          ctx.fill();
          break;
        }
        rem -= lens[k];
      }
    }
    c.report({ state: 'pcb', measure: { traces } });
  },
});

// ── grid：透视地面网格（向观察者滚动） ──────────────────────────────
registerWidget({
  name: 'grid',
  defaultSize: { w: 640, h: 360 },
  draw(c) {
    const { ctx, w, h, theme } = c;
    const speed = P(c.props, 'speed', 0.55);
    const horizon = h * P(c.props, 'horizon', 0.42);
    const vx = w / 2;
    // 透视竖线
    ctx.lineWidth = 1;
    for (let i = -14; i <= 14; i++) {
      const xb = vx + i * (w / 12);
      const a = 0.32 * (1 - Math.abs(i) / 16);
      if (a <= 0.02) continue;
      ctx.strokeStyle = rgba(i === 0 ? theme.accent : theme.textDim, i === 0 ? 0.5 : a);
      ctx.beginPath();
      ctx.moveTo(vx + i * 4, horizon);
      ctx.lineTo(xb, h);
      ctx.stroke();
    }
    // 横线（对数间距滚动）
    const rows = 16;
    for (let k = 0; k < rows; k++) {
      const u = frac(k / rows + c.t * speed * 0.12);
      const y = horizon + Math.pow(u, 2.4) * (h - horizon);
      const a = (0.06 + 0.36 * u) * 0.7;
      ctx.strokeStyle = rgba(theme.textDim, a);
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
    ctx.fillStyle = rgba(theme.textDim, 0.5);
    ctx.fillRect(0, horizon, w, 1);
    c.report({ state: 'grid', measure: { horizon: +horizon.toFixed(1), speed } });
  },
});

// ── membank：内存转储块（字节矩阵闪变） ─────────────────────────────
registerWidget({
  name: 'membank',
  defaultSize: { w: 440, h: 220 },
  draw(c) {
    const { ctx, w, h, theme } = c;
    const cols = Math.max(6, Math.floor(P(c.props, 'cols', 12)));
    const rows = Math.max(4, Math.floor(P(c.props, 'rows', 6)));
    const rate = P(c.props, 'rate', 3.2);
    const cw = w / cols;
    const ch = h / rows;
    const tick = Math.floor(c.t * rate);
    ctx.font = font(c, ch * 0.42, 400);
    ctx.textBaseline = 'middle';
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const v = c.rng(`widget.${c.id}.byte`, tick * 613 + j * 47 + i);
        const changed = c.rng(`widget.${c.id}.chg`, tick * 613 + j * 47 + i) > 0.8;
        ctx.fillStyle = rgba(theme.textDim, 0.14);
        ctx.fillRect(i * cw + 1, j * ch + 1, cw - 2, ch - 2);
        ctx.fillStyle = changed ? rgba(theme.accent, 0.85) : rgba(theme.text, 0.72);
        const s = hexByte(v);
        ctx.fillText(s, i * cw + cw * 0.24, j * ch + ch / 2);
      }
    }
    c.report({ state: 'membank', measure: { tick, cols, rows } });
  },
});

// ── disk：磁盘盘面 + 磁头扫描 ───────────────────────────────────────
registerWidget({
  name: 'disk',
  defaultSize: { w: 300, h: 300 },
  draw(c) {
    const { ctx, w, h, theme } = c;
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(w, h) * 0.44;
    // 盘面
    ctx.fillStyle = rgba(theme.text, 0.045);
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, TAU);
    ctx.fill();
    ctx.strokeStyle = rgba(theme.textDim, 0.6);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, R, 0, TAU);
    ctx.stroke();
    // 扇区亮片（旋转闪烁代表读写）
    const rot = c.t * 0.9;
    for (let k = 0; k < 24; k++) {
      const a0 = rot + (k * TAU) / 24;
      const on = c.rng(`widget.${c.id}.sec`, k + Math.floor(c.t * 3.1) * 37) > 0.72;
      const R0 = R * (0.42 + 0.5 * c.rng(`widget.${c.id}.r0`, k));
      ctx.strokeStyle = rgba(on ? theme.accent : theme.textDim, on ? 0.75 : 0.16);
      ctx.lineWidth = on ? 2 : 1;
      ctx.beginPath();
      ctx.arc(cx, cy, R0, a0, a0 + TAU / 24 * 0.72);
      ctx.stroke();
    }
    // 同心圆轨
    for (let k = 1; k <= 4; k++) {
      ctx.strokeStyle = rgba(theme.textDim, 0.14);
      ctx.beginPath();
      ctx.arc(cx, cy, (R * k) / 5, 0, TAU);
      ctx.stroke();
    }
    // 磁头臂（扫掠角度）
    const armA = -Math.PI * 0.72 + Math.sin(c.t * 0.7) * 0.5;
    const ax = cx + R * 0.08;
    const ay = cy + R * 1.04;
    ctx.strokeStyle = rgba(theme.text, 0.85);
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(cx + Math.cos(armA) * R * 0.72, cy + Math.sin(armA) * R * 0.72);
    ctx.stroke();
    ctx.fillStyle = rgba(theme.text, 0.9);
    ctx.beginPath();
    ctx.arc(ax, ay, 4.5, 0, TAU);
    ctx.fill();
    ctx.fillStyle = rgba(theme.accent, 0.9);
    ctx.beginPath();
    ctx.arc(cx + Math.cos(armA) * R * 0.72, cy + Math.sin(armA) * R * 0.72, 3.4, 0, TAU);
    ctx.fill();
    c.report({ state: 'disk', measure: { rotation: +frac(rot / TAU).toFixed(3), arm: +armA.toFixed(3) } });
  },
});

// ── life：生命游戏（确定性演化） ────────────────────────────────────
registerWidget({
  name: 'life',
  defaultSize: { w: 480, h: 270 },
  draw(c) {
    const { ctx, w, h, theme } = c;
    const cols = Math.max(12, Math.floor(P(c.props, 'cols', 48)));
    const rows = Math.max(8, Math.floor(P(c.props, 'rows', 27)));
    const stepDur = P(c.props, 'period', 0.16);
    const step = Math.floor(c.t / stepDur);
    const cap = Math.min(step, 400); // 演化上界（保证绘制耗时可控）
    const total = cols * rows;
    let grid = new Uint8Array(total);
    for (let i = 0; i < total; i++) grid[i] = c.rng(`widget.${c.id}.seed`, i) > 0.72 ? 1 : 0;
    let prev = new Uint8Array(grid);
    for (let s = 0; s < cap; s++) {
      const nxt = new Uint8Array(total);
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          let n = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (dx === 0 && dy === 0) continue;
              const xx = (x + dx + cols) % cols;
              const yy = (y + dy + rows) % rows;
              n += grid[yy * cols + xx];
            }
          }
          const idx = y * cols + x;
          nxt[idx] = grid[idx] ? (n === 2 || n === 3 ? 1 : 0) : n === 3 ? 1 : 0;
        }
      }
      prev = grid;
      grid = nxt;
    }
    const cw = w / cols;
    const ch = h / rows;
    for (let y = 0; y < rows; y++) {
      for (let x = 0; x < cols; x++) {
        const idx = y * cols + x;
        if (!grid[idx]) continue;
        const born = !prev[idx];
        ctx.fillStyle = born ? rgba(theme.accent, 0.75) : rgba(theme.text, 0.72);
        ctx.fillRect(x * cw + cw * 0.12, y * ch + ch * 0.12, cw * 0.76, ch * 0.76);
      }
    }
    c.report({ state: 'life', measure: { step, capped: cap, cols, rows } });
  },
});

export {};

// @kine/widgets — draw* 族 下半：classGraph symbols pipeline stars constellations ash telemetry points
import { registerWidget, P, rgba } from '@kine/runtime';
import { clamp, font, frac, lerp, phase, rr, smooth } from './util';

const TAU = Math.PI * 2;

// ── classGraph：类图（节点 + 流动数据点） ───────────────────────────
registerWidget({
  name: 'classGraph',
  defaultSize: { w: 480, h: 320 },
  draw(c) {
    const { ctx, w, h, theme } = c;
    const n = Math.max(3, Math.floor(P(c.props, 'nodes', 5)));
    const bw = w * 0.26;
    const bh = h * 0.16;
    const nodes: { x: number; y: number }[] = [];
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * TAU - Math.PI / 2 + c.t * 0.05;
      nodes.push({ x: w / 2 + Math.cos(ang) * w * 0.33 - bw / 2, y: h / 2 + Math.sin(ang) * h * 0.34 - bh / 2 });
    }
    // 连线 + 数据包
    for (let i = 0; i < n; i++) {
      const a = nodes[i];
      const b = nodes[(i + 1) % n];
      const ax = a.x + bw / 2;
      const ay = a.y + bh / 2;
      const bx = b.x + bw / 2;
      const by = b.y + bh / 2;
      // 正交折线（先横后纵）
      const mx = (ax + bx) / 2;
      ctx.strokeStyle = rgba(theme.textDim, 0.4);
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(mx, ay);
      ctx.lineTo(mx, by);
      ctx.lineTo(bx, by);
      ctx.stroke();
      // 数据点沿折线行进
      const p = frac(c.t * (0.35 + 0.2 * c.rng(`widget.${c.id}.sp`, i)) + c.rng(`widget.${c.id}.ph`, i));
      let px: number;
      let py: number;
      // 折线等分三段：ax→mx 横, mx 竖, mx→bx 横
      const l1 = Math.abs(mx - ax);
      const l2 = Math.abs(by - ay);
      const l3 = Math.abs(bx - mx);
      const tot = l1 + l2 + l3 || 1;
      const d = p * tot;
      if (d < l1) {
        px = ax + Math.sign(mx - ax) * d;
        py = ay;
      } else if (d < l1 + l2) {
        px = mx;
        py = ay + Math.sign(by - ay) * (d - l1);
      } else {
        px = mx + Math.sign(bx - mx) * (d - l1 - l2);
        py = by;
      }
      ctx.fillStyle = rgba(theme.accent, 0.85);
      ctx.beginPath();
      ctx.arc(px, py, 2.6, 0, TAU);
      ctx.fill();
    }
    // 节点框
    nodes.forEach((pos, i) => {
      const active = Math.floor(frac(c.t * 0.4) * n) === i;
      ctx.fillStyle = rgba(theme.text, active ? 0.13 : 0.06);
      rr(ctx, pos.x, pos.y, bw, bh, 5);
      ctx.fill();
      ctx.strokeStyle = rgba(active ? theme.accent : theme.textDim, active ? 0.9 : 0.45);
      ctx.lineWidth = active ? 1.8 : 1;
      rr(ctx, pos.x, pos.y, bw, bh, 5);
      ctx.stroke();
      ctx.fillStyle = rgba(theme.text, 0.8);
      ctx.font = font(c, bh * 0.42, 400);
      ctx.textBaseline = 'middle';
      const label = `${['class', 'fn', 'test', 'data', 'api'][i % 5]}_${i}`;
      ctx.fillText(label, pos.x + 8, pos.y + bh / 2);
    });
    c.report({ state: 'classGraph', measure: { nodes: n } });
  },
});

// ── symbols：符号瀑布 ──────────────────────────────────────────────
registerWidget({
  name: 'symbols',
  defaultSize: { w: 420, h: 300 },
  draw(c) {
    const { ctx, w, h, theme } = c;
    const rate = P(c.props, 'rate', 8);
    const size = Math.max(10, P(c.props, 'size', 15) * c.env.ds);
    ctx.font = font(c, size, 400);
    ctx.textBaseline = 'top';
    const cols = Math.max(6, Math.floor(w / (size * 1.4)));
    const cw = w / cols;
    const tick = Math.floor(c.t * rate);
    for (let i = 0; i < cols; i++) {
      const off = c.rng(`widget.${c.id}.off`, i);
      const row = (tick + Math.floor(off * 17)) % 9;
      for (let k = 0; k < 5; k++) {
        const y = ((row + k) % 9) * (h / 9);
        const v = c.rng(`widget.${c.id}.ch`, i * 89 + k + tick * 13);
        const a = k === 0 ? 0.9 : 0.14 + 0.4 * (1 - k / 5);
        const ch = '!@#$%&*+=<>/\\|{}[]();:~^?ØΔΣπλ'[Math.floor(v * 23)];
        ctx.fillStyle = rgba(theme.text, a);
        ctx.fillText(ch, i * cw + cw * 0.16, y);
      }
    }
    c.report({ state: 'symbols', measure: { tick, cols } });
  },
});

// ── pipeline：构建流水线（阶段推进 + 提交点） ───────────────────────
registerWidget({
  name: 'pipeline',
  defaultSize: { w: 520, h: 110 },
  draw(c) {
    const { ctx, w, h, theme } = c;
    const n = Math.max(3, Math.floor(P(c.props, 'stages', 5)));
    const period = P(c.props, 'period', 3.2);
    const p = phase(c.t, period);
    const cur = p * n;
    const y = h * 0.34;
    const bh = h * 0.32;
    ctx.font = font(c, bh * 0.5, 700);
    ctx.textBaseline = 'middle';
    const bw = (w - (n - 1) * 20) / n;
    for (let i = 0; i < n; i++) {
      const x = i * (bw + 20);
      const done = cur >= i + 1;
      const doing = cur >= i && cur < i + 1;
      ctx.fillStyle = rgba(theme.text, doing ? 0.14 : 0.05);
      rr(ctx, x, y, bw, bh, 4);
      ctx.fill();
      ctx.strokeStyle = rgba(doing ? theme.accent : done ? theme.text : theme.textDim, doing ? 0.95 : done ? 0.6 : 0.35);
      ctx.lineWidth = doing ? 2 : 1;
      rr(ctx, x, y, bw, bh, 4);
      ctx.stroke();
      // 阶段内进度
      if (doing) {
        const f = clamp(cur - i, 0, 1);
        ctx.fillStyle = rgba(theme.accent, 0.28);
        ctx.fillRect(x + 1.5, y + 1.5, (bw - 3) * f, bh - 3);
      }
      ctx.fillStyle = rgba(done ? theme.text : doing ? theme.accent : theme.textDim, 0.9);
      const label = `0${i + 1}`;
      ctx.fillText(label, x + bw / 2 - ctx.measureText(label).width / 2, y + bh / 2);
      // 连接箭头
      if (i < n - 1) {
        ctx.fillStyle = rgba(theme.textDim, 0.5);
        ctx.fillRect(x + bw + 4, y + bh / 2 - 1, 12, 2);
        const px = x + bw + 4 + frac(cur - i) * 12;
        if (doing) {
          ctx.fillStyle = rgba(theme.accent, 0.9);
          ctx.beginPath();
          ctx.arc(px, y + bh / 2, 2.6, 0, TAU);
          ctx.fill();
        }
      }
    }
    // 底部状态行
    const stat = cur >= n ? 'BUILD OK' : `STAGE ${Math.min(n, Math.floor(cur) + 1)}/${n}`;
    ctx.font = font(c, h * 0.13, 400);
    ctx.fillStyle = rgba(theme.textDim, 0.75);
    ctx.fillText(stat, 2, h * 0.86);
    c.report({ state: cur >= n ? 'ok' : 'running', measure: { stage: +cur.toFixed(2), stages: n } });
  },
});

// ── stars：星空闪烁 ─────────────────────────────────────────────────
registerWidget({
  name: 'stars',
  defaultSize: { w: 640, h: 400 },
  draw(c) {
    const { ctx, w, h, theme } = c;
    const n = Math.max(30, Math.floor(P(c.props, 'count', 130)));
    const period = P(c.props, 'period', 2.6);
    for (let i = 0; i < n; i++) {
      const x = c.rng(`widget.${c.id}.x`, i) * w;
      const y = c.rng(`widget.${c.id}.y`, i) * h;
      const ph = c.rng(`widget.${c.id}.ph`, i);
      const base = 0.14 + 0.3 * c.rng(`widget.${c.id}.b`, i);
      const tw = base + 0.55 * Math.max(0, Math.sin((c.t / period + ph) * TAU));
      const big = i % 17 === 0;
      ctx.fillStyle = rgba(theme.text, clamp(tw, 0, 0.95));
      ctx.beginPath();
      ctx.arc(x, y, big ? 2.4 : 1.1 + 0.7 * ph, 0, TAU);
      ctx.fill();
      if (big && tw > 0.45) {
        // 十字星芒（细线）
        ctx.strokeStyle = rgba(theme.text, (tw - 0.45) * 0.5);
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(x - 7, y);
        ctx.lineTo(x + 7, y);
        ctx.moveTo(x, y - 7);
        ctx.lineTo(x, y + 7);
        ctx.stroke();
      }
    }
    c.report({ state: 'stars', measure: { count: n } });
  },
});

// ── constellations：星座连线 ────────────────────────────────────────
registerWidget({
  name: 'constellations',
  defaultSize: { w: 560, h: 360 },
  draw(c) {
    const { ctx, w, h, theme } = c;
    const n = Math.max(8, Math.floor(P(c.props, 'stars', 18)));
    const drift = c.t * 0.014;
    const pts: { x: number; y: number }[] = [];
    for (let i = 0; i < n; i++) {
      const x = frac(c.rng(`widget.${c.id}.x`, i) + drift * (0.5 + c.rng(`widget.${c.id}.px`, i))) * w;
      const y = frac(c.rng(`widget.${c.id}.y`, i) + drift * 0.4) * h;
      pts.push({ x, y });
    }
    // 连接近邻（每点最近 2 个）
    ctx.lineWidth = 1;
    for (let i = 0; i < n; i++) {
      const ds: { j: number; d: number }[] = [];
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        ds.push({ j, d: Math.hypot(pts[i].x - pts[j].x, pts[i].y - pts[j].y) });
      }
      ds.sort((a, b) => a.d - b.d);
      for (let k = 0; k < 2; k++) {
        const j = ds[k].j;
        if (j < i) continue;
        ctx.strokeStyle = rgba(theme.textDim, 0.35);
        ctx.beginPath();
        ctx.moveTo(pts[i].x, pts[i].y);
        ctx.lineTo(pts[j].x, pts[j].y);
        ctx.stroke();
      }
    }
    // 星点 + 闪烁
    for (let i = 0; i < n; i++) {
      const tw = 0.4 + 0.5 * (0.5 + 0.5 * Math.sin((c.t / 2.2 + c.rng(`widget.${c.id}.ph`, i)) * TAU));
      ctx.fillStyle = rgba(theme.text, tw);
      ctx.beginPath();
      ctx.arc(pts[i].x, pts[i].y, 1.8, 0, TAU);
      ctx.fill();
      if (i % 6 === 0) {
        ctx.fillStyle = rgba(theme.accent, tw * 0.9);
        ctx.beginPath();
        ctx.arc(pts[i].x, pts[i].y, 2.6, 0, TAU);
        ctx.fill();
      }
    }
    c.report({ state: 'constellations', measure: { stars: n } });
  },
});

// ── ash：灰烬上升 ───────────────────────────────────────────────────
registerWidget({
  name: 'ash',
  defaultSize: { w: 560, h: 340 },
  draw(c) {
    const { ctx, w, h, theme } = c;
    const n = Math.max(16, Math.floor(P(c.props, 'count', 60)));
    for (let i = 0; i < n; i++) {
      const u = c.rng(`widget.${c.id}.x`, i);
      const v = c.rng(`widget.${c.id}.y`, i);
      const sp = 0.03 + 0.06 * c.rng(`widget.${c.id}.sp`, i);
      const y = h - frac(v + c.t * sp) * (h * 1.12);
      const sway = Math.sin(c.t * (0.6 + u) + i) * (8 + 14 * v);
      const x = frac(u + Math.sin(c.t * 0.2 + i) * 0.01) * w + sway * 0.3;
      const life = clamp((y / h) * 1.2, 0, 1); // 越高越淡
      const ember = i % 9 === 0;
      const tw = 0.5 + 0.5 * Math.sin(c.t * 3.4 + i * 1.7);
      ctx.fillStyle = ember ? rgba(theme.accent, 0.2 + 0.3 * tw * life) : rgba(theme.text, 0.12 + 0.3 * life * (0.5 + 0.5 * tw));
      ctx.beginPath();
      ctx.arc(x, y, 1 + 1.6 * v, 0, TAU);
      ctx.fill();
    }
    c.report({ state: 'ash', measure: { count: n } });
  },
});

// ── telemetry：遥测读数（数字 + 迷你曲线） ──────────────────────────
registerWidget({
  name: 'telemetry',
  defaultSize: { w: 340, h: 220 },
  draw(c) {
    const { ctx, w, h, theme } = c;
    const rows = Math.max(2, Math.floor(P(c.props, 'rows', 5)));
    const rh = h / rows;
    const labels = ['CPU', 'MEM', 'NET', 'BEAT', 'FPS', 'LAT', 'JIT', 'IO'];
    for (let r = 0; r < rows; r++) {
      const y0 = r * rh;
      const lab = labels[r % labels.length];
      // 值：慢漂 + 快抖（确定性）
      const slow = 0.5 + 0.5 * Math.sin(c.t * (0.3 + r * 0.11) + r);
      const fast = c.rng(`widget.${c.id}.fast`, r * 31 + Math.floor(c.t * 6));
      const val = clamp(slow * 0.75 + fast * 0.25, 0, 1);
      ctx.fillStyle = rgba(theme.textDim, 0.7);
      ctx.font = font(c, rh * 0.34, 400);
      ctx.textBaseline = 'middle';
      ctx.fillText(lab, 0, y0 + rh * 0.32);
      ctx.fillStyle = rgba(val > 0.82 ? theme.accent : theme.text, 0.9);
      const valS = `${(val * 100).toFixed(1)}%`;
      ctx.fillText(valS, w * 0.3 - ctx.measureText(valS).width, y0 + rh * 0.32);
      // 迷你曲线
      const gx = w * 0.34;
      const gw = w - gx - 4;
      const gh = rh * 0.34;
      const gy = y0 + rh * 0.15;
      ctx.beginPath();
      const segs = 22;
      for (let s = 0; s <= segs; s++) {
        const vv = clamp(0.5 + 0.5 * Math.sin(c.t * (0.7 + r * 0.13) + (s / segs) * 6 + c.rng(`widget.${c.id}.wv`, r * 7 + s) * 0.8), 0, 1);
        const x = gx + (s / segs) * gw;
        const y = gy + gh - vv * gh;
        if (s === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = rgba(theme.textDim, 0.65);
      ctx.lineWidth = 1;
      ctx.stroke();
      // 分隔线
      ctx.fillStyle = rgba(theme.textDim, 0.18);
      ctx.fillRect(0, y0 + rh - 1, w, 1);
    }
    c.report({ state: 'telemetry', measure: { rows } });
  },
});

// ── points：点云形态变换 ────────────────────────────────────────────
registerWidget({
  name: 'points',
  defaultSize: { w: 340, h: 340 },
  draw(c) {
    const { ctx, w, h, theme } = c;
    const n = Math.max(60, Math.floor(P(c.props, 'count', 180)));
    const period = P(c.props, 'period', 5.2);
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(w, h) * 0.4;
    // 形状参数函数：0=圆 1=方 2=三角 3=十字
    const shape = (kind: number, u: number): [number, number] => {
      if (kind === 0) {
        const a = u * TAU;
        return [Math.cos(a), Math.sin(a)];
      }
      if (kind === 1) {
        const s = u * 4;
        const edge = Math.floor(s) % 4;
        const f = s - Math.floor(s) - 0.5;
        if (edge === 0) return [f * 2, -1];
        if (edge === 1) return [1, f * 2];
        if (edge === 2) return [-f * 2, 1];
        return [-1, -f * 2];
      }
      if (kind === 2) {
        const s = u * 3;
        const edge = Math.floor(s) % 3;
        const f = s - Math.floor(s) - 0.5;
        const p0 = [0, -1];
        const p1 = [0.87, 0.5];
        const p2 = [-0.87, 0.5];
        const a = [p0, p1, p2][edge];
        const b = [p1, p2, p0][edge];
        return [lerp(a[0], b[0], f + 0.5), lerp(a[1], b[1], f + 0.5)];
      }
      const half = u % 0.5;
      const vert = u < 0.5;
      const f = (u * 2) % 1 - 0.5;
      if (vert) return [f * 2.2, u < 0.25 ? -1 : 1];
      return [u < 0.75 ? -1 : 1, f * 2.2];
    };
    const p = phase(c.t, period);
    const from = Math.floor(c.t / period) % 4;
    const to = (from + 1) % 4;
    const morph = smooth(clamp((p - 0.72) / 0.28, 0, 1)); // 尾段 28% 做变换
    const rot = c.t * 0.18;
    for (let i = 0; i < n; i++) {
      const u = c.rng(`widget.${c.id}.u`, i);
      const jitter = 0.94 + 0.12 * c.rng(`widget.${c.id}.j`, i);
      const [ax, ay] = shape(from, u);
      const [bx, by] = shape(to, u);
      const x0 = lerp(ax, bx, morph) * R * jitter;
      const y0 = lerp(ay, by, morph) * R * jitter;
      const xr = x0 * Math.cos(rot) - y0 * Math.sin(rot);
      const yr = x0 * Math.sin(rot) + y0 * Math.cos(rot);
      const a = 0.3 + 0.55 * (0.5 + 0.5 * Math.sin(c.t * 1.8 + i * 0.7));
      ctx.fillStyle = i % 23 === 0 ? rgba(theme.accent, a) : rgba(theme.text, a * 0.85);
      ctx.beginPath();
      ctx.arc(cx + xr, cy + yr, 1.6 + (i % 4) * 0.3, 0, TAU);
      ctx.fill();
    }
    c.report({ state: morph > 0 ? 'morphing' : 'hold', measure: { morph: +morph.toFixed(3), from, to } });
  },
});

export {};

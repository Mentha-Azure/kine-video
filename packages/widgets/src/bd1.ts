// @kine/widgets — bd* 族（信息面板风格） 上半：bdBG bdTitle bdKey bdLive bdScan bdPulse bdBars bdRing
import { registerWidget, P, type WidgetDrawCtx } from '@kine/runtime';
import { rgba } from '@kine/runtime';
import { clamp, frac, font, gridOf, lerp, phase, rr, smooth, textColor, tickBlink } from './util';

// ── bdBG：底纹网格 + 扫描带 + 随机亮格 ───────────────────────────────
registerWidget({
  name: 'bdBG',
  defaultSize: { w: 520, h: 300 },
  draw(c) {
    const { ctx, w, h, theme } = c;
    const cell = P(c.props, 'cell', 26) * c.env.ds;
    const sweep = P(c.props, 'sweep', 7);
    const cols = Math.max(4, Math.round(w / cell));
    const rows = Math.max(3, Math.round(h / cell));
    const cw = w / cols;
    const ch = h / rows;
    const bandY = phase(c.t, sweep) * h;
    ctx.lineWidth = 1;
    // 网格线
    ctx.strokeStyle = rgba(theme.textDim, 0.1);
    ctx.beginPath();
    for (let i = 1; i < cols; i++) {
      ctx.moveTo(i * cw, 0);
      ctx.lineTo(i * cw, h);
    }
    for (let j = 1; j < rows; j++) {
      ctx.moveTo(0, j * ch);
      ctx.lineTo(w, j * ch);
    }
    ctx.stroke();
    // 扫描带（被覆盖的格子提亮）
    for (let i = 0; i < cols; i++) {
      for (let j = 0; j < rows; j++) {
        const cy = (j + 0.5) * ch;
        const d = Math.abs(cy - bandY);
        if (d > ch * 1.2) continue;
        const a = (1 - d / (ch * 1.2)) * 0.2;
        ctx.fillStyle = rgba(theme.text, a * 0.9);
        ctx.fillRect(i * cw + 1, j * ch + 1, cw - 2, ch - 2);
      }
    }
    // 随机亮格：每 tick 变化
    const tick = Math.floor(c.t * 2.2);
    for (let i = 0; i < cols; i += 2) {
      for (let j = 0; j < rows; j += 2) {
        const v = c.rng(`widget.${c.id}.flick`, i * 101 + j * 7 + tick * 9176);
        if (v > 0.92) {
          ctx.fillStyle = rgba(theme.accent, 0.16);
          ctx.fillRect(i * cw + 1, j * ch + 1, cw - 2, ch - 2);
        }
      }
    }
    c.report({ state: 'sweep', measure: { cell: cell / c.env.ds, band_y: +bandY.toFixed(1) } });
  },
});

// ── bdTitle：大标题 + 逐字打出 + 下划线扫掠 ─────────────────────────
registerWidget({
  name: 'bdTitle',
  defaultSize: { w: 640, h: 150 },
  draw(c) {
    const { ctx, w, h, theme } = c;
    const text = String(P(c.props, 'text', 'WORLD.EXECUTE'));
    const sub = String(P(c.props, 'sub', ''));
    const size = P(c.props, 'size', 44) * c.env.ds;
    const typePeriod = P(c.props, 'type_period', 0.05);
    const align = String(P(c.props, 'align', 'left')); // v4：left（默认）/ center / right——此前固定左对齐易被误认为居中
    const visible = typePeriod > 0 ? Math.floor(c.t / typePeriod) : text.length;
    const shown = text.slice(0, Math.max(0, visible));
    const done = visible >= text.length;
    ctx.fillStyle = rgba(theme.text, 0.95);
    ctx.font = font(c, size, 700);
    ctx.textBaseline = 'top';
    const tw = ctx.measureText(text).width;
    const tx = align === 'center' ? -tw / 2 : align === 'right' ? -tw : 0;
    ctx.fillText(shown + (done ? '' : '▍'), tx, 0);
    if (sub) {
      ctx.font = font(c, size * 0.34, 400);
      ctx.fillStyle = rgba(theme.textDim, 0.85);
      const subW = ctx.measureText(sub).width;
      const subX = align === 'center' ? tx + (tw - subW) / 2 : align === 'right' ? tx + (tw - subW) : 2;
      ctx.fillText(sub, subX, size * 1.3);
    }
    // 下划线扫掠：t 周期内从左到右
    const p = phase(c.t, P(c.props, 'underline_period', 2.6));
    const uw = tw * smooth(p * 2.2);
    ctx.fillStyle = rgba(theme.accent, 0.85);
    ctx.fillRect(tx, size * 1.12, uw, Math.max(2, size * 0.05));
    // 光标闪烁
    if (!done && Math.floor(c.t / 0.4) % 2 === 0) {
      const cw = ctx.measureText(shown).width;
      ctx.fillStyle = rgba(theme.accent, 0.75);
      ctx.fillRect(tx + cw + size * 0.06, 0, size * 0.52, size * 0.96);
    }
    c.report({ state: done ? 'done' : 'typing', measure: { chars_visible: Math.min(visible, text.length), chars_total: text.length, underline: +uw.toFixed(1) } });
  },
});

// ── bdKey：键位行（周期性高亮按下） ─────────────────────────────────
registerWidget({
  name: 'bdKey',
  defaultSize: { w: 420, h: 90 },
  draw(c) {
    const { ctx, w, h, theme } = c;
    const keys = String(P(c.props, 'keys', 'W A S D')).split(/\s+/).filter(Boolean);
    const period = P(c.props, 'period', 0.62);
    const step = Math.floor(c.t / period);
    const lit = ((step % keys.length) + keys.length) % keys.length;
    const kw = Math.min((w - 8 * (keys.length - 1)) / keys.length, h * 0.92);
    const kh = kw * 0.92;
    const y = (h - kh) / 2;
    keys.forEach((k, i) => {
      const x = i * (kw + 8);
      const on = i === lit;
      const press = on ? smooth(1 - frac(c.t / period) * 2.6) : 0;
      ctx.fillStyle = rgba(theme.text, on ? 0.1 + 0.14 * press : 0.05);
      rr(ctx, x, y + press * kh * 0.06, kw, kh, 6);
      ctx.fill();
      ctx.strokeStyle = rgba(on ? theme.accent : theme.textDim, on ? 0.85 : 0.35);
      ctx.lineWidth = on ? 2 : 1;
      rr(ctx, x, y + press * kh * 0.06, kw, kh, 6);
      ctx.stroke();
      ctx.fillStyle = on ? rgba(theme.accent, 0.98) : rgba(theme.textDim, 0.8);
      ctx.font = font(c, kw * 0.42, on ? 700 : 400);
      ctx.textBaseline = 'middle';
      ctx.fillText(k, x + kw / 2 - ctx.measureText(k).width / 2, y + kh * 0.52 + press * kh * 0.06);
    });
    c.report({ state: 'key', measure: { lit_index: lit, press: +clamp(1 - frac(c.t / period) * 2.6, 0, 1).toFixed(3) } });
  },
});

// ── bdLive：LIVE 指示 + 计时 ────────────────────────────────────────
registerWidget({
  name: 'bdLive',
  defaultSize: { w: 300, h: 54 },
  draw(c) {
    const { ctx, w, h, theme } = c;
    const label = String(P(c.props, 'label', 'LIVE'));
    const blink = 0.45 + 0.55 * Math.max(0, Math.sin((c.t / 0.8) * Math.PI * 2));
    const r = h * 0.22;
    ctx.fillStyle = rgba(theme.accent, 0.35 + 0.6 * blink);
    ctx.beginPath();
    ctx.arc(r + 4, h / 2, r, 0, Math.PI * 2);
    ctx.fill();
    if (blink > 0.9) {
      ctx.strokeStyle = rgba(theme.accent, 0.3);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(r + 4, h / 2, r + 6, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = rgba(theme.text, 0.9);
    ctx.font = font(c, h * 0.36, 700);
    ctx.textBaseline = 'middle';
    ctx.fillText(label, r * 2 + 16, h / 2);
    // 计时（秒表，随 t 变化）
    const secs = Math.floor(c.t);
    const mm = String(Math.floor(secs / 60)).padStart(2, '0');
    const ss = String(secs % 60).padStart(2, '0');
    const cs = String(Math.floor(frac(c.t) * 100)).padStart(2, '0');
    ctx.fillStyle = rgba(theme.accent, 0.95);
    ctx.font = font(c, h * 0.34, 400);
    const tm = `${mm}:${ss}.${cs}`;
    ctx.fillText(tm, w - ctx.measureText(tm).width, h / 2);
    c.report({ state: 'live', measure: { blink: +blink.toFixed(3), seconds: secs } });
  },
});

// ── bdScan：扫描条 + 条码流 ─────────────────────────────────────────
registerWidget({
  name: 'bdScan',
  defaultSize: { w: 420, h: 120 },
  draw(c) {
    const { ctx, w, h, theme } = c;
    const period = P(c.props, 'period', 2.4);
    const p = phase(c.t, period);
    const y = p * h;
    ctx.lineWidth = 1;
    // 条码柱
    const n = Math.floor(w / 9);
    for (let i = 0; i < n; i++) {
      const v = c.rng(`widget.${c.id}.bar`, i + Math.floor(c.t / 0.5) * 101);
      const bw = (v > 0.62 ? 4 : v > 0.3 ? 2 : 1) * 1.4;
      ctx.fillStyle = rgba(theme.textDim, 0.35 + 0.3 * v);
      ctx.fillRect(i * 9 + 2, h * 0.18, bw, h * 0.64);
    }
    // 扫描线 + 余辉
    const grad = ctx.createLinearGradient(0, y - h * 0.3, 0, y);
    grad.addColorStop(0, rgba(theme.accent, 0));
    grad.addColorStop(1, rgba(theme.accent, 0.28));
    ctx.fillStyle = grad;
    ctx.fillRect(0, Math.max(0, y - h * 0.3), w, Math.min(h * 0.3, y));
    ctx.fillStyle = rgba(theme.accent, 0.9);
    ctx.fillRect(0, y - 1, w, 2);
    // 读数
    ctx.font = font(c, 12, 400);
    ctx.fillStyle = rgba(theme.textDim, 0.7);
    ctx.fillText(`SCAN ${String(Math.floor(p * 100)).padStart(3, ' ')}%`, 6, 14);
    c.report({ state: 'scan', measure: { scan_y: +y.toFixed(1), progress: +p.toFixed(3) } });
  },
});

// ── bdPulse：心电/波形滚动线 ────────────────────────────────────────
registerWidget({
  name: 'bdPulse',
  defaultSize: { w: 480, h: 120 },
  draw(c) {
    const { ctx, w, h, theme } = c;
    const period = P(c.props, 'period', 1.05);
    const amp = P(c.props, 'amp', 0.36) * h;
    const base = h * 0.62;
    const speed = w / period; // 每周期滚过整宽 = 连续滚动
    ctx.beginPath();
    for (let x = 0; x <= w; x += 2) {
      const u = frac(frac((x + c.t * speed) / w) + 0.5);
      // 尖锐 QRS 脉冲
      const g1 = Math.exp(-Math.pow((u - 0.5) / 0.012, 2));
      const g2 = Math.exp(-Math.pow((u - 0.53) / 0.02, 2)) * 0.4;
      const g3 = Math.exp(-Math.pow(((u - 1) / 0.05), 2)) * 1.6 + Math.exp(-Math.pow(u / 0.05, 2)) * 1.6;
      const small = Math.sin(u * Math.PI * 2 * 3) * 0.03;
      const y = base - amp * (g1 - g2 + g3 * 0.35 + small);
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = rgba(theme.accent, 0.85);
    ctx.lineWidth = 1.6;
    ctx.stroke();
    // 尾部渐隐遮罩感：起点处叠暗
    const grad = ctx.createLinearGradient(0, 0, w * 0.18, 0);
    grad.addColorStop(0, rgba(theme.bg[0], 0.9));
    grad.addColorStop(1, rgba(theme.bg[0], 0));
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w * 0.18, h);
    // 底线
    ctx.fillStyle = rgba(theme.textDim, 0.25);
    ctx.fillRect(0, base + 1, w, 1);
    c.report({ state: 'pulse', measure: { period, amp_px: +amp.toFixed(1) } });
  },
});

// ── bdBars：频谱柱 ──────────────────────────────────────────────────
registerWidget({
  name: 'bdBars',
  defaultSize: { w: 420, h: 140 },
  draw(c) {
    const { ctx, w, h, theme } = c;
    const n = Math.max(6, Math.floor(P(c.props, 'bars', 24)));
    const period = P(c.props, 'period', 1.6);
    const bw = (w - (n - 1) * 3) / n;
    let maxI = 0;
    let maxV = 0;
    const vals: number[] = [];
    for (let i = 0; i < n; i++) {
      const v0 = c.rng(`widget.${c.id}.bar`, i);
      const v = 0.5 + 0.5 * Math.sin(Math.PI * 2 * (c.t / period + v0));
      const vv = 0.12 + 0.88 * Math.pow(v, 1.6) * (0.4 + 0.6 * v0);
      vals.push(vv);
      if (vv > maxV) {
        maxV = vv;
        maxI = i;
      }
    }
    vals.forEach((v, i) => {
      const bh = v * h * 0.92;
      const x = i * (bw + 3);
      ctx.fillStyle = rgba(theme.textDim, 0.5);
      ctx.fillRect(x, h - bh, bw, bh);
      if (i === maxI) {
        ctx.fillStyle = rgba(theme.accent, 0.9);
        ctx.fillRect(x, h - bh, bw, Math.min(3, bh));
      }
    });
    ctx.fillStyle = rgba(theme.textDim, 0.3);
    ctx.fillRect(0, h - 1, w, 1);
    c.report({ state: 'bars', measure: { peak_index: maxI, peak: +maxV.toFixed(3) } });
  },
});

// ── bdRing：同心进度环 ──────────────────────────────────────────────
registerWidget({
  name: 'bdRing',
  defaultSize: { w: 240, h: 240 },
  draw(c) {
    const { ctx, w, h, theme } = c;
    const rings = Math.max(1, Math.floor(P(c.props, 'rings', 3)));
    const period = P(c.props, 'period', 3.2);
    const cx = w / 2;
    const cy = h / 2;
    const R = Math.min(w, h) * 0.46;
    for (let i = 0; i < rings; i++) {
      const r = R * (1 - i * 0.24);
      const speed = (i % 2 === 0 ? 1 : -1) * (1 + i * 0.35) / period;
      const a0 = c.t * speed * Math.PI * 2;
      const arc = Math.PI * (1.1 + 0.5 * Math.sin(c.t / period + i));
      ctx.beginPath();
      ctx.arc(cx, cy, r, a0, a0 + arc);
      ctx.strokeStyle = i === 0 ? rgba(theme.accent, 0.85) : rgba(theme.textDim, 0.55 - i * 0.1);
      ctx.lineWidth = Math.max(1.5, (rings - i) * 1.6);
      ctx.stroke();
      // 刻度点
      const dotA = a0 + arc;
      ctx.fillStyle = rgba(theme.text, 0.9);
      ctx.beginPath();
      ctx.arc(cx + Math.cos(dotA) * r, cy + Math.sin(dotA) * r, 2.2, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = rgba(theme.text, 0.92);
    ctx.font = font(c, R * 0.24, 700);
    ctx.textBaseline = 'middle';
    const txt = `${Math.floor(phase(c.t, period) * 100)}%`;
    ctx.fillText(txt, cx - ctx.measureText(txt).width / 2, cy + R * 0.55);
    c.report({ state: 'ring', measure: { rings, progress: +phase(c.t, period).toFixed(3) } });
  },
});

export {};

// @kine/widgets — bd* 族 下半：bdCells bdWave bdHex bdCursor bdRainDrops bdFlow bdDial bdTerminal
import { registerWidget, P, rgba } from '@kine/runtime';
import { clamp, font, frac, hexByte, lerp, phase, rr, smooth, textColor, tickBlink } from './util';

// ── bdCells：网格亮灭（每 tick 台上台下） ──────────────────────────
registerWidget({
  name: 'bdCells',
  defaultSize: { w: 420, h: 240 },
  draw(c) {
    const { ctx, w, h, theme } = c;
    const cols = Math.max(4, Math.floor(P(c.props, 'cols', 14)));
    const rows = Math.max(3, Math.floor(P(c.props, 'rows', 8)));
    const period = P(c.props, 'period', 0.85);
    const cw = w / cols;
    const ch = h / rows;
    const tick = Math.floor(c.t / period);
    const f = frac(c.t / period);
    for (let j = 0; j < rows; j++) {
      for (let i = 0; i < cols; i++) {
        const v = c.rng(`widget.${c.id}.cell`, tick * 977 + j * 131 + i);
        const on = v > 0.58;
        const edge = smooth(clamp(f * 3, 0, 1)) * (1 - smooth(clamp((f - 0.7) * 3, 0, 1)));
        const a = on ? 0.14 + 0.3 * (0.6 + 0.4 * v) : 0.05;
        ctx.fillStyle = rgba(on ? theme.text : theme.textDim, a * (0.35 + 0.65 * edge));
        ctx.fillRect(i * cw + 2, j * ch + 2, cw - 4, ch - 4);
        if (v > 0.93) {
          ctx.fillStyle = rgba(theme.accent, 0.5 * edge);
          ctx.fillRect(i * cw + 2, j * ch + 2, cw - 4, 3);
        }
      }
    }
    c.report({ state: 'cells', measure: { tick, cols, rows } });
  },
});

// ── bdWave：多道正弦波带 ────────────────────────────────────────────
registerWidget({
  name: 'bdWave',
  defaultSize: { w: 480, h: 160 },
  draw(c) {
    const { ctx, w, h, theme } = c;
    const waves = Math.max(1, Math.floor(P(c.props, 'waves', 3)));
    const speed = P(c.props, 'speed', 0.9);
    for (let k = 0; k < waves; k++) {
      const base = h * (0.24 + 0.26 * k);
      const amp = h * (0.16 - 0.035 * k);
      const freq = 2.2 + k * 1.4;
      const ph = c.t * speed * (0.7 + 0.25 * k);
      ctx.beginPath();
      for (let x = 0; x <= w; x += 3) {
        const y = base + Math.sin((x / w) * Math.PI * 2 * freq + ph * Math.PI * 2) * amp;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = k === 0 ? rgba(theme.accent, 0.8) : rgba(theme.textDim, 0.6 - k * 0.12);
      ctx.lineWidth = k === 0 ? 1.8 : 1.1;
      ctx.stroke();
      // 采样点
      if (k === 0) {
        ctx.fillStyle = rgba(theme.text, 0.9);
        for (let x = 0; x <= w; x += w / 12) {
          const y = base + Math.sin((x / w) * Math.PI * 2 * freq + ph * Math.PI * 2) * amp;
          ctx.beginPath();
          ctx.arc(x, y, 2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    c.report({ state: 'wave', measure: { waves, phase: +phase(c.t, 1 / Math.max(0.01, speed)).toFixed(3) } });
  },
});

// ── bdHex：十六进制转储滚动 ────────────────────────────────────────
registerWidget({
  name: 'bdHex',
  defaultSize: { w: 460, h: 260 },
  draw(c) {
    const { ctx, w, h, theme } = c;
    const lines = Math.max(4, Math.floor(P(c.props, 'lines', 12)));
    const speed = P(c.props, 'speed', 1.4);
    const lh = h / (lines + 0.5);
    ctx.font = font(c, lh * 0.62, 400);
    ctx.textBaseline = 'top';
    const scroll = frac(c.t * speed * 0.14) * lh;
    const rowH = 8;
    const rowW = 12;
    for (let r = -1; r <= lines; r++) {
      const rowIdx = Math.floor(c.t * speed * 0.14 + r);
      const y = r * lh - scroll + lh * 0.2;
      if (y < -lh || y > h) continue;
      const addr = (0x9000 + ((rowIdx * rowH) & 0xfff0)).toString(16).toUpperCase().padStart(4, '0');
      ctx.fillStyle = rgba(theme.textDim, 0.55);
      ctx.fillText(addr, 0, y);
      let hexs = '';
      for (let b = 0; b < rowH; b++) {
        const v = c.rng(`widget.${c.id}.hex`, rowIdx * 131 + b);
        hexs += hexByte(v) + ' ';
      }
      ctx.fillStyle = rgba(theme.text, 0.72);
      ctx.fillText(hexs, lh * 2.4, y);
      // 高亮变化的字节列（每 tick 换一列）
      const hl = Math.floor(phase(c.t, 0.4) * rowH);
      const hlX = lh * 2.4 + hl * ctx.measureText('0 ').width;
      ctx.fillStyle = rgba(theme.accent, 0.7);
      ctx.fillRect(hlX, y + lh * 0.1, ctx.measureText('0').width * 0.95, lh * 0.66);
    }
    ctx.fillStyle = rgba(theme.textDim, 0.25);
    ctx.fillRect(0, h - 1, w, 1);
    c.report({ state: 'hex', measure: { lines, scroll: +scroll.toFixed(1) } });
  },
});

// ── bdCursor：终端行（打字循环 + 光标） ─────────────────────────────
registerWidget({
  name: 'bdCursor',
  defaultSize: { w: 460, h: 60 },
  draw(c) {
    const { ctx, w, h, theme } = c;
    const text = String(P(c.props, 'text', 'kine render --range 0:5'));
    const period = P(c.props, 'period', 3.4);
    const size = P(c.props, 'size', 20) * c.env.ds;
    const p = phase(c.t, period);
    // 0-0.62 打字，0.62-0.86 停留，0.86-1 清空
    const chars = p < 0.62 ? Math.floor((p / 0.62) * (text.length + 1)) : p < 0.86 ? text.length : 0;
    ctx.font = font(c, size, 400);
    ctx.textBaseline = 'middle';
    const y = h / 2;
    ctx.fillStyle = rgba(theme.accent, 0.9);
    const prompt = '$';
    ctx.fillText(prompt, 0, y);
    const pw = ctx.measureText(prompt + ' ').width;
    ctx.fillStyle = rgba(theme.text, 0.92);
    const shown = text.slice(0, chars);
    ctx.fillText(shown, pw, y);
    // 光标
    const blink = Math.floor(c.t / 0.4) % 2 === 0;
    if (blink) {
      const cx = pw + ctx.measureText(shown).width + 2;
      ctx.fillStyle = rgba(theme.accent, 0.85);
      ctx.fillRect(cx, y - size * 0.5, size * 0.5, size);
    }
    c.report({ state: 'cursor', measure: { chars_visible: shown.length, chars_total: text.length } });
  },
});

// ── bdRainDrops：数字雨 ─────────────────────────────────────────────
registerWidget({
  name: 'bdRainDrops',
  defaultSize: { w: 420, h: 320 },
  draw(c) {
    const { ctx, w, h, theme } = c;
    const drops = Math.max(6, Math.floor(P(c.props, 'drops', 26)));
    const speed = P(c.props, 'speed', 1) * 120;
    const size = Math.max(9, P(c.props, 'size', 13) * c.env.ds);
    ctx.font = font(c, size, 400);
    ctx.textBaseline = 'top';
    const cols = Math.max(6, Math.floor(w / (size * 1.05)));
    const cw = w / cols;
    for (let i = 0; i < drops; i++) {
      const col = Math.floor(c.rng(`widget.${c.id}.col`, i) * cols);
      const off = c.rng(`widget.${c.id}.off`, i);
      const sp = speed * (0.55 + 0.9 * c.rng(`widget.${c.id}.sp`, i));
      const len = 6 + Math.floor(10 * c.rng(`widget.${c.id}.len`, i));
      const yHead = frac((c.t * sp + off * h * 13) / (h + len * size * 1.1)) * (h + len * size * 1.1) - len * size * 1.1;
      for (let k = 0; k <= len; k++) {
        const y = yHead - k * size * 1.05;
        if (y < -size || y > h) continue;
        const a = k === 0 ? 0.98 : Math.max(0.06, 0.5 - k * 0.045);
        const ch = k === 0 ? '█' : String.fromCharCode(0x30a0 + Math.floor(c.rng(`widget.${c.id}.ch`, i * 57 + k + Math.floor((y + c.t * sp) / size) * 3) * 96));
        ctx.fillStyle = k === 0 ? rgba(theme.text, 0.95) : rgba(theme.textDim, a);
        ctx.fillText(ch, col * cw + cw * 0.08, y);
      }
    }
    c.report({ state: 'rain', measure: { drops, speed_px: speed } });
  },
});

// ── bdFlow：流水线（节点 + 数据包） ────────────────────────────────
registerWidget({
  name: 'bdFlow',
  defaultSize: { w: 520, h: 120 },
  draw(c) {
    const { ctx, w, h, theme } = c;
    const n = Math.max(2, Math.floor(P(c.props, 'nodes', 5)));
    const period = P(c.props, 'period', 2.8);
    const bw = Math.min(w / n - 14, 74);
    const bh = h * 0.42;
    const y = h * 0.5 - bh / 2;
    const cyc = phase(c.t, period);
    const progress = cyc * (n - 1);
    for (let i = 0; i < n; i++) {
      const x = (w - n * bw - (n - 1) * 14) / 2 + i * (bw + 14);
      const active = progress >= i && progress < i + 1;
      const done = progress >= i + 1;
      ctx.fillStyle = rgba(theme.text, done ? 0.12 : active ? 0.16 : 0.06);
      rr(ctx, x, y, bw, bh, 7);
      ctx.fill();
      ctx.strokeStyle = rgba(active ? theme.accent : theme.textDim, active ? 0.95 : done ? 0.55 : 0.3);
      ctx.lineWidth = active ? 2 : 1;
      rr(ctx, x, y, bw, bh, 7);
      ctx.stroke();
      // 节点序号/状态
      ctx.fillStyle = rgba(active ? theme.accent : theme.textDim, 0.9);
      ctx.font = font(c, bh * 0.34, 700);
      ctx.textBaseline = 'middle';
      const label = done ? '✓' : String(i + 1);
      ctx.fillText(label, x + bw / 2 - ctx.measureText(label).width / 2, y + bh / 2);
      // 连线与数据包
      if (i < n - 1) {
        const lx = x + bw;
        const ly = y + bh / 2;
        ctx.fillStyle = rgba(theme.textDim, 0.4);
        ctx.fillRect(lx, ly - 1, 14, 2);
        const pp = clamp(progress - i, 0, 1);
        if (progress > i && progress < i + 1) {
          ctx.fillStyle = rgba(theme.accent, 0.95);
          ctx.beginPath();
          ctx.arc(lx + pp * 14, ly, 3.2, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
    c.report({ state: 'flow', measure: { nodes: n, progress: +progress.toFixed(2) } });
  },
});

// ── bdDial：仪表盘 ──────────────────────────────────────────────────
registerWidget({
  name: 'bdDial',
  defaultSize: { w: 220, h: 180 },
  draw(c) {
    const { ctx, w, h, theme } = c;
    const period = P(c.props, 'period', 3.6);
    const segs = Math.max(6, Math.floor(P(c.props, 'segments', 14)));
    const cx = w / 2;
    const cy = h * 0.72;
    const R = Math.min(w * 0.44, h * 0.62);
    const a0 = Math.PI * 1.15;
    const a1 = Math.PI * 1.85;
    const needle = lerp(a0, a1, 0.5 + 0.5 * Math.sin((c.t / period) * Math.PI * 2 - Math.PI / 2));
    // 刻度
    for (let i = 0; i < segs; i++) {
      const a = lerp(a0, a1, i / (segs - 1));
      const r0 = R * 0.86;
      const on = Math.abs(needle - a) < (a1 - a0) / segs / 2;
      ctx.strokeStyle = rgba(on ? theme.accent : theme.textDim, on ? 0.95 : 0.45);
      ctx.lineWidth = on ? 3 : 1.4;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      ctx.lineTo(cx + Math.cos(a) * R, cy + Math.sin(a) * R);
      ctx.stroke();
    }
    // 弧线
    ctx.strokeStyle = rgba(theme.textDim, 0.4);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.7, a0, a1);
    ctx.stroke();
    // 指针
    ctx.strokeStyle = rgba(theme.accent, 0.9);
    ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + Math.cos(needle) * R * 0.88, cy + Math.sin(needle) * R * 0.88);
    ctx.stroke();
    ctx.fillStyle = rgba(theme.text, 0.9);
    ctx.beginPath();
    ctx.arc(cx, cy, 4, 0, Math.PI * 2);
    ctx.fill();
    // 数字读数
    const val = Math.round(((needle - a0) / (a1 - a0)) * 100);
    ctx.font = font(c, R * 0.22, 700);
    ctx.textBaseline = 'middle';
    ctx.fillStyle = rgba(theme.text, 0.92);
    const txt = String(val).padStart(3, '0');
    ctx.fillText(txt, cx - ctx.measureText(txt).width / 2, cy - R * 0.42);
    c.report({ state: 'dial', measure: { value: val, period } });
  },
});

// ── bdTerminal：终端窗口（标题栏 + 滚动日志 + 进度条） ──────────────
registerWidget({
  name: 'bdTerminal',
  defaultSize: { w: 560, h: 340 },
  draw(c) {
    const { ctx, w, h, theme } = c;
    const size = Math.max(10, P(c.props, 'size', 15) * c.env.ds);
    const title = String(P(c.props, 'title', 'kine — render'));
    const lines = Math.max(3, Math.floor(P(c.props, 'lines', 11)));
    const barH = size * 1.7;
    // 窗框
    ctx.fillStyle = rgba(theme.bg[1], 0.88);
    rr(ctx, 0, 0, w, h, 8);
    ctx.fill();
    ctx.strokeStyle = rgba(theme.textDim, 0.5);
    ctx.lineWidth = 1;
    rr(ctx, 0, 0, w, h, 8);
    ctx.stroke();
    // 标题栏
    ctx.fillStyle = rgba(theme.text, 0.07);
    ctx.fillRect(0, 0, w, barH);
    const dotR = barH * 0.14;
    const dotColors = [rgba(theme.accent, 0.9), rgba(theme.textDim, 0.7), rgba(theme.textDim, 0.5)];
    dotColors.forEach((col, i) => {
      ctx.fillStyle = col;
      ctx.beginPath();
      ctx.arc(barH * 0.42 + i * barH * 0.42, barH / 2, dotR, 0, Math.PI * 2);
      ctx.fill();
    });
    ctx.fillStyle = rgba(theme.text, 0.85);
    ctx.font = font(c, size * 0.82, 700);
    ctx.textBaseline = 'middle';
    ctx.fillText(title, barH * 1.6, barH / 2);
    // 日志行（滚动：每行内容随 tick 更换）
    ctx.font = font(c, size, 400);
    const lh = size * 1.5;
    const top = barH + lh * 0.4;
    const vis = Math.min(lines, Math.floor((h - top - barH) / lh));
    const spd = Math.max(0.05, P(c.props, 'speed', 1)); // v4：speed 曾为死参数（源码不读）；现为日志滚动速度倍率（1=原速）
    for (let i = 0; i < vis; i++) {
      const rowIdx = Math.floor(c.t * 1.15 * spd) - (vis - 1 - i);
      const y = top + i * lh;
      const stage = Math.abs(((rowIdx % 60) + 60) % 60);
      let text: string;
      let col = rgba(theme.textDim, 0.85);
      if (stage % 5 === 0) {
        const frame = Math.floor(c.rng(`widget.${c.id}.fr`, rowIdx) * 8274);
        text = `✓ frame ${String(frame).padStart(6, '0')} → ${c.rng(`widget.${c.id}.k`, rowIdx) > 0.5 ? 'chunk_a.ts' : 'chunk_b.ts'}`;
      } else if (stage % 5 === 1) {
        text = `· ir loaded  specHash ${hexByte(c.rng(`widget.${c.id}.h1`, rowIdx))}${hexByte(c.rng(`widget.${c.id}.h2`, rowIdx))}${hexByte(c.rng(`widget.${c.id}.h3`, rowIdx))}${hexByte(c.rng(`widget.${c.id}.h4`, rowIdx))}`;
      } else if (stage % 5 === 2) {
        text = `> probe t=${(c.t % 60).toFixed(2)}s scene=live`;
      } else if (stage % 5 === 3) {
        text = `! measure cam_jitter p99 = ${(0.4 + c.rng(`widget.${c.id}.j`, rowIdx)).toFixed(2)}px`;
        col = rgba(theme.text, 0.9);
      } else {
        text = `$ kine render --range 0:${Math.floor(c.t) + 5}`;
        col = rgba(theme.accent, 0.85);
      }
      ctx.fillStyle = col;
      ctx.fillText(text, size * 0.8, y + lh / 2);
    }
    // 进度条（循环推进）
    const bx = size * 0.8;
    const bw = w - bx * 2;
    const by = h - barH * 1.05;
    ctx.fillStyle = rgba(theme.text, 0.08);
    rr(ctx, bx, by, bw, barH * 0.42, 3);
    ctx.fill();
    const pp = phase(c.t, 9.4);
    ctx.fillStyle = rgba(theme.accent, 0.85);
    rr(ctx, bx, by, Math.max(3, bw * pp), barH * 0.42, 3);
    ctx.fill();
    ctx.fillStyle = rgba(theme.textDim, 0.75);
    ctx.font = font(c, size * 0.72, 400);
    ctx.textBaseline = 'middle';
    ctx.fillText(`${Math.floor(pp * 100)}%`, bx + bw + size * 0.4, by + barH * 0.21);
    c.report({ state: 'terminal', measure: { progress: +pp.toFixed(3), lines: vis } });
  },
});

export {};

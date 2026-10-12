// @kine/widgets — chart：数据驱动图表（bars / area / line / steps）
//   纯函数契约：同一 (t, props, seed) 输出恒定；无随机、无时钟、无累积状态。
//   数据走 props 字符串（meta 的 props 类型只有 number|string）：
//     values="1.2,3.4,..."（逗号/空白分隔）  labels="一|二|三"（竖线分隔）
import { registerWidget, P, rgba } from '@kine/runtime';
import { clamp, font, lerp, smooth } from './util';

const nums = (s: unknown): number[] =>
  String(s ?? '')
    .split(/[,\s]+/)
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x));

const strs = (s: unknown): string[] =>
  String(s ?? '')
    .split('|')
    .map((x) => x.trim())
    .filter((x) => x.length > 0);

registerWidget({
  name: 'chart',
  defaultSize: { w: 640, h: 300 },
  draw(c) {
    const { ctx, w, h, theme } = c;
    const ds = c.env.ds;
    const kind = String(P(c.props, 'kind', 'bars'));
    const raw = nums(c.props.values);
    if (raw.length === 0) {
      c.report({ state: 'empty' });
      return;
    }
    const labels = strs(c.props.labels);
    const bins = Math.max(0, Math.round(Number(P(c.props, 'bins', 0))));
    let vals = raw;
    if (kind === 'bars' && bins > 0 && bins < raw.length) {
      const out: number[] = [];
      const per = raw.length / bins;
      for (let i = 0; i < bins; i++) {
        const a = Math.floor(i * per);
        const b = Math.max(a + 1, Math.floor((i + 1) * per));
        const slice = raw.slice(a, b);
        out.push(slice.reduce((x, y) => x + y, 0) / slice.length);
      }
      vals = out;
    }
    const n = vals.length;
    const vmax = Number(P(c.props, 'max', 0));
    const vmin = Number(P(c.props, 'min', 0));
    const top = vmax > vmin ? vmax : Math.max(...vals) * 1.08;
    const reqGrid = Math.max(0, Math.round(Number(P(c.props, 'grid', 4))));
    const reveal = Math.max(0.01, Number(P(c.props, 'reveal', 1.2)));
    const mark = Math.round(Number(P(c.props, 'mark', -1)));
    const markLabel = String(P(c.props, 'mark_label', ''));
    const showValues = Number(P(c.props, 'show_values', 0)) === 1;
    const digits = Math.max(0, Math.round(Number(P(c.props, 'digits', 1))));
    const suffix = String(P(c.props, 'suffix', ''));
    const dots = Number(P(c.props, 'dots', 0)) === 1;
    const axis = Number(P(c.props, 'axis', 1)) === 1;
    const grid = kind === 'bars' && labels.length > 0 ? Math.min(reqGrid, 3) : reqGrid;

    const padTop = showValues || markLabel ? 30 * ds : 8 * ds;
    const padBottom = labels.length > 0 ? 40 * ds : 8 * ds;
    const y0 = padTop;
    const y1 = h - padBottom;
    const sy = (v: number) => lerp(y1, y0, clamp((v - vmin) / Math.max(1e-9, top - vmin), 0, 1));
    const prog = smooth(clamp(c.t / reveal, 0, 1));

    ctx.save();
    if (grid > 0) {
      ctx.strokeStyle = rgba(theme.textDim, 0.22);
      ctx.lineWidth = 1;
      ctx.setLineDash([3 * ds, 5 * ds]);
      for (let i = 0; i <= grid; i++) {
        const y = lerp(y1, y0, i / grid);
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(w, y);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }
    if (axis) {
      ctx.strokeStyle = rgba(theme.textDim, 0.45);
      ctx.lineWidth = Math.max(1, 1.5 * ds);
      ctx.beginPath();
      ctx.moveTo(0, y1);
      ctx.lineTo(w, y1);
      ctx.stroke();
    }

    if (kind === 'bars') {
      const gapR = clamp(Number(P(c.props, 'gap', 0.34)), 0, 0.8);
      const slot = w / n;
      const bw = slot * (1 - gapR);
      const stagger = (reveal * 0.45) / Math.max(1, n);
      const dur = Math.max(0.12, reveal * 0.55);
      for (let i = 0; i < n; i++) {
        const p = smooth(clamp((c.t - i * stagger) / dur, 0, 1));
        const x = i * slot + (slot - bw) / 2;
        const bh = Math.max(1, (y1 - sy(vals[i])) * p);
        const isMark = i === mark;
        ctx.fillStyle = rgba(isMark ? theme.accent : theme.textDim, isMark ? 0.92 : 0.5);
        ctx.fillRect(x, y1 - bh, bw, bh);
        if (isMark) ctx.fillRect(x, y1 - bh - 3 * ds, bw, 3 * ds);
        if (showValues && p > 0.6) {
          ctx.fillStyle = rgba(isMark ? theme.accent : theme.textDim, 0.95);
          ctx.font = font(c, 22 * ds, isMark ? 600 : 400);
          ctx.textAlign = 'center';
          ctx.textBaseline = 'alphabetic';
          ctx.fillText(vals[i].toFixed(digits) + suffix, x + bw / 2, y1 - bh - 9 * ds);
        }
        if (labels.length > 0 && i < labels.length) {
          ctx.fillStyle = rgba(isMark ? theme.accent : theme.textDim, 0.9);
          ctx.font = font(c, 20 * ds, 400);
          ctx.textAlign = 'center';
          ctx.textBaseline = 'alphabetic';
          ctx.fillText(labels[i], x + bw / 2, h - 12 * ds);
        }
      }
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.restore();
      c.report({ state: 'bars', measure: { bins: n, max: top } });
      return;
    }

    // area / line / steps
    const px = (i: number) => (n === 1 ? w / 2 : (i / (n - 1)) * w);
    const py = (v: number) => sy(v);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, Math.max(0.001, w * prog), h);
    ctx.clip();
    if (kind === 'steps') {
      // 填充：把阶梯向下闭合成面
      const stroke = new Path2D();
      stroke.moveTo(0, py(vals[0]));
      for (let i = 1; i < n; i++) {
        stroke.lineTo(px(i), py(vals[i - 1]));
        stroke.lineTo(px(i), py(vals[i]));
      }
      if (n > 1) stroke.lineTo(w, py(vals[n - 1]));
      const fill = new Path2D(stroke);
      fill.lineTo(w, y1);
      fill.lineTo(0, y1);
      fill.closePath();
      ctx.fillStyle = rgba(theme.accent, 0.13);
      ctx.fill(fill);
      ctx.strokeStyle = rgba(theme.accent, 0.95);
      ctx.lineWidth = Math.max(1.2, 2.2 * ds);
      ctx.stroke(stroke);
    } else {
      const path = new Path2D();
      path.moveTo(px(0), py(vals[0]));
      if (Number(P(c.props, 'smooth', 0)) === 1 && n > 2) {
        for (let i = 1; i < n; i++) {
          const mx = (px(i - 1) + px(i)) / 2;
          path.quadraticCurveTo(mx, py(vals[i - 1]), px(i), py(vals[i]));
        }
      } else {
        for (let i = 1; i < n; i++) path.lineTo(px(i), py(vals[i]));
      }
      if (kind === 'area') {
        const fill = new Path2D(path);
        fill.lineTo(px(n - 1), y1);
        fill.lineTo(px(0), y1);
        fill.closePath();
        ctx.fillStyle = rgba(theme.accent, 0.14);
        ctx.fill(fill);
      }
      ctx.strokeStyle = rgba(theme.accent, 0.95);
      ctx.lineWidth = Math.max(1.2, 2.2 * ds);
      ctx.stroke(path);
      if (dots) {
        for (let i = 0; i < n; i++) {
          ctx.beginPath();
          ctx.arc(px(i), py(vals[i]), 2.6 * ds, 0, Math.PI * 2);
          ctx.fillStyle = rgba(theme.accent, 0.9);
          ctx.fill();
        }
      }
    }
    ctx.restore(); // 解除揭示剪裁
    if (mark >= 0 && mark < n) {
      ctx.strokeStyle = rgba(theme.accent, 0.35);
      ctx.lineWidth = 1 * ds;
      ctx.beginPath();
      ctx.moveTo(px(mark), py(vals[mark]));
      ctx.lineTo(px(mark), y1);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(px(mark), py(vals[mark]), 4.2 * ds, 0, Math.PI * 2);
      ctx.fillStyle = rgba(theme.accent, 1);
      ctx.fill();
      if (markLabel) {
        ctx.fillStyle = rgba(theme.accent, 0.95);
        ctx.font = font(c, 22 * ds, 600);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'alphabetic';
        ctx.fillText(markLabel, px(mark), py(vals[mark]) - 12 * ds);
      }
    }
    if (labels.length > 0) {
      ctx.fillStyle = rgba(theme.textDim, 0.9);
      ctx.font = font(c, 20 * ds, 400);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      for (let i = 0; i < Math.min(labels.length, n); i++) {
        const lx = n === labels.length ? px(i) : px(Math.round((i * (n - 1)) / Math.max(1, labels.length - 1)));
        ctx.fillText(labels[i], lx, h - 12 * ds);
      }
    }
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.restore();
    c.report({ state: kind, measure: { points: n, max: top } });
  },
});

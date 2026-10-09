"use strict";
(() => {
  // packages/dsl/src/rand.ts
  function fnv1a32(str2) {
    let h = 2166136261;
    for (let i = 0; i < str2.length; i++) {
      h ^= str2.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return h >>> 0;
  }
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function() {
      a = a + 1831565813 >>> 0;
      let t = a;
      t = Math.imul(t ^ t >>> 15, t | 1);
      t ^= t + Math.imul(t ^ t >>> 7, t | 61);
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function makeRng(seed) {
    const s = String(seed);
    return (channel, index) => mulberry32(fnv1a32(`${s}:${channel}:${index}`))();
  }
  var HEX8 = (n) => (n >>> 0).toString(16).padStart(8, "0");
  function hash64(str2) {
    return HEX8(fnv1a32("k1:" + str2)) + HEX8(fnv1a32("k2:" + str2));
  }
  function frac(x) {
    return x - Math.floor(x);
  }

  // packages/dsl/src/time.ts
  var EPS = 1e-9;
  function TtoT(map, T) {
    const seg = map.segments.find((s) => T < s.T1 - EPS) ?? map.segments[map.segments.length - 1];
    return seg.t0 + (T - seg.T0) / seg.ratio;
  }
  function sceneAtT(map, T) {
    return map.scenes.find((s) => T >= s.T0 - EPS && T < s.T1 - EPS) ?? map.scenes[map.scenes.length - 1];
  }
  function sceneLt(scene, T) {
    const x = (T - scene.T0) * scene.rate;
    if (scene.accel === "cut") return Math.min(x * scene.accelFactor, scene.dur);
    return x;
  }

  // packages/dsl/src/camera.ts
  var TWO_PI = Math.PI * 2;
  function cameraAt(cam, p) {
    const s = (p.S ?? 1080) / 1080;
    const tw = cam.tw;
    const bpm = cam.bpm ?? 0;
    const ph = bpm > 0 ? frac((p.T + cam.beat_offset) * (bpm / 60)) : 0;
    const mot = bpm > 0 ? (1 + Math.cos(TWO_PI * ph)) / 2 : 0.5;
    const beatEnv = bpm > 0 ? Math.exp(-ph * 6) : 0;
    const flash2 = beatEnv * beatEnv;
    const head = 0.038 * Math.exp(-Math.max(p.lt, 0) / 0.15);
    const sd = String(p.seed);
    const phase3 = (i) => mulberry32(fnv1a32(`${sd}:shake:${i}`))() * TWO_PI;
    const p0 = phase3(0), p1 = phase3(1), p2 = phase3(2), p3 = phase3(3), p4 = phase3(4);
    const shakeX = tw * 3 * s * (0.6 * Math.sin(TWO_PI * 1.7 * p.T + p0) + 0.4 * Math.sin(TWO_PI * 4.3 * p.T + p1));
    const shakeY = tw * 2.4 * s * (0.55 * Math.sin(TWO_PI * 1.3 * p.T + p2) + 0.45 * Math.sin(TWO_PI * 3.9 * p.T + p3));
    const shakeRoll = tw * 0.05 * (0.7 * Math.sin(TWO_PI * 0.9 * p.T + p4) + 0.3 * Math.sin(TWO_PI * 2.3 * p.T + p0));
    return {
      z1: cam.z1 * (1 + head + tw * (6e-3 + 8e-3 * mot)),
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
      shakeRoll
    };
  }
  function postAt(cam, theme, extraFlash = 0) {
    const beat = cam.tw * cam.flash2;
    const vignette = Math.min(cam.tw > 0 ? theme.post.vignette.base + cam.tw * theme.post.vignette.tw_gain + beat * theme.post.vignette.beat_gain : theme.post.vignette.base, theme.post.vignette.max);
    const scanline = Math.min(theme.post.scanline.base + cam.tw * theme.post.scanline.tw_gain, theme.post.scanline.max);
    const flash = Math.min(theme.post.flash.max_alpha, theme.post.flash.max_alpha * Math.max(cam.flash2 * (0.35 + 0.65 * cam.tw), extraFlash));
    return { vignette, scanline, flash };
  }

  // packages/runtime/src/theme.ts
  function resolveTheme(theme, W, H) {
    return {
      bg: [theme.bg[0], theme.bg[1]],
      text: theme.text,
      textDim: theme.text_dim,
      accent: theme.accent,
      accent2: theme.accent_secondary.color,
      accent2MaxFrames: theme.accent_secondary.max_frames,
      font: theme.font.family,
      fontScale: theme.font.scale,
      fontBase: theme.font.base,
      post: theme.post,
      S: Math.min(W, H),
      W,
      H
    };
  }
  function hexRgb(hex) {
    const h = hex.replace("#", "");
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  }
  function rgba(hex, a) {
    const [r, g, b] = hexRgb(hex);
    return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a))})`;
  }

  // packages/runtime/src/widgets-api.ts
  var registry = /* @__PURE__ */ new Map();
  function registerWidget(def) {
    registry.set(def.name, def);
  }
  function getWidget(name) {
    return registry.get(name);
  }
  function listWidgets() {
    return [...registry.keys()].sort();
  }
  function P(props, key, fallback) {
    const v = props[key];
    if (v === void 0 || v === null) return fallback;
    return v;
  }

  // packages/runtime/src/particles.ts
  var TWO_PI2 = Math.PI * 2;
  function rng4(rng, ch, i) {
    return [rng(ch, i * 4), rng(ch, i * 4 + 1), rng(ch, i * 4 + 2), rng(ch, i * 4 + 3)];
  }
  function drawParticles(ctx, layer, c) {
    const { T, W, H, theme } = c;
    const count = layer.count | 0;
    if (count <= 0) return;
    const ch = `particles.${layer.id}`;
    const ds = theme.S / 1080;
    const sizeMin = (layer.size[0] || 1) * ds;
    const sizeMax = (layer.size[1] || 2.4) * ds;
    const depthBoost = layer.depth === "near" ? 1.55 : 1;
    const parallaxK = layer.parallax / 0.062;
    const margin = Math.max(W, H) * 0.05;
    const color = layer.color ?? (layer.depth === "near" ? theme.text : theme.textDim);
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
      const yWob = Math.sin(TWO_PI2 * (0.05 * T + ph)) * (6 + 14 * sz) * ds;
      const y = yBase + yWob;
      const s = (sizeMin + (sizeMax - sizeMin) * Math.pow(sz, 2.2)) * depthBoost;
      const twinkle = 0.5 + 0.5 * Math.sin(TWO_PI2 * (0.11 * T + ph * 2.3));
      const alpha = (0.18 + 0.5 * twinkle) * (0.45 + 0.55 * sz) * (layer.depth === "near" ? 0.95 : 0.7);
      if (alpha <= 0.01) continue;
      ctx.globalAlpha = Math.min(1, alpha);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(x, y, Math.max(0.4, s * 0.5), 0, TWO_PI2);
      ctx.fill();
      if (layer.depth === "near" && sz > 0.8) {
        ctx.globalAlpha = Math.min(1, alpha * 1.4);
        ctx.fillStyle = theme.text;
        ctx.beginPath();
        ctx.arc(x, y, Math.max(0.3, s * 0.22), 0, TWO_PI2);
        ctx.fill();
      }
    }
    ctx.globalAlpha = 1;
  }

  // packages/runtime/src/text.ts
  var INTERP_RE = /\{(frame|t|T|lt)(?::\.([0-9])f)?\}/g;
  function interpolateText(content, env) {
    if (!content.includes("{")) return content;
    return content.replace(INTERP_RE, (_m, key, digits) => {
      const d = digits === void 0 ? 2 : Number(digits);
      if (key === "frame") return String(Math.max(0, Math.round(env.frame)));
      const v = key === "t" ? env.t : key === "T" ? env.T : env.lt;
      return v.toFixed(d);
    });
  }
  function drawTextLayer(ctx, layer, lt, theme, boxW, opts) {
    const ds = theme.S / 1080;
    const px = (layer.style.size || 1) * theme.fontBase * theme.fontScale * ds * 1.06;
    ctx.font = `${layer.style.weight} ${px}px ${theme.font}`;
    ctx.textBaseline = "top";
    const color = layer.style.color ?? theme.text;
    const content = interpolateText(layer.content, {
      frame: opts?.frame ?? 0,
      t: opts?.t ?? 0,
      T: opts?.T ?? 0,
      lt
    });
    const total = content.length;
    let visible = total;
    let typing = false;
    if (layer.type_period > 0) {
      visible = Math.min(total, Math.floor(lt / layer.type_period));
      typing = visible < total;
    }
    const text = content.slice(0, visible);
    const maxW = layer.style.max_width ? layer.style.max_width * ds : boxW;
    const lineH = px * 1.4;
    const lines = [];
    if (layer.style.max_width) {
      let cur = "";
      for (const chg of text) {
        const test = cur + chg;
        if (ctx.measureText(test).width > maxW && cur.length > 0) {
          lines.push(cur);
          cur = chg;
        } else cur = test;
      }
      lines.push(cur);
    } else {
      lines.push(...text.split("\n"));
    }
    let lineW = 0;
    for (const l of lines) lineW = Math.max(lineW, ctx.measureText(l).width);
    const blockW = lineW;
    const lineX = (lw) => {
      if (opts?.centerX) return -blockW / 2;
      const align = layer.style.align;
      if (align === "center") return -blockW / 2;
      if (align === "right") return -blockW;
      return 0;
    };
    const innerAlign = opts?.centerX ? "left" : layer.style.align;
    const innerX = (lw) => {
      if (innerAlign === "center") return (blockW - lw) / 2;
      if (innerAlign === "right") return blockW - lw;
      return 0;
    };
    ctx.fillStyle = color;
    for (let i = 0; i < lines.length; i++) {
      const lw = ctx.measureText(lines[i]).width;
      ctx.fillText(lines[i], lineX(lw) + innerX(lw), i * lineH);
    }
    let cursorW = 0;
    if (typing) {
      const lastW = ctx.measureText(lines[lines.length - 1]).width;
      const blink = 0.5 + 0.5 * Math.sin(Math.PI * 2 * (lt * 1.4));
      ctx.globalAlpha = 0.35 + 0.5 * blink;
      ctx.fillText("\u258D", lineX(lastW) + innerX(lastW) + lastW + px * 0.08, (lines.length - 1) * lineH);
      cursorW = px * 0.7;
      ctx.globalAlpha = 1;
    }
    const boxX = opts?.centerX ? -blockW / 2 : lineX(blockW);
    const state = typing ? "typing" : "done";
    return {
      box: { x: boxX, y: 0, w: blockW + cursorW, h: lines.length * lineH },
      visibleChars: visible,
      state,
      measure: {
        text_period: layer.type_period,
        chars_visible: visible,
        chars_total: total,
        line_height: +lineH.toFixed(2)
      }
    };
  }

  // packages/runtime/src/effects.ts
  var pNum = (params, key, d) => {
    const v = params[key];
    return typeof v === "number" && Number.isFinite(v) ? v : d;
  };
  function drawFx(ctx, fx, params, a) {
    const { W, H, theme, T } = a;
    switch (fx) {
      case "scanlines": {
        const alpha = Math.min(0.2, pNum(params, "alpha", 0.06));
        const step = Math.max(2, pNum(params, "step", 3));
        ctx.fillStyle = rgba("#000000", alpha);
        for (let y = 0; y < H; y += step) ctx.fillRect(0, y, W, 1);
        return;
      }
      case "vignette": {
        const k = Math.min(0.9, pNum(params, "k", 0.35));
        const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.32, W / 2, H / 2, Math.max(W, H) * 0.72);
        g.addColorStop(0, "rgba(0,0,0,0)");
        g.addColorStop(1, `rgba(0,0,0,${k})`);
        ctx.fillStyle = g;
        ctx.fillRect(0, 0, W, H);
        return;
      }
      case "grain": {
        const count = Math.min(1200, Math.max(0, pNum(params, "count", 260))) | 0;
        const alpha = Math.min(0.2, pNum(params, "alpha", 0.06));
        const size = Math.max(1, pNum(params, "size", 1.5));
        ctx.fillStyle = rgba(theme.text, alpha);
        for (let i = 0; i < count; i++) {
          const seed = a.frame * count + i;
          const x = a.rng(a.channel + ".gx", seed) * W;
          const y = a.rng(a.channel + ".gy", seed) * H;
          ctx.fillRect(x, y, size, size);
        }
        return;
      }
      case "chroma": {
        const slices = Math.max(1, Math.min(14, pNum(params, "slices", 6))) | 0;
        const off = Math.max(1, pNum(params, "offset", 3));
        const src = ctx.canvas;
        for (let i = 0; i < slices; i++) {
          const seed = a.frame * 7 + i * 13;
          const y = Math.floor(a.rng(a.channel + ".cy", seed) * H);
          const h = Math.max(2, Math.floor((0.01 + 0.05 * a.rng(a.channel + ".ch", seed)) * H));
          const y2 = Math.min(y, H - h);
          ctx.save();
          ctx.globalCompositeOperation = "lighter";
          ctx.globalAlpha = 0.1;
          ctx.drawImage(src, 0, y2, W, h, off, y2, W, h);
          ctx.globalAlpha = 0.08;
          ctx.drawImage(src, 0, y2, W, h, -off, y2, W, h);
          ctx.restore();
        }
        ctx.fillStyle = rgba(theme.accent2, 0.14);
        ctx.fillRect(0, a.frame * 53 % H, W, 1);
        return;
      }
      case "redbar": {
        const period = Math.max(0.4, pNum(params, "period", 2.4));
        const width = Math.max(6, pNum(params, "width", 0.045) * W);
        const alpha = Math.min(0.2, pNum(params, "alpha", 0.16));
        const ph = T % period / period;
        const x = -width + (W + 2 * width) * ph;
        ctx.fillStyle = rgba(theme.accent, alpha);
        ctx.fillRect(x, 0, width, H);
        ctx.fillStyle = rgba(theme.text, alpha * 0.5);
        ctx.fillRect(x + width * 0.5, 0, Math.max(1, width * 0.06), H);
        return;
      }
      case "pulse": {
        const period = Math.max(0.3, pNum(params, "period", 1.2));
        const inset = Math.max(0, pNum(params, "inset", 14));
        const ph = T % period / period;
        const wave = Math.sin(Math.PI * 2 * ph);
        const alpha = Math.min(0.2, pNum(params, "alpha", 0.06) * (0.5 + 0.5 * wave));
        ctx.strokeStyle = rgba(theme.text, alpha);
        ctx.lineWidth = Math.max(1, 2 * (theme.S / 1080));
        ctx.strokeRect(inset, inset, W - 2 * inset, H - 2 * inset);
        return;
      }
      default:
        return;
    }
  }

  // packages/runtime/src/transitions.ts
  var smooth = (x) => {
    const c = Math.max(0, Math.min(1, x));
    return c * c * (3 - 2 * c);
  };
  var easeInOutCubic = (x) => {
    const t = Math.max(0, Math.min(1, x));
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  };
  var N_BLINDS = 14;
  var N_VBARS = 12;
  function drawTransition(ctx, oldC, newC, tr, theme, W, H) {
    const d = Math.max(0, Math.min(1, tr.d));
    const dir = tr.variant % 2;
    const p = dir === 0 ? d : 1 - d;
    const e = smooth(d);
    const name = tr.name;
    switch (name) {
      // ---------------------------------------------------------- A 遮罩
      case "wipe_redbar": {
        ctx.drawImage(oldC, 0, 0, W, H);
        ctx.save();
        ctx.beginPath();
        if (dir === 0) ctx.rect(0, 0, W * e, H);
        else ctx.rect(W * (1 - e), 0, W * e, H);
        ctx.clip();
        ctx.drawImage(newC, 0, 0, W, H);
        ctx.restore();
        const x = (dir === 0 ? e : 1 - e) * W;
        const bw = Math.max(8, W * 0.012);
        ctx.fillStyle = rgba(theme.accent, 0.85);
        ctx.fillRect(x - bw / 2, 0, bw, H);
        return;
      }
      case "wipe_line": {
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
      case "wipe_blinds": {
        ctx.drawImage(oldC, 0, 0, W, H);
        const sh = H / N_BLINDS;
        for (let k = 0; k < N_BLINDS; k++) {
          const order = dir === 0 ? k : N_BLINDS - 1 - k;
          const pk = Math.max(0, Math.min(1, (e - order / N_BLINDS * 0.45) / 0.55));
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
      case "wipe_diagonal": {
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
      case "wipe_burst": {
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
          ctx.lineWidth = Math.max(2, W * 4e-3);
          ctx.beginPath();
          ctx.arc(W / 2, H / 2, r, 0, Math.PI * 2);
          ctx.stroke();
        }
        return;
      }
      case "wipe_vbars": {
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
      case "wipe_close": {
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
      case "push_in": {
        const off = (dir === 0 ? 1 : -1) * e;
        ctx.drawImage(oldC, -off * W, 0, W, H);
        ctx.drawImage(newC, (1 - off) * W, 0, W, H);
        return;
      }
      case "push_out": {
        const off = (dir === 0 ? -1 : 1) * e;
        ctx.drawImage(oldC, -off * W, 0, W, H);
        ctx.drawImage(newC, (1 - off) * W, 0, W, H);
        return;
      }
      case "push_up": {
        const off = (dir === 0 ? 1 : -1) * e;
        ctx.drawImage(oldC, 0, -off * H, W, H);
        ctx.drawImage(newC, 0, (1 - off) * H, W, H);
        return;
      }
      case "push_down": {
        const off = (dir === 0 ? -1 : 1) * e;
        ctx.drawImage(oldC, 0, -off * H, W, H);
        ctx.drawImage(newC, 0, (1 - off) * H, W, H);
        return;
      }
      // ---------------------------------------------------------- C 缩放（收回/展开）
      case "zoom_in": {
        drawZoom(ctx, oldC, newC, W, H, 1 + 0.15 * e, 1 + 0.15 * (1 - e), 1 - 0.55 * e);
        return;
      }
      case "zoom_out": {
        drawZoom(ctx, oldC, newC, W, H, 1 - 0.15 * e, 1 - 0.15 * (1 - e), 1 - 0.55 * e);
        return;
      }
      // ---------------------------------------------------------- D 甩镜（残影仅在 0.34s 窗口内，转场时长已保证）
      case "whip_h": {
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
      case "whip_v": {
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
  function drawZoom(ctx, oldC, newC, W, H, oldScale, newScale, oldAlpha) {
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

  // packages/runtime/src/post.ts
  function drawPost(ctx, W, H, theme, post, mul) {
    const mv = mul?.vignette ?? 1;
    const ms = mul?.scanline ?? 1;
    const mf = mul?.flash ?? 1;
    const k = Math.max(0, Math.min(0.9, post.vignette * mv));
    if (k > 2e-3) {
      const g = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.34, W / 2, H / 2, Math.max(W, H) * 0.72);
      g.addColorStop(0, "rgba(0,0,0,0)");
      g.addColorStop(1, `rgba(0,0,0,${k.toFixed(4)})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
    }
    const sl = Math.max(0, Math.min(0.12, post.scanline * ms));
    if (sl > 2e-3) {
      ctx.fillStyle = rgba("#000000", sl * 0.55);
      const step = 3;
      for (let y = 0; y < H; y += step) ctx.fillRect(0, y, W, 1);
    }
    const fl = Math.max(0, post.flash * mf);
    if (fl > 1e-3) {
      ctx.fillStyle = rgba(theme.text, fl);
      ctx.fillRect(0, 0, W, H);
    }
  }

  // packages/runtime/src/compositor.ts
  var EPS2 = 1e-9;
  var HEAD_FX_DUR = 0.24;
  var scratchA = null;
  var scratchB = null;
  var scratchACtx = null;
  var scratchBCtx = null;
  function getScratch(W, H) {
    if (!scratchA || scratchA.width !== W || scratchA.height !== H) {
      scratchA = document.createElement("canvas");
      scratchA.width = W;
      scratchA.height = H;
      scratchACtx = scratchA.getContext("2d");
      scratchB = document.createElement("canvas");
      scratchB.width = W;
      scratchB.height = H;
      scratchBCtx = scratchB.getContext("2d");
    }
    return [scratchA, scratchACtx, scratchB, scratchBCtx];
  }
  function smooth2(x) {
    const c = Math.max(0, Math.min(1, x));
    return c * c * (3 - 2 * c);
  }
  function layerOpacity(layer, lt, sceneDur) {
    const [w0, w1] = layer.window ?? [0, sceneDur];
    if (lt < w0 - EPS2 || lt > w1 + EPS2) return 0;
    let a = 1;
    if (layer.fade_in > 0) a *= smooth2((lt - w0) / layer.fade_in);
    if (layer.fade_out > 0) a *= smooth2((w1 - lt) / layer.fade_out);
    return Math.max(0, Math.min(1, a));
  }
  function drawView(ctx, v) {
    const { W, H, theme, cam, lt } = v;
    const ds = theme.S / 1080;
    ctx.save();
    ctx.translate(W / 2 + cam.dx * ds, H / 2 + cam.dy * ds);
    ctx.rotate(cam.roll * Math.PI / 180);
    ctx.scale(cam.z1, cam.z1);
    ctx.translate(-W / 2, -H / 2);
    for (const layer of v.layers) {
      if (layer.kind === "particles" && layer.depth === "far") {
        const a = layerOpacity(layer, lt, v.scene.dur);
        if (a <= 4e-3) continue;
        ctx.globalAlpha = a;
        ctx.save();
        drawParticles(ctx, layer, { T: v.T, theme, rng: v.rng, W, H });
        ctx.restore();
        ctx.globalAlpha = 1;
      }
    }
    for (const layer of v.layers) {
      if (layer.kind === "particles") continue;
      drawLayer(ctx, layer, v);
    }
    for (const layer of v.layers) {
      if (layer.kind === "particles" && layer.depth === "near") {
        const a = layerOpacity(layer, lt, v.scene.dur);
        if (a <= 4e-3) continue;
        ctx.globalAlpha = a;
        ctx.save();
        drawParticles(ctx, layer, { T: v.T, theme, rng: v.rng, W, H });
        ctx.restore();
        ctx.globalAlpha = 1;
      }
    }
    ctx.restore();
  }
  function recordBox(ctx, collect, el, local) {
    if (!collect) return;
    const m = ctx.getTransform();
    const xs = [];
    const ys = [];
    for (const [px, py] of [[local.x, local.y], [local.x + local.w, local.y], [local.x, local.y + local.h], [local.x + local.w, local.y + local.h]]) {
      xs.push(m.a * px + m.c * py + m.e);
      ys.push(m.b * px + m.d * py + m.f);
    }
    const x = Math.min(...xs), y = Math.min(...ys);
    collect({ ...el, box: { x: +x.toFixed(2), y: +y.toFixed(2), w: +(Math.max(...xs) - x).toFixed(2), h: +(Math.max(...ys) - y).toFixed(2) } });
  }
  function drawLayer(ctx, layer, v) {
    const { theme, lt, W, H } = v;
    const ds = theme.S / 1080;
    const alpha = layerOpacity(layer, lt, v.scene.dur);
    if (alpha <= 4e-3) return;
    switch (layer.kind) {
      case "widget": {
        const def = getWidget(layer.widget);
        const pw = layer.place.w != null ? layer.place.w * ds : void 0;
        const ph = layer.place.h != null ? layer.place.h * ds : void 0;
        const bw = pw ?? (def?.defaultSize.w ?? 320) * ds;
        const bh = ph ?? (def?.defaultSize.h ?? 200) * ds;
        const ox = layer.place.anchor === "center" ? layer.place.x * ds - bw / 2 : layer.place.x * ds;
        const oy = layer.place.anchor === "center" ? layer.place.y * ds - bh / 2 : layer.place.y * ds;
        ctx.save();
        ctx.translate(ox, oy);
        ctx.globalAlpha = alpha;
        let state = def ? void 0 : "unknown-widget";
        let measure;
        if (def) {
          def.draw({
            ctx,
            id: layer.id,
            t: lt,
            props: layer.props,
            theme,
            rng: v.rng,
            env: { W, H, S: theme.S, frame: v.frame, ds },
            w: bw,
            h: bh,
            report: (p) => {
              if (p.state !== void 0) state = p.state;
              if (p.measure !== void 0) measure = p.measure;
            }
          });
        } else {
          ctx.strokeStyle = rgba(theme.accent, 0.6);
          ctx.lineWidth = 2;
          ctx.strokeRect(0, 0, bw, bh);
          ctx.fillStyle = rgba(theme.textDim, 0.8);
          ctx.font = `${14 * ds}px ${theme.font}`;
          ctx.fillText(`? ${layer.widget}`, 8 * ds, 20 * ds);
        }
        recordBox(ctx, v.collect, { id: layer.id, kind: "widget", widget: layer.widget, alpha: +alpha.toFixed(4), state, measure }, { x: 0, y: 0, w: bw, h: bh });
        ctx.restore();
        return;
      }
      case "text": {
        const bw = (layer.place.w ?? layer.style.max_width ?? W * 0.6 / ds) * ds;
        const centerX = layer.place.anchor === "center";
        ctx.save();
        ctx.translate(layer.place.x * ds, layer.place.y * ds);
        ctx.globalAlpha = alpha;
        const res = drawTextLayer(ctx, layer, lt, theme, bw, { centerX, frame: v.frame, t: v.t, T: v.T });
        recordBox(
          ctx,
          v.collect,
          { id: layer.id, kind: "text", alpha: +alpha.toFixed(4), state: res.state, measure: res.measure },
          { x: res.box.x, y: 0, w: res.box.w, h: res.box.h }
        );
        ctx.restore();
        return;
      }
      case "image":
      case "video": {
        const src = layer.src;
        const img = layer.kind === "image" ? v.assets?.images?.get(src) : v.assets?.videos?.get(src);
        const place = layer.place;
        const natural = img ? {
          w: img.naturalWidth ?? img.videoWidth ?? img.width ?? 640,
          h: img.naturalHeight ?? img.videoHeight ?? img.height ?? 360
        } : { w: 640, h: 360 };
        const bw = (place.w ?? natural.w) * ds;
        const bh = (place.h ?? natural.h) * ds;
        const ox = place.anchor === "center" ? place.x * ds - bw / 2 : place.x * ds;
        const oy = place.anchor === "center" ? place.y * ds - bh / 2 : place.y * ds;
        ctx.save();
        ctx.translate(ox, oy);
        ctx.globalAlpha = alpha;
        let state = "ok";
        if (!img) {
          state = "missing-asset";
          ctx.strokeStyle = rgba(theme.accent, 0.5);
          ctx.lineWidth = 2;
          ctx.strokeRect(0, 0, bw, bh);
          ctx.fillStyle = rgba(theme.textDim, 0.8);
          ctx.font = `${16 * ds}px ${theme.font}`;
          ctx.fillText(`missing: ${src}`, 8 * ds, 24 * ds);
        } else {
          const scale = layer.fit === "cover" ? Math.max(bw / natural.w, bh / natural.h) : Math.min(bw / natural.w, bh / natural.h);
          const dw = natural.w * scale;
          const dh = natural.h * scale;
          ctx.drawImage(img, (bw - dw) / 2, (bh - dh) / 2, dw, dh);
          if (layer.kind === "video") state = "video-seek";
        }
        recordBox(ctx, v.collect, { id: layer.id, kind: layer.kind, alpha: +alpha.toFixed(4), state }, { x: 0, y: 0, w: bw, h: bh });
        ctx.restore();
        return;
      }
      case "fx": {
        ctx.save();
        ctx.globalAlpha = alpha;
        drawFx(ctx, layer.fx, layer.params, {
          lt,
          T: v.T,
          W,
          H,
          theme,
          rng: v.rng,
          frame: v.frame,
          channel: `fx.${layer.id}`
        });
        ctx.restore();
        return;
      }
      default:
        return;
    }
  }
  function drawFrame(ctx, o) {
    const { ir } = o;
    const W = ir.output.width;
    const H = ir.output.height;
    const map = ir.time.map;
    const theme = resolveTheme(ir.theme, W, H);
    const seed = o.seed ?? ir.project.seed;
    const rng = makeRng(seed);
    const T = Math.max(0, Math.min(map.durationT, o.T));
    const t = Math.max(0, Math.min(map.duration, TtoT(map, T)));
    const frame = Math.max(0, Math.min(map.frames - 1, Math.round(t * map.fps)));
    const timeScene = sceneAtT(map, T);
    let sceneIndex = ir.scenes.findIndex((s) => s.id === timeScene.id);
    if (sceneIndex < 0) sceneIndex = ir.scenes.length - 1;
    const scene = ir.scenes[sceneIndex];
    const lt = Math.max(0, Math.min(scene.dur, sceneLt(timeScene, T)));
    const shots = scene.shots;
    let shotIndex = -1;
    if (shots.length > 0) {
      shotIndex = shots.length - 1;
      for (let i = 0; i < shots.length; i++) {
        if (lt < shots[i].lt1 - EPS2) {
          shotIndex = i;
          break;
        }
      }
    }
    const curShot = shotIndex >= 0 ? shots[shotIndex] : null;
    const cam = cameraAt(curShot?.camera ?? scene.camera, { T, lt, seed, S: theme.S });
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "source-over";
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, theme.bg[0]);
    bg.addColorStop(1, theme.bg[1]);
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
    let transition = null;
    if (curShot && curShot.transition && curShot.transition.dur > 0 && shotIndex > 0 && lt < curShot.lt0 + curShot.transition.dur + EPS2) {
      const d = Math.max(0, Math.min(1, (lt - curShot.lt0) / curShot.transition.dur));
      transition = { kind: curShot.transition.kind, name: curShot.transition.name, variant: curShot.transition.variant, d };
    }
    const layersOf = (shot) => {
      if (!shot || !shot.on) return scene.layers;
      return scene.layers.filter((l) => shot.on.includes(l.id));
    };
    if (transition) {
      const prevShot = shots[shotIndex - 1];
      const [scrA, scrACtx, scrB, scrBCtx] = getScratch(W, H);
      const ltOld = Math.max(prevShot.lt0, prevShot.lt1 - 1e-3);
      const camOld = cameraAt(prevShot.camera, { T: prevShot.T1 - 1e-3, lt: ltOld, seed, S: theme.S });
      scrACtx.setTransform(1, 0, 0, 1, 0, 0);
      scrACtx.globalAlpha = 1;
      scrACtx.fillStyle = theme.bg[0];
      scrACtx.fillRect(0, 0, W, H);
      drawView(scrACtx, { scene, layers: layersOf(prevShot), lt: ltOld, cam: camOld, theme, rng, assets: o.assets, frame, t, T: prevShot.T1 - 1e-3, W, H });
      scrBCtx.setTransform(1, 0, 0, 1, 0, 0);
      scrBCtx.globalAlpha = 1;
      scrBCtx.fillStyle = theme.bg[0];
      scrBCtx.fillRect(0, 0, W, H);
      drawView(scrBCtx, { scene, layers: layersOf(curShot), lt, cam, theme, rng, assets: o.assets, frame, t, T, collect: o.collect, W, H });
      drawTransition(ctx, scrA, scrB, transition, theme, W, H);
    } else {
      drawView(ctx, { scene, layers: layersOf(curShot), lt, cam, theme, rng, assets: o.assets, frame, t, T, collect: o.collect, W, H });
    }
    const effects = [];
    for (const ef of scene.effects) {
      const [w0, w1] = ef.window ?? [0, scene.dur];
      const active = lt >= w0 - EPS2 && lt <= w1 + EPS2;
      effects.push({ fx: ef.fx, active });
      if (active) {
        ctx.save();
        drawFx(ctx, ef.fx, ef.params ?? {}, { lt, T, W, H, theme, rng, frame, channel: `fx.scene.${scene.id}.${ef.fx}` });
        ctx.restore();
      }
    }
    let headFlash = 0;
    if (sceneIndex > 0 && lt < HEAD_FX_DUR) {
      const p = lt / HEAD_FX_DUR;
      const ease = 1 - Math.pow(1 - p, 3);
      const barW = Math.max(10, W * 0.014);
      const x = -barW * 2 + (W + 4 * barW) * ease;
      ctx.save();
      ctx.fillStyle = rgba(theme.accent, 0.55 * (1 - p) * (1 - p));
      ctx.fillRect(x - barW / 2, 0, barW, H);
      ctx.fillStyle = rgba(theme.text, 0.6 * (1 - p) * (1 - p));
      ctx.fillRect(x + barW * 0.4, 0, Math.max(1, barW * 0.12), H);
      ctx.restore();
      headFlash = Math.pow(1 - p, 2);
    }
    const post = postAt(cam, theme, headFlash);
    drawPost(ctx, W, H, theme, post, scene.post);
    return {
      t: +t.toFixed(6),
      T: +T.toFixed(6),
      frame,
      seg: map.segments.find((s) => T < s.T1 - EPS2 && T >= s.T0 - EPS2)?.id ?? map.segments[map.segments.length - 1].id,
      scene: { id: scene.id, name: scene.name, index: sceneIndex, lt: +lt.toFixed(6) },
      camera: cam,
      post,
      transition: transition ? { kind: transition.kind, name: transition.name, variant: transition.variant, d: +transition.d.toFixed(4) } : null,
      effects,
      shotIndex,
      layerCount: layersOf(curShot).length
    };
  }

  // packages/runtime/src/runtime.ts
  function createRuntime(canvas2, opts) {
    let st = { ir: null, seed: null, debugEl: null };
    const ctx = canvas2.getContext("2d", { alpha: false });
    if (!ctx) throw new Error("2d context unavailable");
    const state = {
      canvas: canvas2,
      assets: {},
      load(ir, o) {
        st.ir = ir;
        st.seed = null;
        if (canvas2.width !== ir.output.width || canvas2.height !== ir.output.height) {
          canvas2.width = ir.output.width;
          canvas2.height = ir.output.height;
        }
        if (o?.assets) state.assets = o.assets;
        if (opts?.debug) {
          if (!st.debugEl) {
            st.debugEl = document.createElement("div");
            st.debugEl.id = "kine-readout";
            st.debugEl.style.cssText = "position:fixed;left:8px;bottom:8px;font:12px/1.4 monospace;color:#8a8a92;background:rgba(0,0,0,.55);padding:2px 6px;z-index:9;pointer-events:none";
            if (typeof document.body !== "undefined") document.body.appendChild(st.debugEl);
          }
        }
      },
      getIR() {
        return st.ir;
      },
      setSeed(seed) {
        st.seed = seed;
      },
      jump(T) {
        if (!st.ir) throw new Error("runtime not loaded: call load(ir) first");
        if (st.debugEl) st.debugEl.textContent = "";
        const report = drawFrame(ctx, { ir: st.ir, T, assets: state.assets, seed: st.seed ?? void 0 });
        if (st.debugEl) {
          st.debugEl.textContent = `t=${report.t.toFixed(3)} T=${report.T.toFixed(3)} frame=${report.frame} scene=${report.scene.id} lt=${report.scene.lt.toFixed(3)}`;
        }
        return report;
      },
      probe(T) {
        if (!st.ir) throw new Error("runtime not loaded: call load(ir) first");
        const elements = [];
        const report = drawFrame(ctx, { ir: st.ir, T, assets: state.assets, collect: (el) => elements.push(el), seed: st.seed ?? void 0 });
        return {
          t: report.t,
          T: report.T,
          frame: report.frame,
          scene: { id: report.scene.id, name: report.scene.name, index: report.scene.index, lt: report.scene.lt },
          camera: {
            z1: report.camera.z1,
            dx: report.camera.dx,
            dy: report.camera.dy,
            roll: report.camera.roll,
            tw: report.camera.tw,
            mot: report.camera.mot,
            beatPhase: report.camera.beatPhase,
            flash2: report.camera.flash2
          },
          post: report.post,
          transition: report.transition,
          elements,
          effects: report.effects,
          report
        };
      },
      stateHash(T) {
        if (!st.ir) throw new Error("runtime not loaded: call load(ir) first");
        const elements = [];
        const report = drawFrame(ctx, { ir: st.ir, T, assets: state.assets, collect: (el) => elements.push(el), seed: st.seed ?? void 0 });
        const r = (x, n = 5) => +x.toFixed(n);
        const canon = JSON.stringify({
          t: r(report.t, 6),
          T: r(report.T, 6),
          f: report.frame,
          s: report.scene.id,
          lt: r(report.scene.lt, 6),
          si: report.shotIndex,
          cam: [r(report.camera.z1, 6), r(report.camera.dx, 4), r(report.camera.dy, 4), r(report.camera.roll, 5), r(report.camera.flash2, 5), r(report.camera.mot, 5)],
          tr: report.transition ? [report.transition.kind, report.transition.variant, r(report.transition.d, 4)] : null,
          post: [r(report.post.vignette, 4), r(report.post.scanline, 4), r(report.post.flash, 5)],
          el: elements.map((e) => [e.id, r(e.box.x, 2), r(e.box.y, 2), r(e.box.w, 2), r(e.box.h, 2), r(e.alpha, 3), e.state ?? "", e.measure ? Object.entries(e.measure).sort().map(([k, v]) => `${k}=${typeof v === "number" ? r(v, 4) : v}`).join(",") : ""])
        });
        return hash64(canon);
      }
    };
    return state;
  }

  // packages/widgets/src/util.ts
  var clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  var lerp = (a, b, u) => a + (b - a) * u;
  var frac2 = (x) => x - Math.floor(x);
  var smooth3 = (u) => {
    const x = clamp(u, 0, 1);
    return x * x * (3 - 2 * x);
  };
  var phase = (t, period) => frac2(t / Math.max(1e-3, period));
  function font(c, size, weight = 400) {
    return `${weight} ${(size * c.theme.fontScale).toFixed(2)}px ${c.theme.font}`;
  }
  function rr(ctx, x, y, w, h, r) {
    const rad = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rad, y);
    ctx.lineTo(x + w - rad, y);
    ctx.arcTo(x + w, y, x + w, y + rad, rad);
    ctx.lineTo(x + w, y + h - rad);
    ctx.arcTo(x + w, y + h, x + w - rad, y + h, rad);
    ctx.lineTo(x + rad, y + h);
    ctx.arcTo(x, y + h, x, y + h - rad, rad);
    ctx.lineTo(x, y + rad);
    ctx.arcTo(x, y, x + rad, y, rad);
    ctx.closePath();
  }
  var HEXD = "0123456789ABCDEF";
  function hexByte(v) {
    const x = Math.floor(clamp(v, 0, 1) * 255.999);
    return HEXD[x >> 4 & 15] + HEXD[x & 15];
  }

  // packages/widgets/src/bd1.ts
  registerWidget({
    name: "bdBG",
    defaultSize: { w: 520, h: 300 },
    draw(c) {
      const { ctx, w, h, theme } = c;
      const cell = P(c.props, "cell", 26) * c.env.ds;
      const sweep = P(c.props, "sweep", 7);
      const cols = Math.max(4, Math.round(w / cell));
      const rows = Math.max(3, Math.round(h / cell));
      const cw = w / cols;
      const ch = h / rows;
      const bandY = phase(c.t, sweep) * h;
      ctx.lineWidth = 1;
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
      c.report({ state: "sweep", measure: { cell: cell / c.env.ds, band_y: +bandY.toFixed(1) } });
    }
  });
  registerWidget({
    name: "bdTitle",
    defaultSize: { w: 640, h: 150 },
    draw(c) {
      const { ctx, w, h, theme } = c;
      const text = String(P(c.props, "text", "WORLD.EXECUTE"));
      const sub = String(P(c.props, "sub", ""));
      const size = P(c.props, "size", 44) * c.env.ds;
      const typePeriod = P(c.props, "type_period", 0.05);
      const align = String(P(c.props, "align", "left"));
      const visible = typePeriod > 0 ? Math.floor(c.t / typePeriod) : text.length;
      const shown = text.slice(0, Math.max(0, visible));
      const done = visible >= text.length;
      ctx.fillStyle = rgba(theme.text, 0.95);
      ctx.font = font(c, size, 700);
      ctx.textBaseline = "top";
      const tw = ctx.measureText(text).width;
      const tx = align === "center" ? -tw / 2 : align === "right" ? -tw : 0;
      ctx.fillText(shown + (done ? "" : "\u258D"), tx, 0);
      if (sub) {
        ctx.font = font(c, size * 0.34, 400);
        ctx.fillStyle = rgba(theme.textDim, 0.85);
        const subW = ctx.measureText(sub).width;
        const subX = align === "center" ? tx + (tw - subW) / 2 : align === "right" ? tx + (tw - subW) : 2;
        ctx.fillText(sub, subX, size * 1.3);
      }
      const p = phase(c.t, P(c.props, "underline_period", 2.6));
      const uw = tw * smooth3(p * 2.2);
      ctx.fillStyle = rgba(theme.accent, 0.85);
      ctx.fillRect(tx, size * 1.12, uw, Math.max(2, size * 0.05));
      if (!done && Math.floor(c.t / 0.4) % 2 === 0) {
        const cw = ctx.measureText(shown).width;
        ctx.fillStyle = rgba(theme.accent, 0.75);
        ctx.fillRect(tx + cw + size * 0.06, 0, size * 0.52, size * 0.96);
      }
      c.report({ state: done ? "done" : "typing", measure: { chars_visible: Math.min(visible, text.length), chars_total: text.length, underline: +uw.toFixed(1) } });
    }
  });
  registerWidget({
    name: "bdKey",
    defaultSize: { w: 420, h: 90 },
    draw(c) {
      const { ctx, w, h, theme } = c;
      const keys = String(P(c.props, "keys", "W A S D")).split(/\s+/).filter(Boolean);
      const period = P(c.props, "period", 0.62);
      const step = Math.floor(c.t / period);
      const lit = (step % keys.length + keys.length) % keys.length;
      const kw = Math.min((w - 8 * (keys.length - 1)) / keys.length, h * 0.92);
      const kh = kw * 0.92;
      const y = (h - kh) / 2;
      keys.forEach((k, i) => {
        const x = i * (kw + 8);
        const on = i === lit;
        const press = on ? smooth3(1 - frac2(c.t / period) * 2.6) : 0;
        ctx.fillStyle = rgba(theme.text, on ? 0.1 + 0.14 * press : 0.05);
        rr(ctx, x, y + press * kh * 0.06, kw, kh, 6);
        ctx.fill();
        ctx.strokeStyle = rgba(on ? theme.accent : theme.textDim, on ? 0.85 : 0.35);
        ctx.lineWidth = on ? 2 : 1;
        rr(ctx, x, y + press * kh * 0.06, kw, kh, 6);
        ctx.stroke();
        ctx.fillStyle = on ? rgba(theme.accent, 0.98) : rgba(theme.textDim, 0.8);
        ctx.font = font(c, kw * 0.42, on ? 700 : 400);
        ctx.textBaseline = "middle";
        ctx.fillText(k, x + kw / 2 - ctx.measureText(k).width / 2, y + kh * 0.52 + press * kh * 0.06);
      });
      c.report({ state: "key", measure: { lit_index: lit, press: +clamp(1 - frac2(c.t / period) * 2.6, 0, 1).toFixed(3) } });
    }
  });
  registerWidget({
    name: "bdLive",
    defaultSize: { w: 300, h: 54 },
    draw(c) {
      const { ctx, w, h, theme } = c;
      const label = String(P(c.props, "label", "LIVE"));
      const blink = 0.45 + 0.55 * Math.max(0, Math.sin(c.t / 0.8 * Math.PI * 2));
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
      ctx.textBaseline = "middle";
      ctx.fillText(label, r * 2 + 16, h / 2);
      const secs = Math.floor(c.t);
      const mm = String(Math.floor(secs / 60)).padStart(2, "0");
      const ss = String(secs % 60).padStart(2, "0");
      const cs = String(Math.floor(frac2(c.t) * 100)).padStart(2, "0");
      ctx.fillStyle = rgba(theme.accent, 0.95);
      ctx.font = font(c, h * 0.34, 400);
      const tm = `${mm}:${ss}.${cs}`;
      ctx.fillText(tm, w - ctx.measureText(tm).width, h / 2);
      c.report({ state: "live", measure: { blink: +blink.toFixed(3), seconds: secs } });
    }
  });
  registerWidget({
    name: "bdScan",
    defaultSize: { w: 420, h: 120 },
    draw(c) {
      const { ctx, w, h, theme } = c;
      const period = P(c.props, "period", 2.4);
      const p = phase(c.t, period);
      const y = p * h;
      ctx.lineWidth = 1;
      const n = Math.floor(w / 9);
      for (let i = 0; i < n; i++) {
        const v = c.rng(`widget.${c.id}.bar`, i + Math.floor(c.t / 0.5) * 101);
        const bw = (v > 0.62 ? 4 : v > 0.3 ? 2 : 1) * 1.4;
        ctx.fillStyle = rgba(theme.textDim, 0.35 + 0.3 * v);
        ctx.fillRect(i * 9 + 2, h * 0.18, bw, h * 0.64);
      }
      const grad = ctx.createLinearGradient(0, y - h * 0.3, 0, y);
      grad.addColorStop(0, rgba(theme.accent, 0));
      grad.addColorStop(1, rgba(theme.accent, 0.28));
      ctx.fillStyle = grad;
      ctx.fillRect(0, Math.max(0, y - h * 0.3), w, Math.min(h * 0.3, y));
      ctx.fillStyle = rgba(theme.accent, 0.9);
      ctx.fillRect(0, y - 1, w, 2);
      ctx.font = font(c, 12, 400);
      ctx.fillStyle = rgba(theme.textDim, 0.7);
      ctx.fillText(`SCAN ${String(Math.floor(p * 100)).padStart(3, " ")}%`, 6, 14);
      c.report({ state: "scan", measure: { scan_y: +y.toFixed(1), progress: +p.toFixed(3) } });
    }
  });
  registerWidget({
    name: "bdPulse",
    defaultSize: { w: 480, h: 120 },
    draw(c) {
      const { ctx, w, h, theme } = c;
      const period = P(c.props, "period", 1.05);
      const amp = P(c.props, "amp", 0.36) * h;
      const base = h * 0.62;
      const speed = w / period;
      ctx.beginPath();
      for (let x = 0; x <= w; x += 2) {
        const u = frac2(frac2((x + c.t * speed) / w) + 0.5);
        const g1 = Math.exp(-Math.pow((u - 0.5) / 0.012, 2));
        const g2 = Math.exp(-Math.pow((u - 0.53) / 0.02, 2)) * 0.4;
        const g3 = Math.exp(-Math.pow((u - 1) / 0.05, 2)) * 1.6 + Math.exp(-Math.pow(u / 0.05, 2)) * 1.6;
        const small = Math.sin(u * Math.PI * 2 * 3) * 0.03;
        const y = base - amp * (g1 - g2 + g3 * 0.35 + small);
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.strokeStyle = rgba(theme.accent, 0.85);
      ctx.lineWidth = 1.6;
      ctx.stroke();
      const grad = ctx.createLinearGradient(0, 0, w * 0.18, 0);
      grad.addColorStop(0, rgba(theme.bg[0], 0.9));
      grad.addColorStop(1, rgba(theme.bg[0], 0));
      ctx.fillStyle = grad;
      ctx.fillRect(0, 0, w * 0.18, h);
      ctx.fillStyle = rgba(theme.textDim, 0.25);
      ctx.fillRect(0, base + 1, w, 1);
      c.report({ state: "pulse", measure: { period, amp_px: +amp.toFixed(1) } });
    }
  });
  registerWidget({
    name: "bdBars",
    defaultSize: { w: 420, h: 140 },
    draw(c) {
      const { ctx, w, h, theme } = c;
      const n = Math.max(6, Math.floor(P(c.props, "bars", 24)));
      const period = P(c.props, "period", 1.6);
      const bw = (w - (n - 1) * 3) / n;
      let maxI = 0;
      let maxV = 0;
      const vals = [];
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
      c.report({ state: "bars", measure: { peak_index: maxI, peak: +maxV.toFixed(3) } });
    }
  });
  registerWidget({
    name: "bdRing",
    defaultSize: { w: 240, h: 240 },
    draw(c) {
      const { ctx, w, h, theme } = c;
      const rings = Math.max(1, Math.floor(P(c.props, "rings", 3)));
      const period = P(c.props, "period", 3.2);
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
        const dotA = a0 + arc;
        ctx.fillStyle = rgba(theme.text, 0.9);
        ctx.beginPath();
        ctx.arc(cx + Math.cos(dotA) * r, cy + Math.sin(dotA) * r, 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = rgba(theme.text, 0.92);
      ctx.font = font(c, R * 0.24, 700);
      ctx.textBaseline = "middle";
      const txt = `${Math.floor(phase(c.t, period) * 100)}%`;
      ctx.fillText(txt, cx - ctx.measureText(txt).width / 2, cy + R * 0.55);
      c.report({ state: "ring", measure: { rings, progress: +phase(c.t, period).toFixed(3) } });
    }
  });

  // packages/widgets/src/bd2.ts
  registerWidget({
    name: "bdCells",
    defaultSize: { w: 420, h: 240 },
    draw(c) {
      const { ctx, w, h, theme } = c;
      const cols = Math.max(4, Math.floor(P(c.props, "cols", 14)));
      const rows = Math.max(3, Math.floor(P(c.props, "rows", 8)));
      const period = P(c.props, "period", 0.85);
      const cw = w / cols;
      const ch = h / rows;
      const tick = Math.floor(c.t / period);
      const f = frac2(c.t / period);
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) {
          const v = c.rng(`widget.${c.id}.cell`, tick * 977 + j * 131 + i);
          const on = v > 0.58;
          const edge = smooth3(clamp(f * 3, 0, 1)) * (1 - smooth3(clamp((f - 0.7) * 3, 0, 1)));
          const a = on ? 0.14 + 0.3 * (0.6 + 0.4 * v) : 0.05;
          ctx.fillStyle = rgba(on ? theme.text : theme.textDim, a * (0.35 + 0.65 * edge));
          ctx.fillRect(i * cw + 2, j * ch + 2, cw - 4, ch - 4);
          if (v > 0.93) {
            ctx.fillStyle = rgba(theme.accent, 0.5 * edge);
            ctx.fillRect(i * cw + 2, j * ch + 2, cw - 4, 3);
          }
        }
      }
      c.report({ state: "cells", measure: { tick, cols, rows } });
    }
  });
  registerWidget({
    name: "bdWave",
    defaultSize: { w: 480, h: 160 },
    draw(c) {
      const { ctx, w, h, theme } = c;
      const waves = Math.max(1, Math.floor(P(c.props, "waves", 3)));
      const speed = P(c.props, "speed", 0.9);
      for (let k = 0; k < waves; k++) {
        const base = h * (0.24 + 0.26 * k);
        const amp = h * (0.16 - 0.035 * k);
        const freq = 2.2 + k * 1.4;
        const ph = c.t * speed * (0.7 + 0.25 * k);
        ctx.beginPath();
        for (let x = 0; x <= w; x += 3) {
          const y = base + Math.sin(x / w * Math.PI * 2 * freq + ph * Math.PI * 2) * amp;
          if (x === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = k === 0 ? rgba(theme.accent, 0.8) : rgba(theme.textDim, 0.6 - k * 0.12);
        ctx.lineWidth = k === 0 ? 1.8 : 1.1;
        ctx.stroke();
        if (k === 0) {
          ctx.fillStyle = rgba(theme.text, 0.9);
          for (let x = 0; x <= w; x += w / 12) {
            const y = base + Math.sin(x / w * Math.PI * 2 * freq + ph * Math.PI * 2) * amp;
            ctx.beginPath();
            ctx.arc(x, y, 2, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      }
      c.report({ state: "wave", measure: { waves, phase: +phase(c.t, 1 / Math.max(0.01, speed)).toFixed(3) } });
    }
  });
  registerWidget({
    name: "bdHex",
    defaultSize: { w: 460, h: 260 },
    draw(c) {
      const { ctx, w, h, theme } = c;
      const lines = Math.max(4, Math.floor(P(c.props, "lines", 12)));
      const speed = P(c.props, "speed", 1.4);
      const lh = h / (lines + 0.5);
      ctx.font = font(c, lh * 0.62, 400);
      ctx.textBaseline = "top";
      const scroll = frac2(c.t * speed * 0.14) * lh;
      const rowH = 8;
      const rowW = 12;
      for (let r = -1; r <= lines; r++) {
        const rowIdx = Math.floor(c.t * speed * 0.14 + r);
        const y = r * lh - scroll + lh * 0.2;
        if (y < -lh || y > h) continue;
        const addr = (36864 + (rowIdx * rowH & 65520)).toString(16).toUpperCase().padStart(4, "0");
        ctx.fillStyle = rgba(theme.textDim, 0.55);
        ctx.fillText(addr, 0, y);
        let hexs = "";
        for (let b = 0; b < rowH; b++) {
          const v = c.rng(`widget.${c.id}.hex`, rowIdx * 131 + b);
          hexs += hexByte(v) + " ";
        }
        ctx.fillStyle = rgba(theme.text, 0.72);
        ctx.fillText(hexs, lh * 2.4, y);
        const hl = Math.floor(phase(c.t, 0.4) * rowH);
        const hlX = lh * 2.4 + hl * ctx.measureText("0 ").width;
        ctx.fillStyle = rgba(theme.accent, 0.7);
        ctx.fillRect(hlX, y + lh * 0.1, ctx.measureText("0").width * 0.95, lh * 0.66);
      }
      ctx.fillStyle = rgba(theme.textDim, 0.25);
      ctx.fillRect(0, h - 1, w, 1);
      c.report({ state: "hex", measure: { lines, scroll: +scroll.toFixed(1) } });
    }
  });
  registerWidget({
    name: "bdCursor",
    defaultSize: { w: 460, h: 60 },
    draw(c) {
      const { ctx, w, h, theme } = c;
      const text = String(P(c.props, "text", "kine render --range 0:5"));
      const period = P(c.props, "period", 3.4);
      const size = P(c.props, "size", 20) * c.env.ds;
      const p = phase(c.t, period);
      const chars = p < 0.62 ? Math.floor(p / 0.62 * (text.length + 1)) : p < 0.86 ? text.length : 0;
      ctx.font = font(c, size, 400);
      ctx.textBaseline = "middle";
      const y = h / 2;
      ctx.fillStyle = rgba(theme.accent, 0.9);
      const prompt = "$";
      ctx.fillText(prompt, 0, y);
      const pw = ctx.measureText(prompt + " ").width;
      ctx.fillStyle = rgba(theme.text, 0.92);
      const shown = text.slice(0, chars);
      ctx.fillText(shown, pw, y);
      const blink = Math.floor(c.t / 0.4) % 2 === 0;
      if (blink) {
        const cx = pw + ctx.measureText(shown).width + 2;
        ctx.fillStyle = rgba(theme.accent, 0.85);
        ctx.fillRect(cx, y - size * 0.5, size * 0.5, size);
      }
      c.report({ state: "cursor", measure: { chars_visible: shown.length, chars_total: text.length } });
    }
  });
  registerWidget({
    name: "bdRainDrops",
    defaultSize: { w: 420, h: 320 },
    draw(c) {
      const { ctx, w, h, theme } = c;
      const drops = Math.max(6, Math.floor(P(c.props, "drops", 26)));
      const speed = P(c.props, "speed", 1) * 120;
      const size = Math.max(9, P(c.props, "size", 13) * c.env.ds);
      ctx.font = font(c, size, 400);
      ctx.textBaseline = "top";
      const cols = Math.max(6, Math.floor(w / (size * 1.05)));
      const cw = w / cols;
      for (let i = 0; i < drops; i++) {
        const col = Math.floor(c.rng(`widget.${c.id}.col`, i) * cols);
        const off = c.rng(`widget.${c.id}.off`, i);
        const sp = speed * (0.55 + 0.9 * c.rng(`widget.${c.id}.sp`, i));
        const len = 6 + Math.floor(10 * c.rng(`widget.${c.id}.len`, i));
        const yHead = frac2((c.t * sp + off * h * 13) / (h + len * size * 1.1)) * (h + len * size * 1.1) - len * size * 1.1;
        for (let k = 0; k <= len; k++) {
          const y = yHead - k * size * 1.05;
          if (y < -size || y > h) continue;
          const a = k === 0 ? 0.98 : Math.max(0.06, 0.5 - k * 0.045);
          const ch = k === 0 ? "\u2588" : String.fromCharCode(12448 + Math.floor(c.rng(`widget.${c.id}.ch`, i * 57 + k + Math.floor((y + c.t * sp) / size) * 3) * 96));
          ctx.fillStyle = k === 0 ? rgba(theme.text, 0.95) : rgba(theme.textDim, a);
          ctx.fillText(ch, col * cw + cw * 0.08, y);
        }
      }
      c.report({ state: "rain", measure: { drops, speed_px: speed } });
    }
  });
  registerWidget({
    name: "bdFlow",
    defaultSize: { w: 520, h: 120 },
    draw(c) {
      const { ctx, w, h, theme } = c;
      const n = Math.max(2, Math.floor(P(c.props, "nodes", 5)));
      const period = P(c.props, "period", 2.8);
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
        ctx.fillStyle = rgba(active ? theme.accent : theme.textDim, 0.9);
        ctx.font = font(c, bh * 0.34, 700);
        ctx.textBaseline = "middle";
        const label = done ? "\u2713" : String(i + 1);
        ctx.fillText(label, x + bw / 2 - ctx.measureText(label).width / 2, y + bh / 2);
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
      c.report({ state: "flow", measure: { nodes: n, progress: +progress.toFixed(2) } });
    }
  });
  registerWidget({
    name: "bdDial",
    defaultSize: { w: 220, h: 180 },
    draw(c) {
      const { ctx, w, h, theme } = c;
      const period = P(c.props, "period", 3.6);
      const segs = Math.max(6, Math.floor(P(c.props, "segments", 14)));
      const cx = w / 2;
      const cy = h * 0.72;
      const R = Math.min(w * 0.44, h * 0.62);
      const a0 = Math.PI * 1.15;
      const a1 = Math.PI * 1.85;
      const needle = lerp(a0, a1, 0.5 + 0.5 * Math.sin(c.t / period * Math.PI * 2 - Math.PI / 2));
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
      ctx.strokeStyle = rgba(theme.textDim, 0.4);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, R * 0.7, a0, a1);
      ctx.stroke();
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
      const val = Math.round((needle - a0) / (a1 - a0) * 100);
      ctx.font = font(c, R * 0.22, 700);
      ctx.textBaseline = "middle";
      ctx.fillStyle = rgba(theme.text, 0.92);
      const txt = String(val).padStart(3, "0");
      ctx.fillText(txt, cx - ctx.measureText(txt).width / 2, cy - R * 0.42);
      c.report({ state: "dial", measure: { value: val, period } });
    }
  });
  registerWidget({
    name: "bdTerminal",
    defaultSize: { w: 560, h: 340 },
    draw(c) {
      const { ctx, w, h, theme } = c;
      const size = Math.max(10, P(c.props, "size", 15) * c.env.ds);
      const title = String(P(c.props, "title", "kine \u2014 render"));
      const lines = Math.max(3, Math.floor(P(c.props, "lines", 11)));
      const barH = size * 1.7;
      ctx.fillStyle = rgba(theme.bg[1], 0.88);
      rr(ctx, 0, 0, w, h, 8);
      ctx.fill();
      ctx.strokeStyle = rgba(theme.textDim, 0.5);
      ctx.lineWidth = 1;
      rr(ctx, 0, 0, w, h, 8);
      ctx.stroke();
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
      ctx.textBaseline = "middle";
      ctx.fillText(title, barH * 1.6, barH / 2);
      ctx.font = font(c, size, 400);
      const lh = size * 1.5;
      const top = barH + lh * 0.4;
      const vis = Math.min(lines, Math.floor((h - top - barH) / lh));
      const spd = Math.max(0.05, P(c.props, "speed", 1));
      for (let i = 0; i < vis; i++) {
        const rowIdx = Math.floor(c.t * 1.15 * spd) - (vis - 1 - i);
        const y = top + i * lh;
        const stage = Math.abs((rowIdx % 60 + 60) % 60);
        let text;
        let col = rgba(theme.textDim, 0.85);
        if (stage % 5 === 0) {
          const frame = Math.floor(c.rng(`widget.${c.id}.fr`, rowIdx) * 8274);
          text = `\u2713 frame ${String(frame).padStart(6, "0")} \u2192 ${c.rng(`widget.${c.id}.k`, rowIdx) > 0.5 ? "chunk_a.ts" : "chunk_b.ts"}`;
        } else if (stage % 5 === 1) {
          text = `\xB7 ir loaded  specHash ${hexByte(c.rng(`widget.${c.id}.h1`, rowIdx))}${hexByte(c.rng(`widget.${c.id}.h2`, rowIdx))}${hexByte(c.rng(`widget.${c.id}.h3`, rowIdx))}${hexByte(c.rng(`widget.${c.id}.h4`, rowIdx))}`;
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
      ctx.textBaseline = "middle";
      ctx.fillText(`${Math.floor(pp * 100)}%`, bx + bw + size * 0.4, by + barH * 0.21);
      c.report({ state: "terminal", measure: { progress: +pp.toFixed(3), lines: vis } });
    }
  });

  // packages/widgets/src/draw1.ts
  var TAU = Math.PI * 2;
  registerWidget({
    name: "motes",
    defaultSize: { w: 640, h: 400 },
    draw(c) {
      const { ctx, w, h, theme } = c;
      const n = Math.max(10, Math.floor(P(c.props, "count", 48)));
      const smax = P(c.props, "size", 2.4) * c.env.ds;
      for (let i = 0; i < n; i++) {
        const u = c.rng(`widget.${c.id}.x`, i);
        const v = c.rng(`widget.${c.id}.y`, i);
        const s = 0.4 + 1.6 * Math.pow(c.rng(`widget.${c.id}.s`, i), 2);
        const ph = c.rng(`widget.${c.id}.ph`, i) * TAU;
        const x = frac2(u + c.t * 0.012 * (0.5 + v)) * w;
        const y = frac2(v + c.t * 6e-3 * (1.2 - u)) * h + Math.sin(c.t * 0.5 + ph) * 6;
        const tw = 0.3 + 0.7 * (0.5 + 0.5 * Math.sin(c.t * (0.6 + u) + ph));
        ctx.fillStyle = rgba(theme.text, 0.1 + 0.28 * tw);
        ctx.beginPath();
        ctx.arc(x, y % h, s * smax, 0, TAU);
        ctx.fill();
      }
      c.report({ state: "motes", measure: { count: n } });
    }
  });
  registerWidget({
    name: "globe",
    defaultSize: { w: 320, h: 320 },
    draw(c) {
      const { ctx, w, h, theme } = c;
      const cx = w / 2;
      const cy = h / 2;
      const R = Math.min(w, h) * 0.44;
      const rot = c.t * 0.42;
      ctx.lineWidth = 1;
      ctx.strokeStyle = rgba(theme.textDim, 0.7);
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, TAU);
      ctx.stroke();
      for (let k = -2; k <= 2; k++) {
        const lat = k / 2.6 * (Math.PI / 2);
        const ry = R * Math.cos(lat);
        const yy = cy - R * Math.sin(lat);
        ctx.strokeStyle = rgba(theme.textDim, 0.35);
        ctx.beginPath();
        ctx.ellipse(cx, yy, ry, ry * 0.16, 0, 0, TAU);
        ctx.stroke();
      }
      for (let k = 0; k < 6; k++) {
        const ph = rot + k * Math.PI / 6;
        const rx = Math.abs(Math.cos(ph)) * R;
        ctx.strokeStyle = rgba(k === 0 ? theme.accent : theme.textDim, k === 0 ? 0.75 : 0.32);
        ctx.beginPath();
        ctx.ellipse(cx, cy, Math.max(1.5, rx), R, 0, 0, TAU);
        ctx.stroke();
      }
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
      c.report({ state: "globe", measure: { rotation: +frac2(rot / TAU).toFixed(3) } });
    }
  });
  registerWidget({
    name: "tesseract",
    defaultSize: { w: 320, h: 320 },
    draw(c) {
      const { ctx, w, h, theme } = c;
      const cx = w / 2;
      const cy = h / 2;
      const R = Math.min(w, h) * 0.4;
      const a1 = c.t * 0.31;
      const a2 = c.t * 0.21;
      const pts = [];
      for (let i = 0; i < 16; i++) {
        let x = i & 1 ? 1 : -1;
        let y = i & 2 ? 1 : -1;
        let z = i & 4 ? 1 : -1;
        let vw = i & 8 ? 1 : -1;
        const x2 = x * Math.cos(a1) - vw * Math.sin(a1);
        const w2 = x * Math.sin(a1) + vw * Math.cos(a1);
        x = x2;
        const y2 = y * Math.cos(a2) - z * Math.sin(a2);
        const z2 = y * Math.sin(a2) + z * Math.cos(a2);
        y = y2;
        z = z2;
        vw = w2;
        const k = 2.1 / (2.1 + vw);
        pts.push([cx + x * k * R * 0.9, cy + y * k * R * 0.9 - z * k * 8]);
      }
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
      ctx.fillStyle = rgba(theme.text, 0.9);
      for (const [x, y] of pts) {
        ctx.beginPath();
        ctx.arc(x, y, 2.2, 0, TAU);
        ctx.fill();
      }
      c.report({ state: "tesseract", measure: { a1: +frac2(a1 / TAU).toFixed(3), a2: +frac2(a2 / TAU).toFixed(3) } });
    }
  });
  registerWidget({
    name: "heart",
    defaultSize: { w: 300, h: 300 },
    draw(c) {
      const { ctx, w, h, theme } = c;
      const period = P(c.props, "period", 1.15);
      const pts = Math.max(150, Math.floor(P(c.props, "points", 220)));
      const cx = w / 2;
      const cy = h * 0.46;
      const scale = Math.min(w, h) * 0.02;
      const ut = frac2(c.t / period);
      const beat = Math.exp(-ut * 6) + 0.7 * Math.exp(-Math.abs(ut - 0.24) * 9);
      const pulse = 1 + 0.075 * beat;
      for (let i = 0; i < pts; i++) {
        const u = c.rng(`widget.${c.id}.u`, i);
        const v = c.rng(`widget.${c.id}.v`, i);
        const th = u * TAU;
        const hx = 16 * Math.pow(Math.sin(th), 3);
        const hy = -(13 * Math.cos(th) - 5 * Math.cos(2 * th) - 2 * Math.cos(3 * th) - Math.cos(4 * th));
        const rr2 = Math.pow(v, 0.5);
        const jitter = 1 + 0.05 * Math.sin(c.t * 2.2 + i);
        const x = cx + hx * scale * pulse * rr2 * jitter;
        const y = cy + hy * scale * pulse * rr2 * jitter + Math.sin(c.t * 3 + i) * 0.6;
        const a = 0.25 + 0.6 * (1 - rr2) + 0.15 * beat;
        ctx.fillStyle = i % 28 === 0 ? rgba(theme.accent, clamp(a, 0, 1)) : rgba(theme.text, clamp(a * 0.75, 0, 1));
        ctx.beginPath();
        ctx.arc(x, y, 1.4 + i % 5 * 0.16, 0, TAU);
        ctx.fill();
      }
      c.report({ state: "heart", measure: { beat: +beat.toFixed(3), pulse: +pulse.toFixed(4), points: pts } });
    }
  });
  registerWidget({
    name: "pcb",
    defaultSize: { w: 520, h: 320 },
    draw(c) {
      const { ctx, w, h, theme } = c;
      const traces = Math.max(4, Math.floor(P(c.props, "traces", 10)));
      ctx.lineWidth = 1.4;
      for (let i = 0; i < traces; i++) {
        const segs = 3 + Math.floor(c.rng(`widget.${c.id}.ns`, i) * 3);
        let x = c.rng(`widget.${c.id}.x`, i) * w * 0.8;
        let y = c.rng(`widget.${c.id}.y`, i) * h * 0.8;
        const pts = [[x, y]];
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
        for (const [px, py] of [pts[0], pts[pts.length - 1]]) {
          ctx.fillStyle = rgba(theme.text, 0.5);
          ctx.beginPath();
          ctx.arc(px, py, 2.4, 0, TAU);
          ctx.fill();
        }
        let total = 0;
        const lens = [];
        for (let k = 1; k < pts.length; k++) {
          const d = Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
          lens.push(d);
          total += d;
        }
        const speed = 0.5 + 0.5 * c.rng(`widget.${c.id}.sp`, i);
        const ppos = frac2(c.t * speed * 0.42 + c.rng(`widget.${c.id}.ph`, i));
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
      c.report({ state: "pcb", measure: { traces } });
    }
  });
  registerWidget({
    name: "grid",
    defaultSize: { w: 640, h: 360 },
    draw(c) {
      const { ctx, w, h, theme } = c;
      const speed = P(c.props, "speed", 0.55);
      const horizon = h * P(c.props, "horizon", 0.42);
      const vx = w / 2;
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
      const rows = 16;
      for (let k = 0; k < rows; k++) {
        const u = frac2(k / rows + c.t * speed * 0.12);
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
      c.report({ state: "grid", measure: { horizon: +horizon.toFixed(1), speed } });
    }
  });
  registerWidget({
    name: "membank",
    defaultSize: { w: 440, h: 220 },
    draw(c) {
      const { ctx, w, h, theme } = c;
      const cols = Math.max(6, Math.floor(P(c.props, "cols", 12)));
      const rows = Math.max(4, Math.floor(P(c.props, "rows", 6)));
      const rate = P(c.props, "rate", 3.2);
      const cw = w / cols;
      const ch = h / rows;
      const tick = Math.floor(c.t * rate);
      ctx.font = font(c, ch * 0.42, 400);
      ctx.textBaseline = "middle";
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
      c.report({ state: "membank", measure: { tick, cols, rows } });
    }
  });
  registerWidget({
    name: "disk",
    defaultSize: { w: 300, h: 300 },
    draw(c) {
      const { ctx, w, h, theme } = c;
      const cx = w / 2;
      const cy = h / 2;
      const R = Math.min(w, h) * 0.44;
      ctx.fillStyle = rgba(theme.text, 0.045);
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, TAU);
      ctx.fill();
      ctx.strokeStyle = rgba(theme.textDim, 0.6);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, R, 0, TAU);
      ctx.stroke();
      const rot = c.t * 0.9;
      for (let k = 0; k < 24; k++) {
        const a0 = rot + k * TAU / 24;
        const on = c.rng(`widget.${c.id}.sec`, k + Math.floor(c.t * 3.1) * 37) > 0.72;
        const R0 = R * (0.42 + 0.5 * c.rng(`widget.${c.id}.r0`, k));
        ctx.strokeStyle = rgba(on ? theme.accent : theme.textDim, on ? 0.75 : 0.16);
        ctx.lineWidth = on ? 2 : 1;
        ctx.beginPath();
        ctx.arc(cx, cy, R0, a0, a0 + TAU / 24 * 0.72);
        ctx.stroke();
      }
      for (let k = 1; k <= 4; k++) {
        ctx.strokeStyle = rgba(theme.textDim, 0.14);
        ctx.beginPath();
        ctx.arc(cx, cy, R * k / 5, 0, TAU);
        ctx.stroke();
      }
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
      c.report({ state: "disk", measure: { rotation: +frac2(rot / TAU).toFixed(3), arm: +armA.toFixed(3) } });
    }
  });
  registerWidget({
    name: "life",
    defaultSize: { w: 480, h: 270 },
    draw(c) {
      const { ctx, w, h, theme } = c;
      const cols = Math.max(12, Math.floor(P(c.props, "cols", 48)));
      const rows = Math.max(8, Math.floor(P(c.props, "rows", 27)));
      const stepDur = P(c.props, "period", 0.16);
      const step = Math.floor(c.t / stepDur);
      const cap = Math.min(step, 400);
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
            nxt[idx] = grid[idx] ? n === 2 || n === 3 ? 1 : 0 : n === 3 ? 1 : 0;
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
      c.report({ state: "life", measure: { step, capped: cap, cols, rows } });
    }
  });

  // packages/widgets/src/draw2.ts
  var TAU2 = Math.PI * 2;
  registerWidget({
    name: "classGraph",
    defaultSize: { w: 480, h: 320 },
    draw(c) {
      const { ctx, w, h, theme } = c;
      const n = Math.max(3, Math.floor(P(c.props, "nodes", 5)));
      const bw = w * 0.26;
      const bh = h * 0.16;
      const nodes = [];
      for (let i = 0; i < n; i++) {
        const ang = i / n * TAU2 - Math.PI / 2 + c.t * 0.05;
        nodes.push({ x: w / 2 + Math.cos(ang) * w * 0.33 - bw / 2, y: h / 2 + Math.sin(ang) * h * 0.34 - bh / 2 });
      }
      for (let i = 0; i < n; i++) {
        const a = nodes[i];
        const b = nodes[(i + 1) % n];
        const ax = a.x + bw / 2;
        const ay = a.y + bh / 2;
        const bx = b.x + bw / 2;
        const by = b.y + bh / 2;
        const mx = (ax + bx) / 2;
        ctx.strokeStyle = rgba(theme.textDim, 0.4);
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.moveTo(ax, ay);
        ctx.lineTo(mx, ay);
        ctx.lineTo(mx, by);
        ctx.lineTo(bx, by);
        ctx.stroke();
        const p = frac2(c.t * (0.35 + 0.2 * c.rng(`widget.${c.id}.sp`, i)) + c.rng(`widget.${c.id}.ph`, i));
        let px;
        let py;
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
        ctx.arc(px, py, 2.6, 0, TAU2);
        ctx.fill();
      }
      nodes.forEach((pos, i) => {
        const active = Math.floor(frac2(c.t * 0.4) * n) === i;
        ctx.fillStyle = rgba(theme.text, active ? 0.13 : 0.06);
        rr(ctx, pos.x, pos.y, bw, bh, 5);
        ctx.fill();
        ctx.strokeStyle = rgba(active ? theme.accent : theme.textDim, active ? 0.9 : 0.45);
        ctx.lineWidth = active ? 1.8 : 1;
        rr(ctx, pos.x, pos.y, bw, bh, 5);
        ctx.stroke();
        ctx.fillStyle = rgba(theme.text, 0.8);
        ctx.font = font(c, bh * 0.42, 400);
        ctx.textBaseline = "middle";
        const label = `${["class", "fn", "test", "data", "api"][i % 5]}_${i}`;
        ctx.fillText(label, pos.x + 8, pos.y + bh / 2);
      });
      c.report({ state: "classGraph", measure: { nodes: n } });
    }
  });
  registerWidget({
    name: "symbols",
    defaultSize: { w: 420, h: 300 },
    draw(c) {
      const { ctx, w, h, theme } = c;
      const rate = P(c.props, "rate", 8);
      const size = Math.max(10, P(c.props, "size", 15) * c.env.ds);
      ctx.font = font(c, size, 400);
      ctx.textBaseline = "top";
      const cols = Math.max(6, Math.floor(w / (size * 1.4)));
      const cw = w / cols;
      const tick = Math.floor(c.t * rate);
      for (let i = 0; i < cols; i++) {
        const off = c.rng(`widget.${c.id}.off`, i);
        const row = (tick + Math.floor(off * 17)) % 9;
        for (let k = 0; k < 5; k++) {
          const y = (row + k) % 9 * (h / 9);
          const v = c.rng(`widget.${c.id}.ch`, i * 89 + k + tick * 13);
          const a = k === 0 ? 0.9 : 0.14 + 0.4 * (1 - k / 5);
          const ch = "!@#$%&*+=<>/\\|{}[]();:~^?\xD8\u0394\u03A3\u03C0\u03BB"[Math.floor(v * 23)];
          ctx.fillStyle = rgba(theme.text, a);
          ctx.fillText(ch, i * cw + cw * 0.16, y);
        }
      }
      c.report({ state: "symbols", measure: { tick, cols } });
    }
  });
  registerWidget({
    name: "pipeline",
    defaultSize: { w: 520, h: 110 },
    draw(c) {
      const { ctx, w, h, theme } = c;
      const n = Math.max(3, Math.floor(P(c.props, "stages", 5)));
      const period = P(c.props, "period", 3.2);
      const p = phase(c.t, period);
      const cur = p * n;
      const y = h * 0.34;
      const bh = h * 0.32;
      ctx.font = font(c, bh * 0.5, 700);
      ctx.textBaseline = "middle";
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
        if (doing) {
          const f = clamp(cur - i, 0, 1);
          ctx.fillStyle = rgba(theme.accent, 0.28);
          ctx.fillRect(x + 1.5, y + 1.5, (bw - 3) * f, bh - 3);
        }
        ctx.fillStyle = rgba(done ? theme.text : doing ? theme.accent : theme.textDim, 0.9);
        const label = `0${i + 1}`;
        ctx.fillText(label, x + bw / 2 - ctx.measureText(label).width / 2, y + bh / 2);
        if (i < n - 1) {
          ctx.fillStyle = rgba(theme.textDim, 0.5);
          ctx.fillRect(x + bw + 4, y + bh / 2 - 1, 12, 2);
          const px = x + bw + 4 + frac2(cur - i) * 12;
          if (doing) {
            ctx.fillStyle = rgba(theme.accent, 0.9);
            ctx.beginPath();
            ctx.arc(px, y + bh / 2, 2.6, 0, TAU2);
            ctx.fill();
          }
        }
      }
      const stat = cur >= n ? "BUILD OK" : `STAGE ${Math.min(n, Math.floor(cur) + 1)}/${n}`;
      ctx.font = font(c, h * 0.13, 400);
      ctx.fillStyle = rgba(theme.textDim, 0.75);
      ctx.fillText(stat, 2, h * 0.86);
      c.report({ state: cur >= n ? "ok" : "running", measure: { stage: +cur.toFixed(2), stages: n } });
    }
  });
  registerWidget({
    name: "stars",
    defaultSize: { w: 640, h: 400 },
    draw(c) {
      const { ctx, w, h, theme } = c;
      const n = Math.max(30, Math.floor(P(c.props, "count", 130)));
      const period = P(c.props, "period", 2.6);
      for (let i = 0; i < n; i++) {
        const x = c.rng(`widget.${c.id}.x`, i) * w;
        const y = c.rng(`widget.${c.id}.y`, i) * h;
        const ph = c.rng(`widget.${c.id}.ph`, i);
        const base = 0.14 + 0.3 * c.rng(`widget.${c.id}.b`, i);
        const tw = base + 0.55 * Math.max(0, Math.sin((c.t / period + ph) * TAU2));
        const big = i % 17 === 0;
        ctx.fillStyle = rgba(theme.text, clamp(tw, 0, 0.95));
        ctx.beginPath();
        ctx.arc(x, y, big ? 2.4 : 1.1 + 0.7 * ph, 0, TAU2);
        ctx.fill();
        if (big && tw > 0.45) {
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
      c.report({ state: "stars", measure: { count: n } });
    }
  });
  registerWidget({
    name: "constellations",
    defaultSize: { w: 560, h: 360 },
    draw(c) {
      const { ctx, w, h, theme } = c;
      const n = Math.max(8, Math.floor(P(c.props, "stars", 18)));
      const drift = c.t * 0.014;
      const pts = [];
      for (let i = 0; i < n; i++) {
        const x = frac2(c.rng(`widget.${c.id}.x`, i) + drift * (0.5 + c.rng(`widget.${c.id}.px`, i))) * w;
        const y = frac2(c.rng(`widget.${c.id}.y`, i) + drift * 0.4) * h;
        pts.push({ x, y });
      }
      ctx.lineWidth = 1;
      for (let i = 0; i < n; i++) {
        const ds = [];
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
      for (let i = 0; i < n; i++) {
        const tw = 0.4 + 0.5 * (0.5 + 0.5 * Math.sin((c.t / 2.2 + c.rng(`widget.${c.id}.ph`, i)) * TAU2));
        ctx.fillStyle = rgba(theme.text, tw);
        ctx.beginPath();
        ctx.arc(pts[i].x, pts[i].y, 1.8, 0, TAU2);
        ctx.fill();
        if (i % 6 === 0) {
          ctx.fillStyle = rgba(theme.accent, tw * 0.9);
          ctx.beginPath();
          ctx.arc(pts[i].x, pts[i].y, 2.6, 0, TAU2);
          ctx.fill();
        }
      }
      c.report({ state: "constellations", measure: { stars: n } });
    }
  });
  registerWidget({
    name: "ash",
    defaultSize: { w: 560, h: 340 },
    draw(c) {
      const { ctx, w, h, theme } = c;
      const n = Math.max(16, Math.floor(P(c.props, "count", 60)));
      for (let i = 0; i < n; i++) {
        const u = c.rng(`widget.${c.id}.x`, i);
        const v = c.rng(`widget.${c.id}.y`, i);
        const sp = 0.03 + 0.06 * c.rng(`widget.${c.id}.sp`, i);
        const y = h - frac2(v + c.t * sp) * (h * 1.12);
        const sway = Math.sin(c.t * (0.6 + u) + i) * (8 + 14 * v);
        const x = frac2(u + Math.sin(c.t * 0.2 + i) * 0.01) * w + sway * 0.3;
        const life = clamp(y / h * 1.2, 0, 1);
        const ember = i % 9 === 0;
        const tw = 0.5 + 0.5 * Math.sin(c.t * 3.4 + i * 1.7);
        ctx.fillStyle = ember ? rgba(theme.accent, 0.2 + 0.3 * tw * life) : rgba(theme.text, 0.12 + 0.3 * life * (0.5 + 0.5 * tw));
        ctx.beginPath();
        ctx.arc(x, y, 1 + 1.6 * v, 0, TAU2);
        ctx.fill();
      }
      c.report({ state: "ash", measure: { count: n } });
    }
  });
  registerWidget({
    name: "telemetry",
    defaultSize: { w: 340, h: 220 },
    draw(c) {
      const { ctx, w, h, theme } = c;
      const rows = Math.max(2, Math.floor(P(c.props, "rows", 5)));
      const rh = h / rows;
      const labels = ["CPU", "MEM", "NET", "BEAT", "FPS", "LAT", "JIT", "IO"];
      for (let r = 0; r < rows; r++) {
        const y0 = r * rh;
        const lab = labels[r % labels.length];
        const slow = 0.5 + 0.5 * Math.sin(c.t * (0.3 + r * 0.11) + r);
        const fast = c.rng(`widget.${c.id}.fast`, r * 31 + Math.floor(c.t * 6));
        const val = clamp(slow * 0.75 + fast * 0.25, 0, 1);
        ctx.fillStyle = rgba(theme.textDim, 0.7);
        ctx.font = font(c, rh * 0.34, 400);
        ctx.textBaseline = "middle";
        ctx.fillText(lab, 0, y0 + rh * 0.32);
        ctx.fillStyle = rgba(val > 0.82 ? theme.accent : theme.text, 0.9);
        const valS = `${(val * 100).toFixed(1)}%`;
        ctx.fillText(valS, w * 0.3 - ctx.measureText(valS).width, y0 + rh * 0.32);
        const gx = w * 0.34;
        const gw = w - gx - 4;
        const gh = rh * 0.34;
        const gy = y0 + rh * 0.15;
        ctx.beginPath();
        const segs = 22;
        for (let s = 0; s <= segs; s++) {
          const vv = clamp(0.5 + 0.5 * Math.sin(c.t * (0.7 + r * 0.13) + s / segs * 6 + c.rng(`widget.${c.id}.wv`, r * 7 + s) * 0.8), 0, 1);
          const x = gx + s / segs * gw;
          const y = gy + gh - vv * gh;
          if (s === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        }
        ctx.strokeStyle = rgba(theme.textDim, 0.65);
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.fillStyle = rgba(theme.textDim, 0.18);
        ctx.fillRect(0, y0 + rh - 1, w, 1);
      }
      c.report({ state: "telemetry", measure: { rows } });
    }
  });
  registerWidget({
    name: "points",
    defaultSize: { w: 340, h: 340 },
    draw(c) {
      const { ctx, w, h, theme } = c;
      const n = Math.max(60, Math.floor(P(c.props, "count", 180)));
      const period = P(c.props, "period", 5.2);
      const cx = w / 2;
      const cy = h / 2;
      const R = Math.min(w, h) * 0.4;
      const shape = (kind, u) => {
        if (kind === 0) {
          const a = u * TAU2;
          return [Math.cos(a), Math.sin(a)];
        }
        if (kind === 1) {
          const s = u * 4;
          const edge = Math.floor(s) % 4;
          const f2 = s - Math.floor(s) - 0.5;
          if (edge === 0) return [f2 * 2, -1];
          if (edge === 1) return [1, f2 * 2];
          if (edge === 2) return [-f2 * 2, 1];
          return [-1, -f2 * 2];
        }
        if (kind === 2) {
          const s = u * 3;
          const edge = Math.floor(s) % 3;
          const f2 = s - Math.floor(s) - 0.5;
          const p0 = [0, -1];
          const p1 = [0.87, 0.5];
          const p2 = [-0.87, 0.5];
          const a = [p0, p1, p2][edge];
          const b = [p1, p2, p0][edge];
          return [lerp(a[0], b[0], f2 + 0.5), lerp(a[1], b[1], f2 + 0.5)];
        }
        const half = u % 0.5;
        const vert = u < 0.5;
        const f = u * 2 % 1 - 0.5;
        if (vert) return [f * 2.2, u < 0.25 ? -1 : 1];
        return [u < 0.75 ? -1 : 1, f * 2.2];
      };
      const p = phase(c.t, period);
      const from = Math.floor(c.t / period) % 4;
      const to = (from + 1) % 4;
      const morph = smooth3(clamp((p - 0.72) / 0.28, 0, 1));
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
        ctx.arc(cx + xr, cy + yr, 1.6 + i % 4 * 0.3, 0, TAU2);
        ctx.fill();
      }
      c.report({ state: morph > 0 ? "morphing" : "hold", measure: { morph: +morph.toFixed(3), from, to } });
    }
  });

  // packages/widgets/src/meta.ts
  var P2 = (name, type, def, desc) => ({ name, type, default: def, desc });
  var WIDGET_META = {
    // ---- bd 族（16）
    bdBG: {
      desc: "\u80CC\u666F\u7F51\u683C\uFF1A\u7EC6\u7F51\u683C\u4E0A\u4E00\u6761\u626B\u63CF\u5E26\u5468\u671F\u6027\u626B\u8FC7\uFF0C\u5E26\u5185\u683C\u5B50\u77ED\u6682\u53D8\u4EAE\uFF08\u5927\u9762\u79EF\u6D3B\u80CC\u666F\uFF0C\u9632\u9759\u6001\uFF09",
      props: [P2("cell", "number", 26, "\u7F51\u683C\u683C\u5B50\u8FB9\u957F\uFF08\u8BBE\u8BA1\u50CF\u7D20\uFF09"), P2("sweep", "number", 7, "\u626B\u63CF\u5E26\u626B\u8FC7\u5468\u671F\uFF08\u79D2\uFF09")]
    },
    bdTitle: {
      desc: "\u5927\u6807\u9898\uFF1A\u9010\u5B57\u6253\u51FA + \u5F3A\u8C03\u8272\u4E0B\u5212\u7EBF\u4ECE\u5DE6\u626B\u8FC7 + \u6253\u5B57\u5149\u6807\u95EA\u70C1\uFF1B\u6253\u5B57\u7ED3\u675F\u4FDD\u6301\u5168\u6807\u9898",
      note: "\u9ED8\u8BA4\u5DE6\u5BF9\u9F50\uFF08\u5185\u5BB9\u4ECE\u951A\u70B9\u5411\u53F3\u5EF6\u4F38\uFF09\uFF1B\u9700\u8981\u5C45\u4E2D\u8BF7\u8BBE align: center",
      props: [
        P2("text", "string", "WORLD.EXECUTE", "\u4E3B\u6807\u9898\u6587\u672C"),
        P2("sub", "string", "", "\u526F\u6807\u9898\uFF08\u5C0F\u5B57\u53F7\u3001\u5F31\u8272\uFF09"),
        P2("size", "number", 44, "\u4E3B\u6807\u9898\u5B57\u53F7\uFF08\u8BBE\u8BA1\u50CF\u7D20\uFF09"),
        P2("type_period", "number", 0.05, "\u9010\u5B57\u6253\u5B57\u95F4\u9694\uFF08\u79D2\uFF09\uFF1B0=\u7ACB\u5373\u5168\u663E"),
        P2("underline_period", "number", 2.6, "\u4E0B\u5212\u7EBF\u626B\u63A0\u5468\u671F\uFF08\u79D2\uFF09"),
        P2("align", "string", "left", "\u6A2A\u5411\u5BF9\u9F50\uFF1Aleft\uFF08\u9ED8\u8BA4\uFF09/ center / right")
      ]
    },
    bdKey: {
      desc: '\u952E\u4F4D\u884C\uFF1A\u6309\u5B57\u7B26\u5217\u51FA\u952E\u5E3D\uFF0C\u5468\u671F\u6027\u9AD8\u4EAE"\u6309\u4E0B"',
      props: [P2("keys", "string", "W A S D", "\u952E\u4F4D\u5B57\u7B26\uFF08\u7A7A\u683C\u5206\u9694\uFF09"), P2("period", "number", 0.62, "\u6309\u952E\u9AD8\u4EAE\u5468\u671F\uFF08\u79D2\uFF09")]
    },
    bdLive: {
      desc: "LIVE \u6307\u793A\uFF1A\u7EA2\u70B9\u547C\u5438\u95EA\u70C1 + \u8FD0\u884C\u8BA1\u65F6\uFF08mm:ss.cc\uFF09",
      props: [P2("label", "string", "LIVE", "\u524D\u7F00\u6807\u7B7E\u6587\u672C")]
    },
    bdScan: {
      desc: "\u626B\u63CF\u5668\uFF1A\u9876\u90E8\u6761\u5F62\u7801\u67F1\u72B6\u7801 + \u4E00\u6761\u5F3A\u8C03\u8272\u626B\u63CF\u7EBF\u4E0A\u4E0B\u79FB\u52A8\uFF08\u5E26\u4F59\u8F89\uFF09",
      props: [P2("period", "number", 2.4, "\u626B\u63CF\u5468\u671F\uFF08\u79D2\uFF09")]
    },
    bdPulse: {
      desc: "\u5FC3\u7535\u8109\u51B2\uFF1A\u5168\u5BBD\u6EDA\u52A8\u7684\u5FC3\u7535 QRS \u6CE2\u5F62\uFF08\u5C16\u5CF0 + \u5E73\u7EBF\uFF09",
      props: [P2("period", "number", 1.05, "\u8109\u51B2\u5468\u671F\uFF08\u79D2\uFF09"), P2("amp", "number", 0.36, "\u632F\u5E45\uFF080-1\uFF09")]
    },
    bdBars: {
      desc: "\u9891\u8C31\u67F1\uFF1A\u591A\u6839\u67F1\u4F53\u5468\u671F\u6027\u8D77\u4F0F + \u5CF0\u503C\u9AD8\u4EAE",
      props: [P2("bars", "number", 24, "\u67F1\u6570\u91CF"), P2("period", "number", 1.6, "\u8D77\u4F0F\u5468\u671F\uFF08\u79D2\uFF09")]
    },
    bdRing: {
      desc: "\u540C\u5FC3\u73AF\u4EEA\u8868\uFF1A\u591A\u5C42\u5706\u5F27\u65CB\u8F6C + \u767E\u5206\u6BD4\u8BFB\u6570\u6446\u52A8",
      props: [P2("rings", "number", 3, "\u73AF\u6570\u91CF"), P2("period", "number", 3.2, "\u65CB\u8F6C\u5468\u671F\uFF08\u79D2\uFF09")]
    },
    bdCells: {
      desc: "\u7F51\u683C\u4EAE\u706D\uFF1Acols\xD7rows \u683C\u5B50\u6309\u786E\u5B9A\u6027\u56FE\u6848\u5468\u671F\u6027\u660E\u706D",
      props: [P2("cols", "number", 14, "\u5217\u6570"), P2("rows", "number", 8, "\u884C\u6570"), P2("period", "number", 0.85, "\u4EAE\u706D\u5468\u671F\uFF08\u79D2\uFF09")]
    },
    bdWave: {
      desc: "\u591A\u9053\u6B63\u5F26\u6CE2\uFF1A\u591A\u6761\u76F8\u4F4D\u79FB\u52A8\u7684\u6CE2\u5F62\u7EBF\uFF08\u53EF\u4F5C\u5730\u5E73\u7EBF/\u4FE1\u53F7\u6CE2\u5F62\uFF09",
      props: [P2("waves", "number", 3, "\u6CE2\u6570\u91CF"), P2("speed", "number", 0.9, "\u76F8\u4F4D\u79FB\u52A8\u901F\u5EA6")]
    },
    bdHex: {
      desc: "\u5341\u516D\u8FDB\u5236\u8F6C\u50A8\uFF1A\u5B57\u7B26\u6D41\u9010\u884C\u6EDA\u52A8 + \u9AD8\u4EAE\u5217\uFF08\u50CF hex dump\uFF09",
      props: [P2("lines", "number", 12, "\u53EF\u89C1\u884C\u6570"), P2("speed", "number", 1.4, "\u6EDA\u52A8\u901F\u5EA6")]
    },
    bdCursor: {
      desc: "\u6253\u5B57\u673A\uFF1Atext \u9010\u5B57\u6253\u51FA\u5E76\u5FAA\u73AF + \u5149\u6807\u95EA\u70C1",
      props: [P2("text", "string", "kine render --range 0:5", "\u6253\u5B57\u6587\u672C"), P2("period", "number", 3.4, "\u5FAA\u73AF\u5468\u671F\uFF08\u79D2\uFF09"), P2("size", "number", 20, "\u5B57\u53F7\uFF08\u8BBE\u8BA1\u50CF\u7D20\uFF09")]
    },
    bdRainDrops: {
      desc: "\u6570\u5B57\u96E8\uFF1A\u591A\u5217\u5B57\u7B26\u5E26\u5C3E\u8FF9\u4E0B\u843D",
      props: [P2("drops", "number", 26, "\u96E8\u6EF4\uFF08\u5217\uFF09\u6570\u91CF"), P2("speed", "number", 1, "\u4E0B\u843D\u901F\u5EA6"), P2("size", "number", 13, "\u5B57\u53F7\uFF08\u8BBE\u8BA1\u50CF\u7D20\uFF09")]
    },
    bdFlow: {
      desc: "\u6D41\u6C34\u7EBF\uFF1A\u8282\u70B9\u7528\u7BAD\u5934\u76F8\u8FDE\uFF0C\u6570\u636E\u5305\u6CBF\u8DEF\u5F84\u79FB\u52A8",
      props: [P2("nodes", "number", 5, "\u8282\u70B9\u6570\u91CF"), P2("period", "number", 2.8, "\u6570\u636E\u5305\u5468\u671F\uFF08\u79D2\uFF09")]
    },
    bdDial: {
      desc: "\u4EEA\u8868\u76D8\uFF1A\u523B\u5EA6\u5F27 + \u6307\u9488\u5468\u671F\u6027\u6446\u52A8 + \u8BFB\u6570",
      props: [P2("period", "number", 3.6, "\u6446\u52A8\u5468\u671F\uFF08\u79D2\uFF09"), P2("segments", "number", 14, "\u523B\u5EA6\u6BB5\u6570")]
    },
    bdTerminal: {
      desc: "\u7EC8\u7AEF\u7A97\u53E3\uFF1A\u6807\u9898\u680F\u7EA2\u70B9 + \u6EDA\u52A8\u65E5\u5FD7\u884C + \u5E95\u90E8\u8FDB\u5EA6\u6761\uFF08\u7A97\u53E3 chrome \u9020\u578B\uFF09",
      props: [
        P2("size", "number", 15, "\u5B57\u53F7\uFF08\u8BBE\u8BA1\u50CF\u7D20\uFF09"),
        P2("title", "string", "kine \u2014 render", "\u6807\u9898\u680F\u6587\u672C"),
        P2("lines", "number", 11, "\u53EF\u89C1\u65E5\u5FD7\u884C\u6570"),
        P2("speed", "number", 1, "\u65E5\u5FD7\u6EDA\u52A8\u901F\u5EA6\u500D\u7387\uFF08v4 \u8D77\u751F\u6548\uFF0C1=\u539F\u901F\uFF09")
      ]
    },
    // ---- draw1 族（9）
    motes: {
      desc: "\u6D6E\u5C18\uFF1A\u7F13\u6162\u6F02\u6D6E\u7684\u5C0F\u5149\u70B9\uFF08\u8FDC/\u8FD1\u5C42\u89C6\u5DEE\u7528\uFF09",
      props: [P2("count", "number", 48, "\u7C92\u5B50\u6570\u91CF"), P2("size", "number", 2.4, "\u5C3A\u5BF8\uFF08\u8BBE\u8BA1\u50CF\u7D20\uFF09")]
    },
    globe: {
      desc: "\u7EBF\u6846\u5730\u7403\uFF1A\u7ECF\u7EAC\u7EBF\u7403\u4F53\u6301\u7EED\u65CB\u8F6C + \u57CE\u5E02\u4EAE\u70B9\u95EA\u70C1",
      props: []
    },
    tesseract: {
      desc: "\u56DB\u7EF4\u8D85\u7ACB\u65B9\uFF1A8 \u4E2A\u7ACB\u65B9\u4F53\u9876\u70B9\u65CB\u8F6C\u6295\u5F71\uFF08\u79D1\u5E7B\u611F\u51E0\u4F55\u4F53\uFF09",
      props: []
    },
    heart: {
      desc: "\u5FC3\u5F62\u7C92\u5B50\uFF1A\u7C92\u5B50\u7EC4\u6210\u7684\u5FC3\u5F62\uFF0C\u5468\u671F\u6027\u53CC\u8DF3\u8109\u51B2",
      props: [P2("period", "number", 1.15, "\u53CC\u8DF3\u5468\u671F\uFF08\u79D2\uFF09"), P2("points", "number", 220, "\u7C92\u5B50\u6570\uFF08\u2265150 \u4FDD\u8BC1\u53EF\u8FA8\u8BC6\uFF09")]
    },
    pcb: {
      desc: "\u7535\u8DEF\u677F\uFF1A\u66FC\u54C8\u987F\u8D70\u7EBF + \u6CBF\u8D70\u7EBF\u6D41\u52A8\u7684\u8109\u51B2\u5149\u70B9",
      props: [P2("traces", "number", 10, "\u8D70\u7EBF\u6570\u91CF")]
    },
    grid: {
      desc: "\u900F\u89C6\u5730\u9762\uFF1A\u6A2A\u7EB5\u7EBF\u5411\u5730\u5E73\u7EBF\u6EDA\u52A8\uFF08\u590D\u53E4\u7F51\u683C\u5730\u5E73\u7EBF\uFF09",
      props: [P2("speed", "number", 0.55, "\u6EDA\u52A8\u901F\u5EA6"), P2("horizon", "number", 0.42, "\u5730\u5E73\u7EBF\u4F4D\u7F6E\uFF080-1\uFF0C\u76F8\u5BF9\u9AD8\u5EA6\uFF09")]
    },
    membank: {
      desc: "\u5185\u5B58\u5B57\u8282\u77E9\u9635\uFF1A\u5B57\u7B26\u7F51\u683C\u6309\u786E\u5B9A\u6027\u8282\u594F\u95EA\u53D8\uFF08\u50CF\u5185\u5B58\u76D1\u89C6\u5668\uFF09",
      props: [P2("cols", "number", 12, "\u5217\u6570"), P2("rows", "number", 6, "\u884C\u6570"), P2("rate", "number", 3.2, "\u95EA\u53D8\u901F\u7387")]
    },
    disk: {
      desc: "\u78C1\u76D8\u76D8\u9762\uFF1A\u6247\u533A\u73AF + \u78C1\u81C2\u5468\u671F\u626B\u63CF\uFF08\u50CF\u78C1\u76D8\u6D3B\u52A8\u6307\u793A\uFF09",
      props: []
    },
    life: {
      desc: "\u751F\u547D\u6E38\u620F\uFF1A\u5EB7\u5A01\u89C4\u5219\u786E\u5B9A\u6027\u6F14\u5316\uFF08\u7EC6\u80DE\u81EA\u52A8\u673A\u56FE\u6848\u6D41\u52A8\uFF09",
      props: [P2("cols", "number", 48, "\u5217\u6570"), P2("rows", "number", 27, "\u884C\u6570"), P2("period", "number", 0.16, "\u6F14\u5316\u6B65\u95F4\u9694\uFF08\u79D2\uFF09")]
    },
    // ---- draw2 族（8）
    classGraph: {
      desc: "\u7C7B\u56FE\uFF1A\u8282\u70B9\u8FDE\u7EBF + \u6570\u636E\u70B9\u6CBF\u8FB9\u79FB\u52A8",
      props: [P2("nodes", "number", 5, "\u8282\u70B9\u6570\u91CF")]
    },
    symbols: {
      desc: "\u7B26\u53F7\u7011\u5E03\uFF1A\u6570\u5B57/\u7B26\u53F7\u77E9\u9635\u4E0B\u843D\uFF08\u6570\u5B57\u96E8\u98CE\u683C\uFF09",
      props: [P2("rate", "number", 8, "\u4E0B\u843D\u901F\u7387"), P2("size", "number", 15, "\u5B57\u53F7\uFF08\u8BBE\u8BA1\u50CF\u7D20\uFF09")]
    },
    pipeline: {
      desc: "\u6784\u5EFA\u6D41\u6C34\u7EBF\uFF1A\u9636\u6BB5\u8282\u70B9\u9010\u4E2A\u70B9\u4EAE + \u8FDE\u63A5\u7EBF\u63A8\u8FDB",
      props: [P2("stages", "number", 5, "\u9636\u6BB5\u6570\u91CF"), P2("period", "number", 3.2, "\u63A8\u8FDB\u5468\u671F\uFF08\u79D2\uFF09")]
    },
    stars: {
      desc: "\u661F\u7A7A\uFF1A\u661F\u70B9\u95EA\u70C1 + \u5341\u5B57\u661F\u8292\uFF08\u6DF1\u7A7A\u80CC\u666F\uFF09",
      props: [P2("count", "number", 130, "\u661F\u70B9\u6570\u91CF"), P2("period", "number", 2.6, "\u95EA\u70C1\u5468\u671F\uFF08\u79D2\uFF09")]
    },
    constellations: {
      desc: "\u661F\u5EA7\uFF1A\u661F\u70B9\u8FD1\u90BB\u8FDE\u7EBF\u7F13\u6162\u6F02\u79FB\uFF08\u661F\u5EA7\u56FE\u98CE\u683C\uFF09",
      props: [P2("stars", "number", 18, "\u661F\u70B9\u6570\u91CF")]
    },
    ash: {
      desc: "\u7070\u70EC\uFF1A\u9897\u7C92\u7F13\u6162\u4E0A\u5347 + \u660E\u6697\u95EA\u70C1\uFF08\u4F59\u70EC\u6C14\u6C1B\uFF09",
      props: [P2("count", "number", 60, "\u9897\u7C92\u6570\u91CF")]
    },
    telemetry: {
      desc: "\u9065\u6D4B\u8868\uFF1A\u591A\u884C\u8BFB\u6570 + \u8FF7\u4F60\u66F2\u7EBF\u6EDA\u52A8\uFF08\u76D1\u63A7\u53F0\u98CE\u683C\uFF09",
      props: [P2("rows", "number", 5, "\u8BFB\u6570\u884C\u6570")]
    },
    points: {
      desc: "\u70B9\u4E91\u5F62\u6001\uFF1A\u7C92\u5B50\u7FA4\u5728\u5706/\u65B9/\u4E09\u89D2/\u5341\u5B57\u5F62\u6001\u95F4\u5468\u671F\u53D8\u6362",
      props: [P2("count", "number", 180, "\u70B9\u6570"), P2("period", "number", 5.2, "\u5F62\u6001\u53D8\u6362\u5468\u671F\uFF08\u79D2\uFF09")]
    }
  };

  // packages/widgets/src/index.ts
  function registerAll() {
  }
  var WIDGET_NAMES = listWidgets();

  // packages/render/host/entry.ts
  registerAll();
  var canvas = document.getElementById("kine");
  if (!canvas) throw new Error('\u5BBF\u4E3B\u9875\u7F3A\u5C11 <canvas id="kine">');
  var rt = createRuntime(canvas);
  var api = {
    load(ir) {
      rt.load(ir);
    },
    jump(T) {
      rt.jump(T);
    },
    probe(T) {
      return rt.probe(T);
    },
    stateHash(T) {
      return rt.stateHash(T);
    },
    setSeed(seed) {
      rt.setSeed(seed);
    },
    /** 运行时扫描：0.25s 步进全轴抓错（audit 第三层，规格文档05 §5.10） */
    scan(t0, t1, step) {
      const errs = [];
      for (let t = t0; t <= t1 + 1e-9; t += step) {
        try {
          rt.jump(t);
        } catch (e) {
          errs.push({
            t,
            message: e instanceof Error ? e.message : String(e),
            stack: e instanceof Error ? String(e.stack ?? "").slice(0, 800) : ""
          });
        }
      }
      return errs;
    },
    probeMany(ts) {
      return ts.map((T) => rt.probe(T));
    },
    hashMany(ts) {
      return ts.map((T) => ({ T, hash: rt.stateHash(T) }));
    },
    listWidgets() {
      return rt.listWidgets();
    }
  };
  window.__kine = api;
  window.__kineReady = true;
})();

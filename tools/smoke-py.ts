// 调试：kine-py sidecar 全链路冒烟（ping/env/beats/synth/mix/stats/metrics）
import fs from 'node:fs';
import path from 'node:path';
import { getKinePy, shutdownKinePy } from '@kine/store';

const OUT = path.resolve('.smoke');
fs.mkdirSync(OUT, { recursive: true });

function writeWavMono16(file: string, samples: number[], sr: number): void {
  const n = samples.length;
  const dataBytes = n * 2;
  const buf = Buffer.alloc(44 + dataBytes);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataBytes, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sr, 24);
  buf.writeUInt32LE(sr * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataBytes, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  fs.writeFileSync(file, buf);
}

// 生成 5s 节拍轨道：每 0.5s 一次 880Hz 短击
const SR = 48000;
const music: number[] = new Array(5 * SR).fill(0);
for (let k = 0; k < 10; k++) {
  const t0 = k * 0.5;
  const i0 = Math.round(t0 * SR);
  for (let i = 0; i < SR * 0.06 && i0 + i < music.length; i++) {
    const t = i / SR;
    music[i0 + i] += Math.sin(2 * Math.PI * 880 * t) * Math.exp(-t / 0.02) * 0.7;
  }
}
const musicFile = path.join(OUT, 'click_music.wav');
writeWavMono16(musicFile, music, SR);
console.log('music written', musicFile);

const py = await getKinePy();
console.log('py info', JSON.stringify(py.info));

const env = await py.call<{ max: number; mean: number; values: number[] }>('env', { music: musicFile, fps: 60, nframes: 300 });
console.log('env', { max: env.max, mean: env.mean, v60: env.values[60] });

const beats = await py.call<{ count: number; beats: { t: number }[] }>('beats', { wav: musicFile, fps: 60 });
console.log('beats', beats.count, beats.beats.slice(0, 4).map((b) => b.t));

const sfxTrack = await py.call<{ file: string }>('sfx_track', {
  events: [
    { id: 'e1', sfx: 'heartbreak', at: 1.0, gain: 0.9, bus: 'hits', params: {} },
    { id: 'e2', sfx: 'heartbreak', at: 3.0, gain: 0.9, bus: 'hits', params: {} },
    { id: 'e3', sfx: 'rain', at: 0.0, gain: 0.5, bus: 'bed', params: { dur: 5, drops_per_sec: 20 } },
    { id: 'e4', sfx: 'glitch', at: 2.2, gain: 0.8, bus: 'hits', params: {} },
  ],
  sr: SR,
  duration: 5,
  seed: 7,
  busGains: { bed: 1.0, hits: 1.0 },
  out: path.join(OUT, 'sfx_track.wav'),
});
console.log('sfx_track', sfxTrack);

const mix = await py.call<Record<string, unknown>>('mix', {
  music: musicFile,
  duration: 5,
  out: path.join(OUT, 'mix.wav'),
  sfxPath: sfxTrack.file,
  gain: 1.0,
  fadeOut: { at: 4.2, dur: 0.6 },
  cutFrom: 5.0,
  limitDbfs: -1.0,
});
console.log('mix', mix);

const stats = await py.call<{ peakDbfs: number; t99_9: number; tailPeakDbfs: number; rmsCurve: unknown[] }>('audio_stats', { wav: path.join(OUT, 'mix.wav') });
console.log('audio_stats', { peak: stats.peakDbfs, t99_9: stats.t99_9, tail: stats.tailPeakDbfs, curvePoints: stats.rmsCurve.length });

const wl = await py.call<{ levels: unknown[] }>('window_levels', { wav: path.join(OUT, 'mix.wav'), windows: [[0, 2], [2, 4.5]] });
console.log('window_levels', JSON.stringify(wl.levels));

// 像素指标：用已有调试帧
const shots = path.resolve('examples/mv-mini/.kine/debug-shots');
const f360 = path.join(shots, 'shot_000360.png');
const f1200 = path.join(shots, 'shot_001200.png');
if (fs.existsSync(f360)) {
  const d = await py.call('density', { png: f360 });
  console.log('density(360)', JSON.stringify(d));
  const bl = await py.call('black_level', { png: f360 });
  console.log('black_level(360)', JSON.stringify(bl));
  const eb = await py.call('edge_band', { png: f360 });
  console.log('edge_band(360)', JSON.stringify(eb));
  if (fs.existsSync(f1200)) {
    const fd = await py.call('frame_diff', { a: f360, b: f1200 });
    console.log('frame_diff(360,1200)', JSON.stringify(fd));
  }
}

const gridOut = path.join(OUT, 'grid_overlay.png');
const go = await py.call('grid_overlay', { png: f360, out: gridOut, highlights: [{ row: 2, col: 2 }] });
console.log('grid_overlay', go);

console.log('SMOKE-PY OK');
shutdownKinePy();

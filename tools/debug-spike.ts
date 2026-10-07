// 调试：定位 transition_spike 命中的具体窗口与帧位
import path from 'node:path';
import fs from 'node:fs';
import { loadAndCompile } from '@kine/dsl';
import { capturePngs } from '@kine/render';
import { denseWindows, pyTransitionSpike } from '@kine/metrics';
import { shutdownKinePy } from '@kine/store';

const yaml = process.argv[2] ?? 'examples/mv-mini/timeline.yaml';
const projectDir = path.dirname(path.resolve(yaml));
const shotsDir = path.join(projectDir, '.kine', 'debug-shots');
const { ir } = loadAndCompile(yaml, { strict: false });

const windows = denseWindows(ir, null);
console.log('窗口数', windows.length);
const fps = ir.time.map.fps;
for (const w of windows) {
  const missing: number[] = [];
  const files = new Map<number, string>();
  for (const f of w) {
    const p = path.join(shotsDir, `shot_${String(f).padStart(6, '0')}.png`);
    if (fs.existsSync(p)) files.set(f, p);
    else missing.push(f);
  }
  if (missing.length) {
    const shots = await capturePngs(ir, missing, {
      projectDir,
      workDir: path.join(projectDir, '.kine', 'work', ir.specHash.slice(0, 8)),
      width: ir.output.width, height: ir.output.height, fps: ir.output.fps,
      profile: { codec: 'libx264', crf: 15, preset: 'slow', pixFmt: 'yuv420p', fps: ir.output.fps } as never,
      outDir: shotsDir,
    });
    for (const s of shots) files.set(s.frame, s.file);
  }
  const paths = w.map((f) => files.get(f)!);
  const r = await pyTransitionSpike(paths);
  const rel = w[Math.round(w.length / 2)] / fps;
  const hits = r.hits.map((h) => ({
    pair: `${w[h.from]}→${w[h.to]}`,
    t: (w[h.to] / fps).toFixed(3),
    diff: (h.ratio * 100).toFixed(2) + '%',
    neigh: (h.neighborhoodMean * 100).toFixed(2) + '%',
  }));
  console.log(`window @T≈${rel.toFixed(2)}s frames[${w[0]}..${w[w.length - 1]}] hits=${r.value}`,
    hits.length ? JSON.stringify(hits) : '', 'diffs%', r.diffs.map((d) => (d * 100).toFixed(1)).join(','));
}
shutdownKinePy();

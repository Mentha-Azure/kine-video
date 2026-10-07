// 调试：逐对帧比较单一指标值（frame_diff），用于判断哪些幕的 0.4s 帧对达标
import path from 'node:path';
import { loadAndCompile } from '@kine/dsl';
import { capturePngs } from '@kine/render';
import { pyFrameDiff } from '@kine/metrics';
import { shutdownKinePy } from '@kine/store';

const yaml = process.argv[2] ?? 'examples/mv-mini/timeline.yaml';
const projectDir = path.dirname(path.resolve(yaml));
const { ir } = loadAndCompile(yaml, { strict: false });
const shotsDir = path.join(projectDir, '.kine', 'debug-shots', ir.specHash.slice(0, 8));

const pairs: [number, number][] = [];
for (const sc of ir.time.map.scenes) {
  const f0 = Math.round(sc.frame0 + 0.62 * (sc.frame1 - sc.frame0));
  pairs.push([f0, f0 + 24]);
}
// 也可通过 argv 指定：-- 185 209 485 509 ...
const extra = process.argv.slice(3).map(Number).filter((n) => !Number.isNaN(n));
if (extra.length >= 2) {
  pairs.length = 0;
  for (let i = 0; i + 1 < extra.length; i += 2) pairs.push([extra[i], extra[i + 1]]);
}

const need = [...new Set(pairs.flat())];
const shots = await capturePngs(ir, need, {
  projectDir, workDir: path.join(projectDir, '.kine', 'work', ir.specHash.slice(0, 8)),
  width: ir.output.width, height: ir.output.height, fps: ir.output.fps,
  profile: { codec: ir.output.video.codec, crf: ir.output.video.crf, preset: ir.output.video.preset, pixFmt: 'yuv420p', fps: ir.output.fps } as never,
  outDir: shotsDir,
});
const fileOf = new Map(shots.map((s) => [s.frame, s.file]));
for (const [a, b] of pairs) {
  const r = await pyFrameDiff(fileOf.get(a)!, fileOf.get(b)!);
  console.log(`pair ${a}↔${b} ($t=${(a / ir.output.fps).toFixed(2)}s) diff=${(r.value * 100).toFixed(2)}%`);
}
shutdownKinePy();

// smoke-audio: 构建 mv-mini 混音轨（sfx + music），打印关键统计
import fs from 'node:fs';
import path from 'node:path';
import { loadAndCompile } from '@kine/dsl';
import { buildAudio, buildEnv } from '@kine/audio';
import { getKinePy, shutdownKinePy } from '@kine/store';

const yamlFile = process.argv[2] ?? 'examples/mv-mini/timeline.yaml';
const abs = path.resolve(yamlFile);
const projectDir = path.dirname(abs);
const cacheDir = path.join(projectDir, '.kine', 'cache');
const locksDir = path.join(projectDir, '.kine', 'locks');
fs.mkdirSync(locksDir, { recursive: true });

const { ir, issues } = loadAndCompile(abs, { projectDir });
const errs = issues.filter((i) => i.severity === 'error');
if (errs.length) {
  console.error('compile errors:', errs.map((e) => `${e.code} ${e.message}`).join('\n'));
  process.exit(1);
}
console.log('specHash', ir.specHash.slice(0, 8), '| music:', ir.audioPlan.music?.file ?? '(none)', 'exists:', ir.audioPlan.music?.exists ?? false);

const art = await buildAudio(ir, {
  cacheDir, locksDir,
  force: process.env.KINE_NOCACHE === '1',
  onProgress: (ev) => console.log('  ..', ev.phase, ev.detail ?? ''),
});
console.log('mix:', art.mixFile);
console.log('cached:', art.cached, '| events:', art.events, '| limited:', art.limited, '| ms:', art.ms);
if (art.stats) {
  console.log('stats:', {
    peakDbfs: art.stats.peakDbfs,
    t99_9: art.stats.t99_9,
    tailPeakDbfs: art.stats.tailPeakDbfs,
    duration: art.stats.duration,
  });
}

const env = await buildEnv(ir, { cacheDir, locksDir });
console.log('env:', env.missingMusic ? '(no music — skipped)' : `${env.file} max=${env.max} mean=${env.mean.toFixed(2)}`);

const py = await getKinePy();
const beats = (await py.call('beats', { wav: art.mixFile, fps: ir.output.fps })) as { count: number; beats: { t: number; strength: number }[] };
console.log('beats detected:', beats.count, 'first:', beats.beats.slice(0, 6).map((b) => `${b.t}s`).join(', '));

shutdownKinePy();

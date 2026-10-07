// tools/dump-impact.ts — 打印关键 target 的 impact 报告（供测试断言取材）
import * as path from 'node:path';
import { loadAndCompile, parseTargetPath, computeImpact } from '@kine/dsl';

const file = process.argv[2] ?? 'examples/mv-mini/timeline.yaml';
const projDir = path.dirname(path.resolve(file));
const { ir } = loadAndCompile(file, { projectDir: projDir });
const framesPerScene: Record<string, number> = {};
for (const s of ir.scenes) framesPerScene[s.id] = s.frame1 - s.frame0;
const targets = process.argv.slice(3).length
  ? process.argv.slice(3)
  : ['pace', 'audio.music.file', 'scenes[title].layers[title_main]', 'output.duration', 'theme.post'];
for (const t of targets) {
  const parsed = parseTargetPath(t);
  const imp = computeImpact({
    targets: [parsed],
    sceneIds: ir.scenes.map((s) => s.id),
    framesPerScene,
    totalFrames: ir.time.map.frames,
    nScenes: ir.scenes.length,
  });
  console.log('##', t, JSON.stringify(parsed));
  console.log('invalidates:', imp.invalidates.join(' | '));
  console.log('reruns:', imp.reruns.join(' | '));
  console.log('keeps:', imp.keeps.join(' | '));
  console.log('warnings:', imp.warnings.join(' | '));
  console.log('approx:', JSON.stringify(imp.approx));
  console.log('');
}

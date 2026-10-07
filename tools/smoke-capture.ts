// 调试：直抓若干帧 PNG（独立 capture 路径）
import { loadAndCompile } from '@kine/dsl';
import { capturePngs, renderDefaults } from '@kine/render';

const file = process.argv[2] ?? 'examples/mv-mini/timeline.yaml';
const frames = (process.argv[3] ?? '360').split(',').map(Number);
const outDir = process.argv[4] ?? 'examples/mv-mini/.kine/debug-shots';
const projectDir = file.replace(/[\\/][^\\/]+$/, '');
const r = loadAndCompile(file, { projectDir });
const o = renderDefaults(r.ir, projectDir);
const files = await capturePngs(r.ir, frames, { ...o, outDir });
console.log(files.join('\n'));

// 冒烟脚本：渲染一小段并报告产物（验证 Edge CDP 抓帧 → ffmpeg 编码链路）
import { loadAndCompile } from '@kine/dsl';
import { mediaInfo, renderDefaults, renderRange } from '@kine/render';

const file = process.argv[2] ?? 'examples/mv-mini/timeline.yaml';
const f0 = Number(process.argv[3] ?? 0);
const f1 = Number(process.argv[4] ?? 30);
const projectDir = file.replace(/[\\/][^\\/]+$/, '');
const r = loadAndCompile(file, { projectDir });
if (r.issues.some((i) => i.severity === 'error')) {
  console.error('编译失败', r.issues);
  process.exit(1);
}
const o = renderDefaults(r.ir, projectDir);
console.log('workDir', o.workDir, 'profile', o.profile);
const t0 = Date.now();
const art = await renderRange(r.ir, { f0, f1 }, { ...o, noCache: process.env.KINE_NOCACHE === '1' });
console.log('artifact', art);
console.log('elapsed ms', Date.now() - t0, 'per-frame', ((Date.now() - t0) / (f1 - f0)).toFixed(1));
console.log('media', JSON.stringify(mediaInfo(art.file), null, 1).slice(0, 600));

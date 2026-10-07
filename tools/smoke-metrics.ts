// 调试：metrics 包冒烟（视觉指标 + cam_jitter 解析复算；音频指标待 mix 产物）
import path from 'node:path';
import { loadAndCompile } from '@kine/dsl';
import { capturePngs } from '@kine/render';
import { runMetric, runAsserts, type FrameProvider } from '@kine/metrics';
import { shutdownKinePy } from '@kine/store';

const yaml = process.argv[2] ?? 'examples/mv-mini/timeline.yaml';
const projectDir = path.dirname(path.resolve(yaml));

const { ir, issues } = loadAndCompile(yaml, { strict: false });
if (issues.some((i) => i.severity === 'error')) {
  console.error('编译错误', issues);
  process.exit(1);
}
// 按 specHash 归档调试帧，避免旧版本帧被复用（内容变了但文件名相同）
const shotsDir = path.join(projectDir, '.kine', 'debug-shots', ir.specHash.slice(0, 8));
console.log('specHash', ir.specHash.slice(0, 8), 'frames', ir.time.map.frames);

const provider: FrameProvider = {
  async ensure(frames: number[]) {
    const map = new Map<number, string>();
    // 先查已有 debug-shots
    const fsmod = await import('node:fs');
    const missing: number[] = [];
    for (const f of frames) {
      const p = path.join(shotsDir, `shot_${String(f).padStart(6, '0')}.png`);
      if (fsmod.existsSync(p)) map.set(f, p);
      else missing.push(f);
    }
    if (missing.length > 0) {
      console.log(`  抓帧 ${missing.length}：${missing.join(', ')}`);
      const t0 = Date.now();
      const shots = await capturePngs(ir, missing, {
        projectDir, workDir: path.join(projectDir, '.kine', 'work', ir.specHash.slice(0, 8)),
        width: ir.output.width, height: ir.output.height, fps: ir.output.fps,
        profile: { codec: ir.output.video.codec, crf: ir.output.video.crf, preset: ir.output.video.preset, pixFmt: 'yuv420p', fps: ir.output.fps } as never,
        outDir: shotsDir,
      });
      console.log(`  抓帧完成 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      for (const s of shots) map.set(s.frame, s.file);
    }
    return map;
  },
};

for (const name of ['density', 'frame_diff', 'static_ratio', 'edge_band', 'black_level', 'cam_jitter']) {
  const r = await runMetric(name, null, { ir, frames: provider });
  console.log(`\n== ${name}: value=${r.value} unit=${r.unit}`);
  console.log(`   facts: ${r.facts.join(' | ')}`);
  console.log(`   interp: ${r.interpretation}`);
}

console.log('\n== runAsserts（视觉类；音频类应 SKIP）');
const rep = await runAsserts(ir, { ir, frames: provider });
console.log(rep.markdown);

shutdownKinePy();

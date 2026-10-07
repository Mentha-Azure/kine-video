// 冒烟脚本：编译示例工程并打印时间映射与关键 IR 摘要
import { loadAndCompile } from '@kine/dsl';

const file = process.argv[2] ?? 'examples/mv-mini/timeline.yaml';
const r = loadAndCompile(file, { projectDir: file.replace(/[\\/][^\\/]+$/, '') });
console.log('--- issues ---');
for (const i of r.issues) console.log(`${i.severity.toUpperCase()} ${i.code} ${i.message}`);
console.log('--- map ---');
const m = r.ir.time.map;
console.log('frames', m.frames, 'durationT', m.durationT.toFixed(4), 'duration', m.duration);
console.log('segments', JSON.stringify(m.segments.map((s) => ({ id: s.id, t: [s.t0, s.t1], T: [s.T0, s.T1], frames: [s.frame0, s.frame1] }))));
console.log('scenes', JSON.stringify(m.scenes.map((s) => ({ id: s.id, T: [s.T0, s.T1], t: [s.t0.toFixed(3), s.t1.toFixed(3)], f: [s.frame0, s.frame1] }))));
console.log('breaks', JSON.stringify(m.breaks));
console.log('--- shots ---');
for (const sc of r.ir.scenes) {
  console.log(sc.id, 'shots', sc.shots.map((s) => `${s.lt0.toFixed(2)}-${s.lt1.toFixed(2)}${s.transition ? `(${s.transition.name})` : ''}`).join(' '), 'accelFactor', sc.accelFactor?.toFixed(3));
}
console.log('--- audio ---');
console.log(JSON.stringify(r.ir.audioPlan.sfxEvents.map((e) => ({ id: e.id, sfx: e.sfx, at: +e.at.toFixed(3), clock: e.declaredClock })), null, 0));
console.log('specHash', r.ir.specHash);
console.log('deps nodes', r.ir.deps.nodes.length, 'edges', r.ir.deps.edges.length);

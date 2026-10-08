// 临时调试：打印 accel-cut 的设计内边界与判定（供修 tests/metrics-spike.test.ts）
import * as path from 'node:path';
import { loadAndCompile } from '@kine/dsl';
import { classifyDesign, designedSpans } from '@kine/metrics';

const res = loadAndCompile(path.join(process.cwd(), 'fixtures', 'accel-cut', 'timeline.yaml'));
const sp = designedSpans(res.ir);
console.log('spans =', JSON.stringify(sp));
for (const f of [60, 67, 141, 180]) {
  console.log(`f${f} ->`, classifyDesign(res.ir, f, f + 6));
}
const sc = res.ir.scenes[0]!;
console.log(
  'accelFactor =',
  sc.accelFactor,
  'shots =',
  JSON.stringify(
    sc.shots.map((s) => ({
      i: s.index,
      lt0: s.lt0,
      lt1: s.lt1,
      t0: s.t0,
      t1: s.t1,
      tr: s.transition ? { name: s.transition.name, dur: s.transition.dur } : null,
    })),
  ),
);

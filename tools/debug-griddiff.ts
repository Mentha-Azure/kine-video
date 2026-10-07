// 调试：两帧 diff 的网格热点定位
import path from 'node:path';
import { pyFrameDiff } from '@kine/metrics';
import { shutdownKinePy } from '@kine/store';

const base = path.resolve(process.argv[2] ?? 'examples/mv-mini/.kine/debug-shots');
const [a, b] = (process.argv[3] ?? '711,717').split(',').map(Number);
const f = (n: number) => `${base}/shot_${String(n).padStart(6, '0')}.png`;
const r = await pyFrameDiff(f(a), f(b));
console.log('value', (r.value * 100).toFixed(2) + '%');
const g = r.grid as number[];
for (let row = 0; row < 5; row++) {
  console.log(g.slice(row * 5, row * 5 + 5).map((x) => (x * 100).toFixed(1).padStart(6)).join(' '));
}
shutdownKinePy();

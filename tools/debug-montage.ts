// 调试：拼图查看甩镜转场帧序列
import path from 'node:path';
import { pyMontage } from '@kine/metrics';
import { shutdownKinePy } from '@kine/store';

const base = path.resolve(process.argv[2] ?? 'examples/mv-mini/.kine/debug-shots');
const frames = (process.argv[3] ?? '693,699,705,711,717,723').split(',').map(Number);
const out = path.resolve(process.argv[4] ?? `${base}/montage_whip.png`);
const files = frames.map((f) => `${base}/shot_${String(f).padStart(6, '0')}.png`);
const r = await pyMontage(files, out, { cols: 3, cell: 480, labels: frames.map(String) });
console.log(JSON.stringify(r));
shutdownKinePy();

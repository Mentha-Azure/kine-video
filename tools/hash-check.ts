// tools/hash-check.ts — 打印 specHash / visualHash（验证音频改动不失效帧缓存）
import { loadAndCompile } from '@kine/dsl';

const file = process.argv[2] ?? 'examples/mv-mini/timeline.yaml';
const r = loadAndCompile(file, {});
const ir = r.ir;
console.log(
  JSON.stringify(
    {
      specHash: ir.specHash,
      specHash8: ir.specHash.slice(0, 8),
      visualHash: ir.hashes.visualHash,
      visualHash8: ir.hashes.visualHash.slice(0, 8),
      workDirExample: `.kine/work/${ir.hashes.visualHash.slice(0, 8)}`,
      errors: r.issues.filter((i) => i.severity === 'error').length,
    },
    null,
    2,
  ),
);

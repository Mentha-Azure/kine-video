/**
 * Kine 工具：编译全部 fixtures，打印各工程错误/警告摘要。
 * 用法（在 kine/ 下）：npx tsx tools/check-fixtures.ts
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { loadAndCompile, type Issue } from '@kine/dsl';

const fixturesDir = path.resolve(process.argv[2] ?? 'fixtures');
const dirs = readdirSync(fixturesDir)
  .filter((d) => statSync(path.join(fixturesDir, d)).isDirectory())
  .sort();

let checked = 0;
for (const d of dirs) {
  const file = path.join(fixturesDir, d, 'timeline.yaml');
  if (!existsSync(file)) continue;
  checked++;
  try {
    const res = loadAndCompile(file, {});
    const all: Issue[] = [...res.issues, ...res.lintIssues];
    const errs = all.filter((i) => i.severity === 'error');
    const warns = all.filter((i) => i.severity === 'warn');
    console.log(
      `${d}:  errors=${errs.length} [${errs.map((e) => e.code).join(',')}]  warns=${warns.length} [${warns.map((w) => w.code).join(',')}]`,
    );
  } catch (e) {
    const err = e as { issues?: Issue[]; message?: string };
    const codes = (err.issues ?? []).filter((i) => i.severity === 'error').map((i) => i.code);
    console.log(`${d}:  THREW [${codes.join(',')}] ${err.message ?? ''}`);
  }
}
console.log(`—— 共检查 ${checked} 个 fixtures`);

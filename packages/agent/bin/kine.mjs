#!/usr/bin/env node
// kine CLI launcher — 使用 tsx 运行 TypeScript CLI。
// 关键点：以仓库根为 cwd 启动子进程，保证 `--import tsx` 可在 node_modules 中解析；
// 用户原始工作目录通过 KINE_CWD 传给 CLI（未显式 --dir 时的默认工程搜索起点）。
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..'); // packages/agent/bin -> repo root
const cliPath = resolve(repoRoot, 'packages', 'agent', 'src', 'cli.ts');
const userCwd = process.cwd();

const child = spawn(process.execPath, ['--import', 'tsx', cliPath, ...process.argv.slice(2)], {
  cwd: repoRoot,
  stdio: 'inherit',
  env: { ...process.env, KINE_CWD: userCwd },
});

child.on('error', (e) => {
  console.error(`kine launcher error: ${e.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});

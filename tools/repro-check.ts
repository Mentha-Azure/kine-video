// tools/repro-check.ts — 字节级复现校验（规格文档04 §4.7；CI 必跑项）
// 用法：npx tsx tools/repro-check.ts [timeline.yaml] [f0:f1]（默认 examples/mv-mini 0:120）
import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { copyFileSync, readFileSync, statSync, unlinkSync } from 'node:fs';
import { loadAndCompile } from '@kine/dsl';
import { renderDefaults, renderRange } from '@kine/render';
import { openProject } from '@kine/store';

const arg0 = process.argv[2] ?? 'examples/mv-mini/timeline.yaml';
// 支持传目录（自动补 timeline.yaml）
const yaml = statSync(arg0).isDirectory() ? path.join(arg0, 'timeline.yaml') : arg0;
const [f0, f1] = (process.argv[3] ?? '0:120').split(':').map(Number);

const store = openProject(yaml);
const { ir } = loadAndCompile(yaml, { projectDir: store.root });
const defaults = renderDefaults(ir, store.root);

console.log(`[repro] 工程 ${store.root}`);
console.log(`[repro] 帧范围 [${f0},${f1}) visualHash=${ir.hashes.visualHash.slice(0, 8)}`);

const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

console.log('[repro] runA …');
const a = await renderRange(ir, { f0, f1 }, { ...defaults, noCache: true, keepFrames: false });
const tmpA = a.file + '.reproA';
copyFileSync(a.file, tmpA);
console.log(`[repro] runA 完成 ${a.frames} 帧 ${a.ms}ms → ${sha(tmpA).slice(0, 16)}…`);

console.log('[repro] runB …');
const b = await renderRange(ir, { f0, f1 }, { ...defaults, noCache: true, keepFrames: false });
console.log(`[repro] runB 完成 ${b.frames} 帧 ${b.ms}ms → ${sha(b.file).slice(0, 16)}…`);

const identical = sha(tmpA) === sha(b.file);
unlinkSync(tmpA);
console.log(
  identical
    ? `[repro] REPRO OK — 同工程两次渲染产物逐字节一致（${f1 - f0} 帧）`
    : '[repro] REPRO FAIL — 两次渲染产物不一致（确定性被破坏，禁止发版）',
);
process.exit(identical ? 0 : 1);

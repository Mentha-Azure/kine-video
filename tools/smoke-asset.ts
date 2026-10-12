// smoke-asset —— v5 图片资产管线端到端：collectImageAssets → 宿主页注入 → probe 状态
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAndCompile } from '@kine/dsl';
import { collectImageAssets, openRenderSession, renderDefaults } from '@kine/render';

const candidates = [
  'examples/mv-mini/.kine/out/v0.9/shots/key_000186.png',
  'examples/mv-mini/.kine/debug-shots/shot_000360.png',
];
const srcPng = candidates.find((p) => existsSync(p));
if (!srcPng) {
  console.error('SKIP: 找不到可用 PNG 源（先跑 verify 生成 shots）');
  process.exit(2);
}

const root = mkdtempSync(join(tmpdir(), 'kine-asset-'));
const yaml = [
  'schema: kine/1',
  'project: { id: img, title: IMG, version: v0.1, seed: 7 }',
  'output: { width: 640, height: 360, fps: 30, duration: 1 }',
  'pace: { segments: [{ id: full, until: 1, ratio: 1.0 }] }',
  'theme: { bg: [\'#060609\', \'#0a0a12\'], font: { family: "Consolas, monospace", scale: 1, base: 24 } }',
  'render: { surface: canvas, workers: 1 }',
  'scenes:',
  '  - id: s1',
  '    dur: 1',
  '    camera: { z1: 1.0 }',
  '    layers:',
  '      - kind: image',
  '        id: img1',
  '        src: assets/pic.png',
  '        place: { x: 320, y: 180, w: 320, h: 180, anchor: center }',
  '      - kind: image',
  '        id: img2',
  '        src: assets/none.png',
  '        place: { x: 96, y: 96, w: 160, h: 90 }',
  'asserts: []',
  '',
].join('\n');
writeFileSync(join(root, 'timeline.yaml'), yaml, 'utf8');
mkdirSync(join(root, 'assets'), { recursive: true });
copyFileSync(srcPng, join(root, 'assets', 'pic.png'));

const c = loadAndCompile(join(root, 'timeline.yaml'), {});
console.log('lint codes:', c.lintIssues.map((i) => i.code).join(', ') || '(clean)');
console.log('asset errors expected: E-ASSET-001 for none.png →', c.lintIssues.some((i) => i.code === 'E-ASSET-001'));

const assets = await collectImageAssets(c.ir, root);
console.log('assets collected:', assets.length, '| first:', assets[0]?.src, '|', assets[0]?.dataUrl.slice(0, 34), '…');
if (assets.length !== 1) {
  console.error('FAIL: 期望仅收集 1 个可解析资产（pic.png）');
  process.exit(1);
}

const d = renderDefaults(c.ir, root);
const s = await openRenderSession(c.ir, { ...d, tag: 'asset-smoke' });
try {
  const pr = (await s.probe(0.5)) as { elements: Array<{ id: string; state?: string }> };
  const st = new Map(pr.elements.map((e) => [e.id, e.state]));
  console.log('probe states:', [...st.entries()].map(([k, v]) => `${k}=${v}`).join(', '));
  const ok1 = st.get('img1') === 'ok';
  const miss2 = st.get('img2') === 'missing-asset';
  if (!ok1 || !miss2) {
    console.error('FAIL: 期望 img1=ok 且 img2=missing-asset');
    process.exit(1);
  }
  console.log('SMOKE-ASSET OK（图片资产已注入渲染；缺失资产在 probe 中可见）');
} finally {
  await s.close();
}

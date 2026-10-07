// 构建宿主页 bundle：packages/render/host/entry.ts → packages/render/assets/kine-host.js（IIFE）
import * as esbuild from 'esbuild';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const entry = path.join(root, 'packages', 'render', 'host', 'entry.ts');
const outfile = path.join(root, 'packages', 'render', 'assets', 'kine-host.js');

const result = await esbuild.build({
  entryPoints: [entry],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  outfile,
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  metafile: false,
});

if (result.errors.length > 0) {
  console.error(result.errors);
  process.exit(1);
}
console.log(`built: ${outfile}`);

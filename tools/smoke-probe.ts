// 调试：probe 某时刻全部元素（盒/状态/alpha）
import { loadAndCompile } from '@kine/dsl';
import { openRenderSession, renderDefaults } from '@kine/render';

const file = process.argv[2] ?? 'examples/mv-mini/timeline.yaml';
const t = Number(process.argv[3] ?? 6.0);
const projectDir = file.replace(/[\\/][^\\/]+$/, '');
const r = loadAndCompile(file, { projectDir });
const o = renderDefaults(r.ir, projectDir);
const sess = await openRenderSession(r.ir, o);
try {
  const p = await sess.probe(t);
  console.log(JSON.stringify(p, null, 1));
  console.log('stateHash', await sess.stateHash(t));
  console.log('consoleErrors', sess.consoleErrors().slice(0, 10));
} finally {
  await sess.close();
}

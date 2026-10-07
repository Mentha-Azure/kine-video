// 临时调试：解析 patch 表达式 + stageEdit
import { openProject } from '@kine/store';
import { loadAndCompile, parsePatchExpr } from '@kine/dsl';
import { stageEdit } from '@kine/store';

const store = await openProject('examples/mv-mini');
const comp = loadAndCompile(store.layout.timelineFile, { projectDir: store.root });
console.log('loaded?', !!comp.loaded, 'raw keys', Object.keys(comp.loaded.raw));
const op = parsePatchExpr('set scenes[title].layers[title_main].props.size=80');
console.log('op', JSON.stringify(op));
try {
  const s = await stageEdit(store, [op]);
  console.log('stage ok', JSON.stringify(s.summary));
} catch (e) {
  console.log('ERR', (e as Error).constructor.name, (e as Error).message);
  console.log((e as Error).stack?.split('\n').slice(0, 10).join('\n'));
}

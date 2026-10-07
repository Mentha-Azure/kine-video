// 临时调试：走完整 toolEdit 路径
import { AgentContext } from '../packages/agent/src/context';
import { toolEdit } from '../packages/agent/src/tools/edit';

const ctx = new AgentContext({ dir: 'examples/mv-mini', actor: 'internal', quiet: true });
try {
  const res = await toolEdit(ctx, { expr: 'set scenes[title].layers[title_main].props.size=80', quote: '标题稍微缩小一点' });
  console.log('RESULT', JSON.stringify(res, null, 2).slice(0, 800));
} catch (e) {
  console.log('ERR', (e as Error).constructor.name, (e as Error).message);
  console.log((e as Error).stack?.split('\n').slice(0, 14).join('\n'));
}

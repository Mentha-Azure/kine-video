// 调试：验证 patch expr 的数组/对象值解析（P1-2 复现）
import { parsePatchExpr, parseValue } from '../packages/dsl/src/patch';

const cases = [
  'set a.b = [220.0, 261.63]',
  'set a.b=[220.0, 261.63]',
  'set a.b = { flash: 0.032 }',
  'set a.b = 0.032',
  'set scenes[x].layers[y].props.notes = [220.0, 261.63, 329.63]',
];
for (const c of cases) {
  try {
    const op = parsePatchExpr(c);
    const v = op.value as unknown;
    console.log(JSON.stringify(c), '=>', op.path, '|', JSON.stringify(v), '|', typeof v, Array.isArray(v) ? 'ARRAY' : '');
  } catch (e) {
    console.log(JSON.stringify(c), '=> ERR', (e as Error).message);
  }
}
console.log('parseValue("[220.0, 261.63]") =>', JSON.stringify(parseValue('[220.0, 261.63]')));
console.log('parseValue("{ flash: 0.032 }") =>', JSON.stringify(parseValue('{ flash: 0.032 }')));

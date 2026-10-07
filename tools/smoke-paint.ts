// 调试：在 headless 页内直接测 canvas 文字与字体解析（用字符串 evaluate，避免 tsx __name 注入）
import { loadAndCompile } from '@kine/dsl';
import { openRenderSession, renderDefaults } from '@kine/render';

const file = process.argv[2] ?? 'examples/mv-mini/timeline.yaml';
const projectDir = file.replace(/[\\/][^\\/]+$/, '');
const r = loadAndCompile(file, { projectDir });
const o = renderDefaults(r.ir, projectDir);
const sess = await openRenderSession(r.ir, o);
try {
  await sess.load(r.ir);
  const family = (r.ir.theme as { font: { family: string } }).font.family;
  const info = await sess.page.evaluate(`(() => {
    const cv = document.getElementById('kine');
    const ctx = cv.getContext('2d');
    const test = (fontStr) => { ctx.save(); ctx.font = fontStr; const w = ctx.measureText('HELLO WORLD 0123456789').width; ctx.restore(); return { font: fontStr, width: Math.round(w * 10) / 10 }; };
    return {
      fontsStatus: document.fonts.status,
      familyFromIr: ${JSON.stringify(family)},
      checks: [
        test('700 40px Consolas'),
        test("700 40px 'Consolas', monospace"),
        test('700 40px monospace'),
        test('700 40px ' + ${JSON.stringify(family)}),
      ],
    };
  })()`);
  console.log(JSON.stringify(info, null, 1));
} finally {
  await sess.close();
}

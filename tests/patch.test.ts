// tests/patch.test.ts — patch 语法、应用与回滚（文档03/05/08）
import { describe, expect, it } from 'vitest';
import { applyPatch, parsePatchExpr, parseValue, reversePatch } from '@kine/dsl';

describe('patch 语法与回滚', () => {
  it('parsePatchExpr set（语义路径 + 赋值）', () => {
    const op = parsePatchExpr('set scenes[title].layers[title_main].props.size=80');
    expect(op.op).toBe('set');
    expect(op.path).toBe('scenes[title].layers[title_main].props.size');
    expect(op.value).toBe(80);
  });

  it('parseValue 退化类型', () => {
    expect(parseValue('80')).toBe(80);
    expect(parseValue('0.42')).toBe(0.42);
    expect(parseValue('true')).toBe(true);
    expect(parseValue('hello')).toBe('hello');
  });

  it('applyPatch + reversePatch 往返', () => {
    const doc: any = { scenes: [{ id: 'title', camera: { tw: 0.55 } }] };
    const op = parsePatchExpr('set scenes[title].camera.tw=0.42');
    const diff = applyPatch(doc, op);
    expect(doc.scenes[0].camera.tw).toBe(0.42);
    expect(diff.from).toBe(0.55);
    expect(diff.to).toBe(0.42);
    applyPatch(doc, reversePatch(diff));
    expect(doc.scenes[0].camera.tw).toBe(0.55);
  });

  it('数组按 id 选择', () => {
    const doc: any = { scenes: [{ id: 'a', dur: 1 }, { id: 'b', dur: 2 }] };
    applyPatch(doc, parsePatchExpr('set scenes[b].dur=3'));
    expect(doc.scenes[1].dur).toBe(3);
  });
});

// transition_spike 设计内边界豁免单测：幕头装置 / 镜头转场窗口 / 硬切瞬间
import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAndCompile } from '@kine/dsl';
import { classifyDesign, designedSpans } from '@kine/metrics';

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

function ir(fixture: string) {
  const res = loadAndCompile(path.join(fixtures, fixture, 'timeline.yaml'));
  const errors = [...res.issues, ...res.lintIssues].filter((i) => i.severity === 'error');
  expect(errors).toEqual([]);
  return res.ir;
}

describe('transition_spike 设计内边界', () => {
  it('accel-cut：镜头转场窗口命中判定为 shot-transition，幕中为 null', () => {
    const c = ir('accel-cut');
    const spans = designedSpans(c);
    expect(spans.length).toBeGreaterThanOrEqual(2);
    // accel:cut lt 压缩 ×1.62：镜头 2 边界 lt=1.8 → t≈1.111s（f66.7）；镜头 3 边界 lt=3.8 → t≈2.346s（f140.7）
    expect(classifyDesign(c, 67, 73)).toBe('shot-transition');
    expect(classifyDesign(c, 141, 147)).toBe('shot-transition');
    // 幕中（f60=1.0s、f180=3.0s）：非设计内
    expect(classifyDesign(c, 60, 66)).toBeNull();
    expect(classifyDesign(c, 180, 186)).toBeNull();
  });

  it('double-pace：第二幕幕头判定为 scene-head，幕中为 null', () => {
    const c = ir('double-pace');
    expect(classifyDesign(c, 240, 243)).toBe('scene-head');
    expect(classifyDesign(c, 300, 306)).toBeNull();
  });

  it('short-transition：短转场→shot-transition；无转场镜头→shot-cut；其余 null', () => {
    const c = ir('short-transition');
    // 镜头 2：t=1.2，whip_h（td≈0.21s，短转场集中变化场景）
    expect(classifyDesign(c, 72, 75)).toBe('shot-transition');
    // 镜头 3：t=1.8，未声明转场（设计内硬切）
    expect(classifyDesign(c, 108, 111)).toBe('shot-cut');
    // 镜头 4：t=2.7，wipe_redbar
    expect(classifyDesign(c, 162, 168)).toBe('shot-transition');
    expect(classifyDesign(c, 30, 36)).toBeNull();
  });
});

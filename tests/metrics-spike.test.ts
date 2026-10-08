// transition_spike 设计内边界豁免单测：幕头装置 / 镜头转场窗口 / 硬切瞬间 / 声明强拍白闪（beat-flash）
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
  it('accel-cut：镜头转场窗口命中判定为 shot-transition；强拍帧对为 beat-flash；其余为 null', () => {
    const c = ir('accel-cut');
    const spans = designedSpans(c);
    expect(spans.length).toBeGreaterThanOrEqual(2);
    // accel:cut lt 压缩 ×1.62：镜头 2 边界 lt=1.8 → t≈1.111s（f66.7）；镜头 3 边界 lt=3.8 → t≈2.346s（f140.7）
    expect(classifyDesign(c, 67, 73)).toBe('shot-transition');
    expect(classifyDesign(c, 141, 147)).toBe('shot-transition');
    // 强拍（bpm=108 → 拍点 1.6667s）帧对跨越拍点 → beat-flash（v3 P1-3）
    expect(classifyDesign(c, 94, 100)).toBe('beat-flash');
    // 幕中（f60=1.0s、f180=3.0s）：非设计内
    expect(classifyDesign(c, 60, 66)).toBeNull();
    expect(classifyDesign(c, 180, 186)).toBeNull();
  });

  it('double-pace：第二幕幕头判定为 scene-head；强拍帧对为 beat-flash；幕中为 null', () => {
    const c = ir('double-pace');
    expect(classifyDesign(c, 240, 243)).toBe('scene-head');
    // 第二幕 pace 1.5×：拍点 k=10 → T=5.5556 → t=5.0370s（f302.2）
    expect(classifyDesign(c, 300, 306)).toBe('beat-flash');
    expect(classifyDesign(c, 285, 291)).toBeNull();
  });

  it('short-transition：短转场→shot-transition；无转场镜头→shot-cut；强拍帧对→beat-flash；其余 null', () => {
    const c = ir('short-transition');
    // 镜头 2：t=1.2，whip_h（td≈0.21s，短转场集中变化场景）
    expect(classifyDesign(c, 72, 75)).toBe('shot-transition');
    // 镜头 3：t=1.8，未声明转场（设计内硬切）
    expect(classifyDesign(c, 108, 111)).toBe('shot-cut');
    // 镜头 4：t=2.7，wipe_redbar
    expect(classifyDesign(c, 162, 168)).toBe('shot-transition');
    // 强拍（bpm=100 → 拍点 0.6s）
    expect(classifyDesign(c, 30, 36)).toBe('beat-flash');
    expect(classifyDesign(c, 24, 30)).toBeNull();
  });
});

// v4 守卫回归：文本插值 / 输出压缩 / 写保护（E-PROJ-006）/ W-COLOR-004 / W-TEXT-001
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadAndCompile } from '@kine/dsl';
import { addLibraryEntry, kineLibraryRoot } from '@kine/store';
import { interpolateText } from '@kine/runtime';
import { AgentContext, compactValue, guardWrite } from '@kine/agent';

let tmp: string;
const origHome = process.env.KINE_HOME;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'kine-v4-'));
  process.env.KINE_HOME = tmp;
});

afterEach(() => {
  if (origHome === undefined) delete process.env.KINE_HOME;
  else process.env.KINE_HOME = origHome;
  rmSync(tmp, { recursive: true, force: true });
});

function projectYaml(over: { themeExtra?: string; layersYaml?: string } = {}): string {
  const themeExtra = over.themeExtra ? `, ${over.themeExtra}` : '';
  const layers = over.layersYaml
    ? over.layersYaml
    : `      - kind: particles\n        id: p1`;
  return `schema: kine/1
project: { id: guard4, title: Guard4, version: v0.1, seed: 7 }
output: { width: 640, height: 360, fps: 30, duration: 2 }
pace:
  segments: [{ id: full, until: 2, ratio: 1.0 }]
theme: { bg: ['#060609', '#0a0a12'], text: '#e8e8ea', text_dim: '#9a9aa2', accent: '#ff2e3f'${themeExtra} }
render: { surface: canvas, workers: 1 }
scenes:
  - id: s1
    dur: 2
    camera: { z1: 1.0 }
    layers:
${layers}
asserts: []
`;
}

function compileYaml(yaml: string): ReturnType<typeof loadAndCompile> {
  const dir = path.join(tmp, 'proj');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'timeline.yaml');
  writeFileSync(file, yaml, 'utf8');
  return loadAndCompile(file, {});
}

async function addFakePalette(name: string, data: Record<string, unknown>): Promise<string> {
  const entry = await addLibraryEntry(kineLibraryRoot(), {
    name,
    kind: 'palette',
    ns: 'usr',
    tags: [name],
    status: 'library',
    data,
  });
  return entry.id;
}

describe('interpolateText（文本插值：第 N 帧 = f(N)）', () => {
  it('{frame}/{t:.1f}/{T}/{lt} 确定性插值', () => {
    const s = interpolateText('F{frame} {t:.1f} T{T} lt{lt}', { frame: 120, t: 2.06, T: 2.5, lt: 0.4 });
    expect(s).toBe('F120 2.1 T2.50 lt0.40');
  });

  it('无 { 时原样返回（旧工程零变化）', () => {
    expect(interpolateText('plain text 100%', { frame: 1, t: 1, T: 1, lt: 1 })).toBe('plain text 100%');
  });

  it('frame 四舍五入取整', () => {
    expect(interpolateText('{frame}', { frame: 119.6, t: 0, T: 0, lt: 0 })).toBe('120');
  });
});

describe('compactValue（输出压缩）', () => {
  it('长字符串截断并标注字符数', () => {
    const s = compactValue('x'.repeat(200));
    expect(String(s)).toContain('…（200 字符）');
  });

  it('长数组折叠为前 2 项 + 总数', () => {
    const s = String(compactValue([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(s).toContain('共 8 项');
  });

  it('多键对象折叠为键摘要', () => {
    const s = String(compactValue({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7 }));
    expect(s).toContain('7 键');
  });
});

describe('guardWrite（E-PROJ-006 写保护）', () => {
  it('dirSource=scan → E-PROJ-006 拒绝', () => {
    const ctx = new AgentContext({ dir: tmp, actor: 'internal', dirSource: 'scan' });
    const g = guardWrite(ctx, 'edit');
    expect(g?.error?.code).toBe('E-PROJ-006');
  });

  it('dirSource=explicit → 放行（null）', () => {
    const ctx = new AgentContext({ dir: tmp, actor: 'internal', dirSource: 'explicit' });
    expect(guardWrite(ctx, 'edit')).toBeNull();
  });
});

describe('W-COLOR-004（palette 静默覆盖提示）', () => {
  it('显式 theme.bg 与色板不一致 → warn「会被色板覆盖」', async () => {
    const id = await addFakePalette('bg-diff', {
      bg: ['#101018', '#181820'],
      text: '#e8e8ea',
      text_dim: '#9a9aa2',
      accent: '#ff2e3f',
    });
    const yaml = projectYaml({ themeExtra: `profile: extended, palette: 'library://${id}'` });
    const c = compileYaml(yaml);
    expect(c.lintIssues.some((i) => i.code === 'W-COLOR-004' && i.severity === 'warn')).toBe(true);
  });
});

describe('W-TEXT-001（未知文本占位符）', () => {
  it("content 含 {frames}（未知）→ warn；{frame} → 无", () => {
    const bad = projectYaml({
      layersYaml: `      - kind: text\n        id: t1\n        content: 'FRAME {frames}'\n        place: { x: 100, y: 100 }`,
    });
    expect(compileYaml(bad).lintIssues.some((i) => i.code === 'W-TEXT-001')).toBe(true);

    const good = projectYaml({
      layersYaml: `      - kind: text\n        id: t1\n        content: 'FRAME {frame} / {t:.2f}'\n        place: { x: 100, y: 100 }`,
    });
    expect(compileYaml(good).lintIssues.some((i) => i.code === 'W-TEXT-001')).toBe(false);
  });
});

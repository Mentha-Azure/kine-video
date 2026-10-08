import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadAndCompile } from '@kine/dsl';
import { addLibraryEntry, kineLibraryRoot } from '@kine/store';
import { parseRangeSpec } from '@kine/agent';

let tmp: string;
const origHome = process.env.KINE_HOME;

beforeEach(() => {
  tmp = mkdtempSync(path.join(tmpdir(), 'kine-v3-'));
  process.env.KINE_HOME = tmp;
});

afterEach(() => {
  if (origHome === undefined) delete process.env.KINE_HOME;
  else process.env.KINE_HOME = origHome;
  rmSync(tmp, { recursive: true, force: true });
});

/** 最小工程 YAML；themeExtra 追加 theme 流式映射字段；eventsYaml 为复数行事件（缩进 6 空格） */
function projectYaml(over: { themeExtra?: string; eventsYaml?: string } = {}): string {
  const themeExtra = over.themeExtra ? `, ${over.themeExtra}` : '';
  const audio = over.eventsYaml
    ? `\naudio:\n  sfx:\n    synth: offline\n    buses: [{ id: bed, gain: 1.0 }, { id: hits, gain: 1.0 }]\n    events:\n${over.eventsYaml}`
    : '';
  return `schema: kine/1
project: { id: guard, title: Guard, version: v0.1, seed: 7 }
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
      - kind: particles
        id: p1${audio}
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

const CORE_LIKE = {
  bg: ['#060609', '#0a0a12'],
  text: '#e8e8ea',
  text_dim: '#9a9aa2',
  accent: '#ff2e3f',
};

describe('parseRangeSpec（P0-1 range 严格校验）', () => {
  it('合法秒区间：0.1:0.9 / 12:14', () => {
    const r1 = parseRangeSpec('0.1:0.9');
    expect(r1.ok).toBe(true);
    if (r1.ok) expect(r1.range).toEqual([0.1, 0.9]);
    const r2 = parseRangeSpec('12:14');
    expect(r2.ok).toBe(true);
    if (r2.ok) expect(r2.range).toEqual([12, 14]);
  });

  it('非递增 1:1 与非法 abc 均报错', () => {
    expect(parseRangeSpec('1:1').ok).toBe(false);
    expect(parseRangeSpec('abc').ok).toBe(false);
    expect(parseRangeSpec('12:10').ok).toBe(false);
    expect(parseRangeSpec('').ok).toBe(false);
  });

  it('数组入参与 maxSec 越界', () => {
    const r = parseRangeSpec([0.1, 0.9]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.range).toEqual([0.1, 0.9]);
    expect(parseRangeSpec([0.9, 0.1]).ok).toBe(false);
    expect(parseRangeSpec('0:5', 4).ok).toBe(false);
    expect(parseRangeSpec([0, 10], 4).ok).toBe(false);
    expect(parseRangeSpec('0:4', 4).ok).toBe(true);
  });
});

describe('E-SYNTH-001（P0-4 sfx 参数值校验）', () => {
  it('piano_motif notes:4（标量）→ E-SYNTH-001 error', () => {
    const yaml = projectYaml({
      eventsYaml: '      - { at: 0.4, clock: output, sfx: piano_motif, gain: 0.5, bus: hits, params: { notes: 4 } }',
    });
    const c = compileYaml(yaml);
    const hit = c.lintIssues.find((i) => i.code === 'E-SYNTH-001');
    expect(hit).toBeTruthy();
    expect(hit!.severity).toBe('error');
  });

  it('notes: [220.0, 261.63] 合法数组 → 无 E-SYNTH-001', () => {
    const yaml = projectYaml({
      eventsYaml: '      - { at: 0.4, clock: output, sfx: piano_motif, gain: 0.5, bus: hits, params: { notes: [220.0, 261.63] } }',
    });
    const c = compileYaml(yaml);
    expect(c.lintIssues.some((i) => i.code === 'E-SYNTH-001')).toBe(false);
  });
});

describe('风格档案与色板（P0-3）', () => {
  it('extended + 与 core 相同的色板 → W-LIB-002 warn', async () => {
    const id = await addFakePalette('core-like', CORE_LIKE);
    const yaml = projectYaml({ themeExtra: `profile: extended, palette: 'library://${id}'` });
    const c = compileYaml(yaml);
    expect(c.lintIssues.some((i) => i.code === 'W-LIB-002' && i.severity === 'warn')).toBe(true);
  });

  it('亮 bg 色板（通道 255）→ 解析期 E-COLOR-002', async () => {
    const id = await addFakePalette('daylight', { bg: ['#ffffff', '#eeeeee'], text: '#111111', text_dim: '#333333', accent: '#ff2e3f' });
    const yaml = projectYaml({ themeExtra: `profile: extended, palette: 'library://${id}'` });
    const c = compileYaml(yaml);
    expect(c.lintIssues.some((i) => i.code === 'E-COLOR-002')).toBe(true);
  });

  it('core + palette 同时出现 → E-COLOR-003', () => {
    const yaml = projectYaml({ themeExtra: `profile: core, palette: 'library://usr/whatever'` });
    const c = compileYaml(yaml);
    expect(c.lintIssues.some((i) => i.code === 'E-COLOR-003')).toBe(true);
  });
});

// v5 守卫：浅色模式（E-COLOR-002/005）+ 字幕（SRT 内联 / lint / 导出）+ 色板浅底校验
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadAndCompile, parseSrt, resolvePalette } from '@kine/dsl';
import { addLibraryEntry, kineLibraryRoot } from '@kine/store';
import { collectSubtitleCues, renderSrt } from '@kine/render';

let root: string;
const oldHome = process.env.KINE_HOME;

function projectYaml(themeLines: string[], layers: string): string {
  return [
    'schema: kine/1',
    'project: { id: t5, title: T5, version: v0.1, seed: 7 }',
    'output: { width: 640, height: 360, fps: 30, duration: 2 }',
    'pace: { segments: [{ id: full, until: 2, ratio: 1.0 }] }',
    'theme:',
    ...themeLines.map((l) => `  ${l}`),
    '  font: { family: "Consolas, monospace", scale: 1, base: 24 }',
    'render: { surface: canvas, workers: 1 }',
    'scenes:',
    '  - id: s1',
    '    dur: 2',
    '    camera: { z1: 1.0, tw: 0 }',
    '    layers:',
    layers,
    'asserts: []',
    '',
  ].join('\n');
}

function writeProject(yaml: string, extraFiles: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(root, 'proj-'));
  writeFileSync(join(dir, 'timeline.yaml'), yaml, 'utf8');
  for (const [rel, content] of Object.entries(extraFiles)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return join(dir, 'timeline.yaml');
}

const PARTICLES = '      - { kind: particles, id: p1, depth: far, count: 10 }';

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'kine-v5-'));
  process.env.KINE_HOME = join(root, 'home');
});

afterEach(() => {
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    /* noop */
  }
  if (oldHome === undefined) delete process.env.KINE_HOME;
  else process.env.KINE_HOME = oldHome;
});

describe('浅色模式（theme.mode）', () => {
  it('dark（默认）下亮背景 → E-COLOR-002', () => {
    const f = writeProject(projectYaml(["bg: ['#f4f5f7', '#e8e8ea']", "text: '#202028'"], PARTICLES));
    const c = loadAndCompile(f, {});
    expect(c.lintIssues.some((i) => i.code === 'E-COLOR-002' && i.severity === 'error')).toBe(true);
  });

  it('mode: light 下同样的亮背景 → 放行（无 E-COLOR-002 / E-COLOR-005）', () => {
    const f = writeProject(projectYaml(['mode: light', "bg: ['#f4f5f7', '#e8e8ea']", "text: '#202028'"], PARTICLES));
    const c = loadAndCompile(f, {});
    const codes = c.lintIssues.map((i) => i.code);
    expect(codes.includes('E-COLOR-002')).toBe(false);
    expect(codes.includes('E-COLOR-005')).toBe(false);
  });

  it('mode: light 下低对比正文 → E-COLOR-005', () => {
    const f = writeProject(projectYaml(['mode: light', "bg: ['#f4f5f7', '#e8e8ea']", "text: '#cfcfd8'"], PARTICLES));
    const c = loadAndCompile(f, {});
    expect(c.lintIssues.some((i) => i.code === 'E-COLOR-005' && i.severity === 'error')).toBe(true);
  });

  it('浅底色板：mode: palette light 校验（bg 过暗 → E-COLOR-002；合规浅板 → ok）', async () => {
    const libRoot = kineLibraryRoot();
    await addLibraryEntry(libRoot, {
      name: 'light-ok', kind: 'palette', ns: 'usr', id: 'usr/light-ok',
      tags: ['light'], status: 'library',
      data: { bg: ['#f4f5f7', '#e8e8ea'], text: '#202028', text_dim: '#6a6a72', accent: '#ff2e3f', mode: 'light' },
    });
    await addLibraryEntry(libRoot, {
      name: 'light-bad', kind: 'palette', ns: 'usr', id: 'usr/light-bad',
      tags: ['light'], status: 'library',
      data: { bg: ['#101018', '#181820'], text: '#e8e8ea', text_dim: '#9a9aa2', accent: '#ff2e3f', mode: 'light' },
    });
    const ok = resolvePalette('library://usr/light-ok', process.env.KINE_HOME);
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.palette.mode).toBe('light');
    const bad = resolvePalette('library://usr/light-bad', process.env.KINE_HOME);
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.code).toBe('E-COLOR-002');
  });
});

describe('字幕层（subtitles）', () => {
  it('parseSrt：解析时间行 / 容忍 CRLF / 坏块计数', () => {
    const src = '1\r\n00:00:01,200 --> 00:00:02,400\r\n第一句\r\n\r\n2\r\n00:00:03,000 --> 00:00:04,000\r\n第二句\n\n坏块没有时间行\n';
    const { cues, bad } = parseSrt(src);
    expect(cues.length).toBe(2);
    expect(cues[0]).toEqual({ from: 1.2, to: 2.4, text: '第一句' });
    expect(cues[1]!.from).toBe(3);
    expect(bad).toBe(1);
  });

  it('src 指向 SRT → 编译期内联 cues；renderSrt 可导出', () => {
    const srt = '1\n00:00:01,200 --> 00:00:02,400\nhello\n\n2\n00:01:00,000 --> 00:01:02,000\nworld\n';
    const layers = ['      - kind: subtitles', '        id: sub1', '        src: subs/demo.srt'];
    const f = writeProject(projectYaml(["bg: ['#060609', '#0a0a12']"], layers.join('\n')), { 'subs/demo.srt': srt });
    const c = loadAndCompile(f, {});
    expect(c.issues.filter((i) => i.severity === 'error').length).toBe(0);
    const sub = (c.ir.scenes[0]!.layers as Array<{ kind: string; cues?: unknown[] }>).find((l) => l.kind === 'subtitles');
    expect(sub?.cues?.length).toBe(2);
    const srtOut = renderSrt(collectSubtitleCues(c.ir));
    expect(srtOut).toContain('00:00:01,200 --> 00:00:02,400');
    expect(srtOut).toContain('00:01:00,000 --> 00:01:02,000');
    expect(srtOut).toContain('hello');
  });

  it('无 src 且无 cues → E-ASSET-001；cue 重叠 → W-SUB-001', () => {
    const layers = ['      - kind: subtitles', '        id: subx', '        cues:', '          - { from: 0.2, to: 1.0, text: A }', '          - { from: 0.8, to: 1.5, text: B }'];
    const f = writeProject(projectYaml(["bg: ['#060609', '#0a0a12']"], layers.join('\n')));
    const c = loadAndCompile(f, {});
    expect(c.lintIssues.some((i) => i.code === 'W-SUB-001' && i.severity === 'warn')).toBe(true);
    const f2 = writeProject(projectYaml(["bg: ['#060609', '#0a0a12']"], ['      - kind: subtitles', '        id: suby'].join('\n')));
    const c2 = loadAndCompile(f2, {});
    expect(c2.lintIssues.some((i) => i.code === 'E-ASSET-001' && i.severity === 'error')).toBe(true);
  });
});

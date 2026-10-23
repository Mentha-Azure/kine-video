// @kine/agent — project.* 工具组
import fs from 'node:fs';
import path from 'node:path';
import { AgentContext } from '../context';
import { ok, fail, type ToolResult } from '../types';
import {
  projectLayout, ensureLayout, hasProject, doctor, listVersions, readLatest, kineRepoRoot, versionVideoFile,
} from '@kine/store';

const TEMPLATES = ['mv-mini', 'blank'] as const;
export type TemplateName = (typeof TEMPLATES)[number];

export interface InitResult {
  dir: string;
  template: TemplateName;
  files: string[];
}

export async function toolInit(args: { dir: string; template?: string; force?: boolean }): Promise<ToolResult<InitResult>> {
  const tool = 'project.init';
  const dir = path.resolve(args.dir);
  const template = (args.template ?? 'mv-mini') as TemplateName;
  if (!TEMPLATES.includes(template)) {
    return fail(tool, 'E-INPUT-001', `未知模板 "${args.template}"`, { hints: [`可用模板：${TEMPLATES.join(' / ')}`] });
  }
  if (fs.existsSync(path.join(dir, 'timeline.yaml')) && !args.force) {
    return fail(tool, 'E-INIT-001', `目录已存在 timeline.yaml：${dir}`, { hints: ['用 --force 覆盖初始化（会先备份? 不会——请手工确认）'] });
  }
  fs.mkdirSync(dir, { recursive: true });

  const files: string[] = [];
  if (template === 'mv-mini') {
    const src = path.join(kineRepoRoot(), 'examples', 'mv-mini');
    if (!fs.existsSync(src)) {
      return fail(tool, 'E-INIT-002', `模板源不存在：${src}`, { hints: ['确认 kine 仓库完整（examples/mv-mini）'] });
    }
    copyTemplate(src, dir, files);
  } else {
    writeBlank(dir, files);
  }

  const layout = projectLayout(dir);
  ensureLayout(layout);
  fs.mkdirSync(layout.assetsDir, { recursive: true });
  if (!fs.existsSync(layout.readmeFile)) {
    fs.writeFileSync(layout.readmeFile, `# ${path.basename(dir)}\n\nKine 工程（模板：${template}）。\n快速开始：\n\n    kine audit\n    kine render --range 0:5\n    kine preview --at 5 --dur 4\n`, 'utf8');
    files.push('README.md');
  }

  return ok(tool, { dir, template, files }, {
    facts: [
      `工程已初始化：${dir}（模板 ${template}）`,
      `时间轴：${path.relative(dir, layout.timelineFile)}`,
    ],
    nextActions: [
      { tool: 'audit', args: { dir }, reason: '先做三层检查' },
      { tool: 'project.info', args: { dir }, reason: '查看工程结构' },
    ],
  });
}

function copyTemplate(src: string, dst: string, files: string[]): void {
  const skip = new Set(['.kine', 'node_modules']);
  const walk = (s: string, d: string, rel: string) => {
    fs.mkdirSync(d, { recursive: true });
    for (const ent of fs.readdirSync(s, { withFileTypes: true })) {
      if (skip.has(ent.name)) continue;
      const sp = path.join(s, ent.name);
      const dp = path.join(d, ent.name);
      const r = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(sp, dp, r);
      else {
        fs.copyFileSync(sp, dp);
        files.push(r);
      }
    }
  };
  walk(src, dst, '');
}

function writeBlank(dir: string, files: string[]): void {
  const yaml = `schema: kine/1

project:
  id: blank
  title: Blank Project
  version: v0.1
  seed: 7

output:
  width: 1920
  height: 1080
  fps: 60
  duration: 5.0
  video: { codec: libx264, crf: 15, preset: slow }
  audio: { codec: aac, bitrate: 192k, limit_dbfs: -1.0 }

pace:
  segments:
    - { id: full, until: 5.0, ratio: 1.0 }

theme:
  bg: ['#060609', '#0a0a12']
  text: '#e8e8ea'
  text_dim: '#9a9aa2'
  accent: '#ff2e3f'
  font: { family: "Consolas, 'Cascadia Mono', 'Courier New', monospace", scale: 1.0, base: 32 }
  post:
    vignette: { base: 0.20, tw_gain: 0.11, beat_gain: 0.09, max: 0.90 }
    scanline: { base: 0.085, tw_gain: 0.020, max: 0.12 }
    flash: { max_alpha: 0.085 }
    black_level: { rgb_min: 6, rgb_max: 9 }

render:
  surface: canvas
  workers: 4

scenes:
  - id: main
    name: 主幕
    dur: 5.0
    camera: { z1: 1.0, tw: 0.12, bpm: 108 }
    layers:
      - kind: widget
        id: bg
        widget: bdBG
        props: { cell: 30, sweep: 6 }
        place: { x: 960, y: 540, w: 1700, h: 950, anchor: center }
      - kind: particles
        id: p_far
        depth: far
        count: 48
        size: [1.0, 2.4]
      - kind: widget
        id: title
        widget: bdTitle
        props: { text: "BLANK", sub: "kine blank template", size: 72 }
        place: { x: 960, y: 500, anchor: center }

audio:
  sfx:
    synth: offline
    buses:
      - { id: bed, gain: 1.0 }
      - { id: hits, gain: 1.0 }
    events: []

asserts:
  - { id: density-ok, metric: density, expect: ">= 0.9 %", severity: warn }
`;
  fs.writeFileSync(path.join(dir, 'timeline.yaml'), yaml, 'utf8');
  files.push('timeline.yaml');
}

export interface InfoResult {
  dir: string;
  id: string;
  title: string;
  version: string;
  schema: string;
  specHash8: string;
  output: { width: number; height: number; fps: number; duration: number; frames: number };
  pace: { id: string; t0: number; t1: number; ratio: number; frames: number }[];
  scenes: { id: string; name?: string; t0: number; t1: number; T0: number; T1: number; frames: number; rate: number; accel: string; shots: number; layers: number }[];
  audio: { musicFile?: string; musicExists?: boolean; sfxEvents: number; buses: number; drone: boolean };
  asserts: number;
  widgets: string[];
  versions: { version: string; file?: string }[];
  latest?: string | null;
  issueCount: { errors: number; warnings: number };
}

export async function toolInfo(ctx: AgentContext): Promise<ToolResult<InfoResult>> {
  const tool = 'project.info';
  const { ir, issues, lintIssues } = ctx.compile();
  if (!hasProject(ctx.dir)) return fail(tool, 'E-PROJ-001', `不是 Kine 工程目录：${ctx.dir}`);
  const all = [...issues, ...lintIssues];
  const versions = listVersions(ctx.store.layout.outDir).map((v) => {
    const vf = versionVideoFile(v);
    return { version: v.version, file: vf ? path.relative(ctx.store.root, vf) : undefined };
  });
  const latest = readLatest(ctx.store.layout.outDir);
  const widgets = new Set<string>();
  for (const sc of ir.scenes) {
    for (const l of sc.layers) if (l.kind === 'widget') widgets.add(l.widget as string);
  }
  const data: InfoResult = {
    dir: ctx.store.root,
    id: ir.project.id,
    title: ir.project.title,
    version: ir.project.version,
    schema: ir.schema,
    specHash8: ir.specHash.slice(0, 8),
    output: {
      width: ir.output.width, height: ir.output.height, fps: ir.output.fps,
      duration: ir.output.duration, frames: ir.time.map.frames,
    },
    pace: ir.time.map.segments.map((s) => ({ id: s.id, t0: s.t0, t1: s.t1, ratio: s.ratio, frames: s.frame1 - s.frame0 })),
    scenes: ir.scenes.map((s) => ({
      id: s.id, name: s.name, t0: s.t0, t1: s.t1, T0: s.T0, T1: s.T1,
      frames: s.frame1 - s.frame0,
      rate: s.rate, accel: s.accel, shots: s.shots.length, layers: s.layers.length,
    })),
    audio: {
      musicFile: ir.audioPlan.music?.file,
      musicExists: ir.audioPlan.music?.exists,
      sfxEvents: ir.audioPlan.sfxEvents.length,
      buses: ir.audioPlan.buses.length,
      drone: (ir.audioPlan.droneLevels?.length ?? 0) > 0,
    },
    asserts: ir.assertPlan.length,
    widgets: [...widgets].sort(),
    versions,
    latest: latest?.version ?? null,
    issueCount: {
      errors: all.filter((i) => i.severity === 'error').length,
      warnings: all.filter((i) => i.severity === 'warn').length,
    },
  };
  return ok(tool, data, {
    facts: [
      `工程 ${data.id}「${data.title}」v${data.version.replace(/^v/, '')}，${data.output.width}x${data.output.height}@${data.output.fps}，成片 ${data.output.duration}s（${data.output.frames} 帧）`,
      `specHash ${data.specHash8}；幕数 ${data.scenes.length}；pace 段 ${data.pace.length}`,
      `音乐：${data.audio.musicFile ? `${data.audio.musicFile}${data.audio.musicExists ? '' : '（文件缺失！）'}` : '无'}；sfx 事件 ${data.audio.sfxEvents}`,
      `已发布版本 ${data.versions.length} 个${data.latest ? `（最新 ${data.latest}）` : ''}`,
      ...(data.issueCount.errors > 0 ? [`有 ${data.issueCount.errors} 个 error 级问题，先跑 audit`] : []),
    ],
    nextActions: data.issueCount.errors > 0
      ? [{ tool: 'audit', args: { dir: ctx.dir }, reason: '修复 error 级问题' }]
      : [{ tool: 'timeline.map', args: { dir: ctx.dir }, reason: '查看时间对照表' }],
    verdict: data.issueCount.errors > 0 ? 'FAIL' : 'PASS',
  });
}

export async function toolDoctor(ctx: AgentContext, args: { fix?: boolean }): Promise<ToolResult<unknown>> {
  const tool = 'project.doctor';
  const report = doctor(ctx.store, { fix: args.fix });
  return ok(tool, report, {
    facts: report.checks.map((c) => `[${c.status}] ${c.name}: ${c.detail}${c.fixed ? '（已修复）' : ''}`),
    verdict: report.ok ? 'PASS' : 'FAIL',
  });
}

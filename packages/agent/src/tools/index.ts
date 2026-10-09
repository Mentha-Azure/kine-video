// tools/index.ts — 工具注册表（CLI 与 MCP 同源）
import { resolve } from 'node:path';
import type { ToolResult } from '../types';
import type { AgentContext } from '../context';
import { toolInit, toolInfo, toolDoctor } from './project';
import { toolProjects } from './projects';
import { toolCompile, toolMap, toolProbe, toolFind, toolExplain } from './timeline';
import { toolImpact } from './impact';
import { toolEdit } from './edit';
import { toolMeasure } from './measure';
import { toolAudit } from './audit';
import { toolCheck } from './check';
import { toolPreview } from './preview';
import { toolRender } from './render';
import { toolVerify } from './verify';
import { toolChangelog, toolRollback, toolBaseline, toolDiff, toolVersions } from './history';
import { toolCache } from './cache';
import { toolLibrary } from './library';
import { toolMusic } from './music';
import { toolForge } from './forge';
import { toolStyle } from './style';
import { toolWidgets } from './widgets';
import { toolRules } from './rules';
import { toolLayout } from './layout';
import { toolContact } from './contact';

export type ToolHandler = (ctx: AgentContext, args: any) => Promise<ToolResult>;

export interface ToolDef {
  /** CLI 子命令名 */
  name: string;
  /** MCP 工具名（kine 命名空间） */
  mcp: string;
  /** 一行说明（CLI help / MCP description） */
  title: string;
  handler: ToolHandler;
}

export const TOOLS: ToolDef[] = [
  // init 是唯一「无工程上下文」工具（args 传目标目录；相对路径按用户 cwd（ctx.dir）解析）
  { name: 'init', mcp: 'kine.init', title: '初始化工程（模板 mv-mini / blank）', handler: ((ctx: AgentContext, args: { dir?: string; template?: string; force?: boolean }) => toolInit({ ...args, dir: resolve(ctx.dir, args?.dir ?? '.') })) as ToolHandler },
  { name: 'projects', mcp: 'kine.projects', title: '已登记工程列表（--forget 移除；默认 dir 解析依据）', handler: ((ctx: AgentContext, args: { forget?: string }) => toolProjects(args ?? {})) as ToolHandler },
  { name: 'library', mcp: 'kine.library', title: '资源库（add/list/search/rm/gc/verify/pin/tags）', handler: toolLibrary as ToolHandler },
  { name: 'music', mcp: 'kine.music', title: '音乐库（add/info/analyze/beats/fit）', handler: toolMusic as ToolHandler },
  { name: 'forge', mcp: 'kine.forge', title: '创作层（create/save/list/register：模板/色板/预设）', handler: toolForge as ToolHandler },
  { name: 'style', mcp: 'kine.style', title: '风格档案应用（apply/show：profile+palette 事务化）', handler: toolStyle as ToolHandler },
  { name: 'widgets', mcp: 'kine.widgets', title: '内置 widget 清单与参数（list/info）', handler: toolWidgets as ToolHandler },
  { name: 'rules', mcp: 'kine.rules', title: '规则全集（含义/修复建议；kine://rules 资源同源）', handler: toolRules as ToolHandler },
  { name: 'info', mcp: 'kine.info', title: '工程概览（尺寸/时长/specHash/幕/断言）', handler: toolInfo as ToolHandler },
  { name: 'compile', mcp: 'kine.compile', title: '编译 timeline.yaml → IR（可 --write）', handler: toolCompile as ToolHandler },
  { name: 'map', mcp: 'kine.map', title: '时间对照表（--t 秒 / --frame N / 整表）', handler: toolMap as ToolHandler },
  { name: 'probe', mcp: 'kine.probe', title: '探针：某时刻画面结构（元素/相机/后处理）', handler: toolProbe as ToolHandler },
  { name: 'layout', mcp: 'kine.layout', title: '布局体检：bbox 重叠/出画/贴边（v4）', handler: toolLayout as ToolHandler },
  { name: 'contact', mcp: 'kine.contact', title: '接触表：抓帧拼图与时间标注（v4，一屏验收）', handler: toolContact as ToolHandler },
  { name: 'find', mcp: 'kine.find', title: '语义寻址：按名称/标签/alias 定位元素', handler: toolFind as ToolHandler },
  { name: 'explain', mcp: 'kine.explain', title: '解释路径：值/定义处/驱动/有效时间公式', handler: toolExplain as ToolHandler },
  { name: 'impact', mcp: 'kine.impact', title: '影响分析：改动会失效/保留什么', handler: toolImpact as ToolHandler },
  { name: 'edit', mcp: 'kine.edit', title: '事务化编辑（--tx --quote 必填，--preview 出短片）', handler: toolEdit as ToolHandler },
  { name: 'measure', mcp: 'kine.measure', title: '度量指标（density/frame_diff/cam_jitter/…）', handler: toolMeasure as ToolHandler },
  { name: 'audit', mcp: 'kine.audit', title: '三层检查：schema + purity + 全轴运行时扫错', handler: toolAudit as ToolHandler },
  { name: 'check', mcp: 'kine.check', title: '断言集检查（含基线回归对比）', handler: toolCheck as ToolHandler },
  { name: 'baseline', mcp: 'kine.baseline', title: '基线保存/查看', handler: toolBaseline as ToolHandler },
  { name: 'diff', mcp: 'kine.diff', title: '两版本三联对比（指标/关键帧/语义）', handler: toolDiff as ToolHandler },
  { name: 'preview', mcp: 'kine.preview', title: '成品形态短预览（3-5s，带音轨）', handler: toolPreview as ToolHandler },
  { name: 'render', mcp: 'kine.render', title: '渲染出片（--range/--workers/--no-cache）', handler: toolRender as ToolHandler },
  { name: 'verify', mcp: 'kine.verify', title: '成片终检（帧数/时长/音频/接缝/抽检）', handler: toolVerify as ToolHandler },
  { name: 'changelog', mcp: 'kine.changelog', title: '事务记录', handler: toolChangelog as ToolHandler },
  { name: 'rollback', mcp: 'kine.rollback', title: '回滚某事务', handler: toolRollback as ToolHandler },
  { name: 'cache', mcp: 'kine.cache', title: '缓存状态/GC', handler: toolCache as ToolHandler },
  { name: 'versions', mcp: 'kine.versions', title: '出片版本列表', handler: toolVersions as ToolHandler },
  { name: 'doctor', mcp: 'kine.doctor', title: '工程健康检查（--fix 修复）', handler: toolDoctor as ToolHandler },
];

export function findTool(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}

export function toolNames(): string[] {
  return TOOLS.map((t) => t.name);
}

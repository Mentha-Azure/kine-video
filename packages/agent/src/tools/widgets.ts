// @kine/agent — widgets：组件注册表查询（M11a manifest；v4 起含视觉描述与完整 props 规格）
import { getWidget } from '@kine/runtime';
import { WIDGET_NAMES, widgetMeta } from '@kine/widgets';
import type { AgentContext } from '../context';
import { fail, ok, type ToolResult } from '../types';

export interface WidgetsArgs {
  action: 'list' | 'info';
  name?: string;
}

export async function toolWidgets(_ctx: AgentContext, args: WidgetsArgs): Promise<ToolResult<unknown>> {
  if (args.action === 'list') {
    const names = [...WIDGET_NAMES].sort();
    return ok('widgets', { count: names.length, names }, {
      facts: [`共 ${names.length} 个内置 widget：`, names.join(' / ')],
      nextActions: names.length > 0 ? [{ tool: 'widgets', args: { action: 'info', name: names[0] } }] : [],
    });
  }

  if (!args.name) return fail('widgets', 'E-WID-001', 'info 需要 --name');
  const def = getWidget(args.name);
  if (!def) {
    return fail('widgets', 'E-WID-001', `未注册的 widget "${args.name}"`, {
      facts: [`可用：${[...WIDGET_NAMES].sort().join(' / ')}`],
      hints: ['自定义 pack 的 widget 使用 custom.<id> 前缀（Tier3，需注册后可用）'],
    });
  }
  const size = def.defaultSize;
  const meta = widgetMeta(args.name);
  const propsLines = meta && meta.props.length > 0
    ? meta.props.map((p) => `  ${p.name}（${p.type}，默认 ${JSON.stringify(p.default)}）：${p.desc}`)
    : ['  （无 props）'];
  const example = [
    `layers:`,
    `  - kind: widget`,
    `    id: ${args.name}_1`,
    `    widget: ${args.name}`,
    `    props: {}   # 参数缺省即结构性运动默认；完整参数见上方 props 表`,
    `    place: { x: 960, y: 540, w: ${size.w}, h: ${size.h}, anchor: center }`,
  ].join('\n');
  const facts = [
    `${args.name}：默认尺寸 ${size.w}×${size.h}（1080p 设计像素）`,
    meta ? `描述：${meta.desc}` : null,
    meta?.note ? `注意：${meta.note}` : null,
    'props：',
    ...propsLines,
    'YAML 示例：',
    example,
  ].filter((x): x is string => Boolean(x));
  return ok('widgets', { name: args.name, defaultSize: size, desc: meta?.desc ?? null, note: meta?.note ?? null, props: meta?.props ?? [], example }, {
    facts,
  });
}

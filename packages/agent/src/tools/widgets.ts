// @kine/agent — widgets：组件注册表查询（M11a manifest 极简版）
import { getWidget } from '@kine/runtime';
import { WIDGET_NAMES } from '@kine/widgets';
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
  const example = [
    `layers:`,
    `  - kind: widget`,
    `    id: ${args.name}_1`,
    `    widget: ${args.name}`,
    `    props: {}   # 参数缺省即结构性运动默认（manifest 完整版随 M12 扩展）`,
    `    place: { x: 960, y: 540, w: ${size.w}, h: ${size.h}, anchor: center }`,
  ].join('\n');
  return ok('widgets', { name: args.name, defaultSize: size, example }, {
    facts: [`${args.name}：默认尺寸 ${size.w}×${size.h}（1080p 设计像素）`, 'YAML 示例：', example],
  });
}

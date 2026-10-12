// @kine/widgets — 官方 widget 库入口（宿主 bundle 单入口调用 registerAll）
import './chart';
import './bd1';
import './bd2';
import './draw1';
import './draw2';
import { listWidgets, type WidgetDrawCtx, type WidgetDef, type WidgetProbe, type WidgetEnv } from '@kine/runtime';

export { listWidgets };
export * from './meta';
export type { WidgetDrawCtx, WidgetDef, WidgetProbe, WidgetEnv };

/** 幂等：文件导入即注册（模块级副作用 = 注册表写入，允许的唯一形式） */
export function registerAll(): void {
  // 导入本身已完成注册；此函数用于打包器保留副作用的可读入口
}

export const WIDGET_NAMES = listWidgets();

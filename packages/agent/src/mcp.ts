// MCP server（server 名：kine）——与 CLI 同一 TOOLS 注册表的薄层
// 每工具一个 MCP tool，名称 kine.<tool>；render 支持 progress notification；
// resources 暴露 kine://project/info、kine://map、kine://baseline。
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { latestBaseline } from '@kine/store';
import { AgentContext } from './context';
import { ResolveError, resolveTargetDir } from './resolve';
import { TOOLS, findTool } from './tools';
import { RULES } from './tools/rules';
import type { ToolResult } from './types';

interface JsonSchema {
  type: 'object';
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

const str = (description: string) => ({ type: 'string', description });
const num = (description: string) => ({ type: 'number', description });
const bool = (description: string) => ({ type: 'boolean', description });

const ARG_SCHEMAS: Record<string, JsonSchema> = {
  init: {
    type: 'object',
    properties: {
      dir: str('目标工程目录（默认当前目录）'),
      template: str('模板：mv-mini | blank'),
      force: bool('目录已有工程时强制覆盖'),
    },
    additionalProperties: false,
  },
  info: { type: 'object', properties: {}, additionalProperties: false },
  compile: {
    type: 'object',
    properties: { writeIR: bool('写出 .kine/ir/project.ir.json'), strict: bool('警告升为错误') },
    additionalProperties: false,
  },
  map: {
    type: 'object',
    properties: {
      t: num('成片秒（与 frame 二选一）'),
      frame: num('成片帧号（0-based）'),
      full: bool('输出完整时间对照表'),
    },
    additionalProperties: false,
  },
  probe: {
    type: 'object',
    properties: { at: num('成片秒'), hash: bool('附带 stateHash') },
    required: ['at'],
    additionalProperties: false,
  },
  find: {
    type: 'object',
    properties: {
      query: str('自然语义查询（别名/标签/id/内容）'),
      scene: str('限定幕 id'),
      range: str('限定时间窗 [t0:t1]（成片秒）'),
      kind: str('限定图层类型 widget|text|particles|image|video|fx'),
    },
    required: ['query'],
    additionalProperties: false,
  },
  explain: {
    type: 'object',
    properties: { path: str('DSL 路径，如 scenes[code].camera.tw') },
    required: ['path'],
    additionalProperties: false,
  },
  impact: {
    type: 'object',
    properties: { paths: { type: 'array', items: { type: 'string' }, description: '受影响路径列表' } },
    required: ['paths'],
    additionalProperties: false,
  },
  edit: {
    type: 'object',
    properties: {
      expr: str('patch 表达式，如 set scenes[code].camera.tw=0.4'),
      file: str('patch 文件路径（yaml/json）'),
      quote: str('用户原话（必填，逐字引用）'),
      tx: bool('提交事务（缺省为 dry-run）'),
      preview: bool('提交后产出受影响段 4s 预览'),
      id: str('歧义消解：显式元素 id'),
    },
    additionalProperties: false,
  },
  measure: {
    type: 'object',
    properties: {
      metric: str('指标名（density/frame_diff/cam_jitter/...）'),
      scene: str('限定幕 id'),
      range: str('时间窗 [t0:t1]（成片秒）'),
      at: num('单点成片秒'),
      expect: str('期望表达式，如 ">= 0.9 %"'),
      step: num('range 采样步进（秒，默认 0.4；越小越密）'),
    },
    required: ['metric'],
    additionalProperties: false,
  },
  audit: {
    type: 'object',
    properties: { strict: bool('警告升为错误'), step: num('运行时扫描步进（秒，默认 0.25）'), syntaxOnly: bool('只做语法层检查') },
    additionalProperties: false,
  },
  check: {
    type: 'object',
    properties: { id: str('只跑指定断言 id'), noBaseline: bool('跳过基线对比'), step: num('range 采样步进（秒，默认 0.4）') },
    additionalProperties: false,
  },
  baseline: {
    type: 'object',
    properties: { save: bool('保存为基线'), version: str('基线版本名') },
    additionalProperties: false,
  },
  diff: { type: 'object', properties: { a: str('基线 A'), b: str('基线 B') }, required: ['a', 'b'], additionalProperties: false },
  preview: {
    type: 'object',
    properties: {
      at: num('起始成片秒'),
      dur: num('时长秒（3-5s 为法定形态，默认 4）'),
      audio: bool('带音轨（默认 true）'),
      keepFrames: bool('保留中间帧 PNG'),
    },
    required: ['at'],
    additionalProperties: false,
  },
  render: {
    type: 'object',
    properties: {
      range: str('区间 a:b（默认帧；秒用后缀如 0:5s，可混用）；缺省全片'),
      workers: num('并行 worker 数（默认 render.workers）'),
      noCache: bool('忽略缓存'),
      keepFrames: bool('保留中间帧'),
      version: str('输出版本名（如 v0.2）'),
      audio: bool('混流音轨（默认 true）'),
      preset: str('编码档位 preset（ultrafast…veryslow；默认取规格 slow；缓存按档位隔离）'),
    },
    additionalProperties: false,
  },
  verify: {
    type: 'object',
    properties: { file: str('校验指定产物文件'), version: str('校验指定版本（默认 latest）'), shots: bool('抽检关键帧+接缝（默认 true）') },
    additionalProperties: false,
  },
  changelog: {
    type: 'object',
    properties: { since: str('时间过滤（如 2h / 1d / ISO）'), tx: str('指定 txId'), limit: num('条数上限') },
    additionalProperties: false,
  },
  rollback: { type: 'object', properties: { txId: str('要回滚的事务 id') }, required: ['txId'], additionalProperties: false },
  cache: {
    type: 'object',
    properties: {
      action: str('status | gc'),
      maxBytes: num('gc 上限（字节，默认 20GB）'),
      dryRun: bool('gc 仅预演'),
    },
    required: ['action'],
    additionalProperties: false,
  },
  versions: { type: 'object', properties: {}, additionalProperties: false },
  doctor: { type: 'object', properties: { fix: bool('自动修复（重编译 IR/清理索引）') }, additionalProperties: false },
  projects: { type: 'object', properties: { forget: str('移除登记（完整路径或路径片段）') }, additionalProperties: false },
  library: {
    type: 'object',
    properties: {
      action: str('add | list | search | rm | gc | verify | pin | tags'),
      file: str('素材文件（add 用）'),
      kind: str('库类：music|image|video|font|theme|palette|layout|blueprint|preset|sfx-preset|music-preset|xf-suite|widget-pack|kit'),
      name: str('条目标识名（默认取文件名）'),
      ns: str('命名空间：core|ai|usr（默认 usr）'),
      tags: str('标签（空格分隔小写 kebab，≤12 字）'),
      status: str('draft | library'),
      license: str('许可标识（仅记录）'),
      source: str('来源说明（仅记录）'),
      ref: str('引用：library://<id> / @tag / 名称'),
      query: str('search 关键词'),
      force: str('rm 已入册条目需 force'),
      dryRun: str('gc 预演'),
      as: str('pin 落盘文件名'),
    },
    required: ['action'],
    additionalProperties: false,
  },
  music: {
    type: 'object',
    properties: {
      action: str('add | info | analyze | beats | fit'),
      file: str('音频文件（add 用）'),
      ref: str('库引用：library://<id> / @tag'),
      name: str('入库名称'),
      tags: str('标签（空格分隔）'),
      ns: str('命名空间：usr|ai'),
      limit: num('beats 显示条数（默认 32）'),
    },
    required: ['action'],
    additionalProperties: false,
  },
  forge: {
    type: 'object',
    properties: {
      action: str('create | save | list | register'),
      kind: str('theme|palette|layout|blueprint|preset|sfx-preset|music-preset|xf-suite|kit'),
      name: str('作品名'),
      ref: str('引用（register/save 用）'),
      file: str('数据文件（YAML/JSON）'),
      tags: str('标签（空格分隔）'),
      ns: str('命名空间：ai|usr（默认 ai）'),
      visual: bool('register 时跑视觉门槛（黑电平/密度/边缘带）'),
    },
    required: ['action'],
    additionalProperties: false,
  },
  style: {
    type: 'object',
    properties: {
      action: str('apply | show'),
      ref: str('色板引用：library://<id> / @tag / core'),
      tx: bool('提交事务（需 quote）'),
      quote: str('用户原话（--tx 必填）'),
      preview: bool('提交后渲染 4s 预览'),
    },
    required: ['action'],
    additionalProperties: false,
  },
  widgets: {
    type: 'object',
    properties: { action: str('list | info'), name: str('widget 名（info 用）') },
    required: ['action'],
    additionalProperties: false,
  },
  rules: {
    type: 'object',
    properties: { code: str('过滤指定规则码（如 E-COLOR-003）') },
    additionalProperties: false,
  },
};

// 除 init / projects 外（它们的 dir 语义特殊），每个工具都接受可选 dir 覆盖 server 默认工程目录：
// 同一个 kine server 实例即可服务多个工程（配套 CallTool 内的 override 逻辑）。
for (const [key, schema] of Object.entries(ARG_SCHEMAS)) {
  if (key === 'init' || key === 'projects') continue;
  schema.properties.dir = str('工程目录（可选，覆盖服务器默认工程目录；绝对路径或相对 cwd）');
}

function toText(res: ToolResult): string {
  return JSON.stringify(res, null, 2);
}

// dir 解析结果短期记忆（5s）：避免每次工具调用都做目录扫描；显式/默认分开缓存
const dirMemo = new Map<string, { t: number; dir: string; note?: string }>();
function resolveDirMemo(input: string, explicit: boolean): { dir: string; note?: string } {
  const key = `${explicit ? 'E' : 'D'}|${input}`;
  const hit = dirMemo.get(key);
  if (hit && Date.now() - hit.t < 5000) return hit;
  const r = resolveTargetDir(input, { explicit });
  const val = { t: Date.now(), dir: r.dir, note: r.note };
  dirMemo.set(key, val);
  return val;
}

export async function runMcpServer(dir: string): Promise<void> {
  const baseCtx = new AgentContext({ dir, actor: 'mcp', quiet: true });
  const server = new Server(
    { name: 'kine', version: '0.1.0' },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => ({
      name: t.mcp,
      description: t.title,
      inputSchema: (ARG_SCHEMAS[t.name] ?? { type: 'object', properties: {} }) as JsonSchema,
    })),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const name = String(req.params.name ?? '').replace(/^kine\./, '');
    const def = findTool(name);
    if (!def) {
      return { content: [{ type: 'text', text: `未知工具：${req.params.name}（可用：kine.${TOOLS.map((t) => t.name).join(', kine.')}）` }], isError: true };
    }
    // 每次调用可传 dir 覆盖 server 默认工程目录（同一 server 服务多个工程）；init/projects 例外（其 dir 语义特殊）
    const rawArgs = { ...((req.params.arguments ?? {}) as Record<string, unknown>) };
    const hasDirOverride =
      name !== 'init' && name !== 'projects' && typeof rawArgs.dir === 'string' && rawArgs.dir.trim() !== '';
    const dirOverride = hasDirOverride ? String(rawArgs.dir) : undefined;
    if (hasDirOverride) delete rawArgs.dir;
    // 兼容 MCP 客户端把 tags 传成字符串的写法（各工具均为 string[]）
    if (typeof rawArgs.tags === 'string') {
      rawArgs.tags = rawArgs.tags.split(/[\s,]+/).filter(Boolean);
    }
    // dir 解析：显式覆盖→仅祖先查找（相对 KINE_CWD）；无覆盖→沿用 server 启动目录做智能发现
    let resolvedDir: { dir: string; note?: string } | undefined;
    if (name !== 'init' && name !== 'projects') {
      try {
        resolvedDir = dirOverride !== undefined ? resolveDirMemo(dirOverride, true) : resolveDirMemo(dir, false);
      } catch (e) {
        const re = e as ResolveError;
        const payload = {
          ok: false,
          tool: name,
          error: { code: re.code ?? 'E-PROJ-001', message: re.message ?? String(e) },
          facts: re.facts ?? [],
          hints: re.hints ?? [],
        };
        return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }], isError: true };
      }
    }
    const callDir = resolvedDir?.dir ?? dir;
    const progressToken = (req.params as { _meta?: { progressToken?: string | number } })._meta?.progressToken;
    const ctx = progressToken === undefined
      ? (resolvedDir === undefined ? baseCtx : new AgentContext({ dir: callDir, actor: 'mcp', quiet: true }))
      : new AgentContext({
          dir: callDir,
          actor: 'mcp',
          quiet: true,
          progress: (ev) => {
            void server
              .notification({
                method: 'notifications/progress',
                params: {
                  progressToken,
                  progress: ev.pct ?? 0,
                  total: 100,
                  message: `${ev.phase}${ev.message ? ` ${ev.message}` : ''}`,
                },
              })
              .catch(() => undefined);
          },
        });
    try {
      let res = await def.handler(ctx, rawArgs);
      if (resolvedDir?.note && Array.isArray(res.facts)) {
        res = { ...res, facts: [resolvedDir.note, ...res.facts] };
      }
      if (progressToken !== undefined) {
        void server
          .notification({ method: 'notifications/progress', params: { progressToken, progress: 100, total: 100, message: res.ok ? 'done' : 'failed' } })
          .catch(() => undefined);
      }
      return { content: [{ type: 'text', text: toText(res) }], isError: res.ok === false };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { content: [{ type: 'text', text: `工具执行异常：${msg}` }], isError: true };
    }
  });

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      { uri: 'kine://project/info', name: 'kine://project/info', description: '工程信息摘要（project.info 的 data）', mimeType: 'application/json' },
      { uri: 'kine://map', name: 'kine://map', description: '时间对照表（timeline.map 的 data）', mimeType: 'application/json' },
      { uri: 'kine://baseline', name: 'kine://baseline', description: '最近一次基线', mimeType: 'application/json' },
      { uri: 'kine://rules', name: 'kine://rules', description: '全部规则（lint/流程）与修复示例', mimeType: 'application/json' },
      { uri: 'kine://library', name: 'kine://library', description: '用户资源库条目列表', mimeType: 'application/json' },
      { uri: 'kine://widgets', name: 'kine://widgets', description: '内置 widget 列表与默认尺寸', mimeType: 'application/json' },
      { uri: 'kine://music', name: 'kine://music', description: '音乐库条目与最近分析', mimeType: 'application/json' },
    ],
  }));

  server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
    const uri = req.params.uri;
    let payload: unknown;
    if (uri === 'kine://project/info') {
      const res = await findTool('info')!.handler(baseCtx, {});
      payload = res.data;
    } else if (uri === 'kine://map') {
      const res = await findTool('map')!.handler(baseCtx, {});
      payload = res.data;
    } else if (uri === 'kine://baseline') {
      const store = baseCtx.store;
      payload = latestBaseline(store.layout.baselineDir) ?? { note: '尚无基线（kine baseline --save 创建）' };
    } else if (uri === 'kine://rules') {
      payload = { rules: RULES };
    } else if (uri === 'kine://library') {
      const res = await findTool('library')!.handler(baseCtx, { action: 'list' });
      payload = res.data ?? { entries: [] };
    } else if (uri === 'kine://widgets') {
      const res = await findTool('widgets')!.handler(baseCtx, { action: 'list' });
      payload = res.data;
    } else if (uri === 'kine://music') {
      const res = await findTool('library')!.handler(baseCtx, { action: 'list', kind: 'music' });
      payload = res.data ?? { entries: [] };
    } else {
      throw new Error(`未知资源：${uri}`);
    }
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(payload, null, 2) }] };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

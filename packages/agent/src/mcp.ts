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
import { TOOLS, findTool } from './tools';
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
    properties: { id: str('只跑指定断言 id'), noBaseline: bool('跳过基线对比') },
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
      range: str('帧区间 [f0:f1]（缺省全片）'),
      workers: num('并行 worker 数（默认 render.workers）'),
      noCache: bool('忽略缓存'),
      keepFrames: bool('保留中间帧'),
      version: str('输出版本名（如 v0.2）'),
      audio: bool('混流音轨（默认 true）'),
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
};

// 除 init 外（init 的 dir 是「目标工程目录」语义），每个工具都接受可选 dir 覆盖 server 默认工程目录：
// 同一个 kine server 实例即可服务多个工程（配套 CallTool 内的 override 逻辑）。
for (const [key, schema] of Object.entries(ARG_SCHEMAS)) {
  if (key === 'init') continue;
  schema.properties.dir = str('工程目录（可选，覆盖服务器默认工程目录；绝对路径或相对 cwd）');
}

function toText(res: ToolResult): string {
  return JSON.stringify(res, null, 2);
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
    // 每次调用可传 dir 覆盖 server 默认工程目录（同一 server 服务多个工程）；init 例外（其 dir 是「目标目录」语义）
    const rawArgs = { ...((req.params.arguments ?? {}) as Record<string, unknown>) };
    const dirOverride =
      name !== 'init' && typeof rawArgs.dir === 'string' && rawArgs.dir.trim() !== ''
        ? String(rawArgs.dir)
        : undefined;
    if (dirOverride !== undefined) delete rawArgs.dir;
    // 相对路径按用户 cwd 解析（bin launcher 以仓库根为进程 cwd，KINE_CWD 承载用户原始 cwd）
    let callDir = dir;
    if (dirOverride !== undefined) {
      const relBase = process.env.KINE_CWD ?? process.cwd();
      callDir = path.isAbsolute(dirOverride) ? dirOverride : path.resolve(relBase, dirOverride);
      if (!existsSync(callDir)) {
        return {
          content: [{ type: 'text', text: `未知工程目录：${dirOverride}（解析为 ${callDir}，目录不存在）` }],
          isError: true,
        };
      }
    }
    const progressToken = (req.params as { _meta?: { progressToken?: string | number } })._meta?.progressToken;
    const ctx = progressToken === undefined
      ? (dirOverride === undefined ? baseCtx : new AgentContext({ dir: callDir, actor: 'mcp', quiet: true }))
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
      const res = await def.handler(ctx, rawArgs);
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
    } else {
      throw new Error(`未知资源：${uri}`);
    }
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(payload, null, 2) }] };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// cli.ts — kine 命令行入口（人读输出 + --json 机读）
import process from 'node:process';
import path from 'node:path';
import { AgentContext } from './context';
import { TOOLS, findTool, toolNames } from './tools/index';
import { fail, type ToolResult } from './types';
import { runMcpServer } from './mcp';
import { ResolveError, resolveTargetDir, type ResolvedDir } from './resolve';

// ── 极简参数解析：positionals + --flags ──────────────────────────────
interface Parsed {
  pos: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): Parsed {
  const pos: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq >= 0) {
        flags.set(a.slice(2, eq), a.slice(eq + 1));
      } else {
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags.set(key, next);
          i++;
        } else {
          flags.set(key, true);
        }
      }
    } else {
      pos.push(a);
    }
  }
  return { pos, flags };
}

function flagStr(p: Parsed, k: string): string | undefined {
  const v = p.flags.get(k);
  return typeof v === 'string' ? v : undefined;
}
function flagNum(p: Parsed, k: string): number | undefined {
  const v = flagStr(p, k);
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}
function flagBool(p: Parsed, k: string): boolean {
  const v = p.flags.get(k);
  if (v === undefined) return false;
  if (v === true) return true;
  return v === 'true' || v === '1' || v === 'yes';
}
function tagList(s: string | undefined): string[] | undefined {
  if (s === undefined) return undefined;
  const tags = s.split(/[\s,]+/).filter(Boolean);
  return tags.length > 0 ? tags : undefined;
}
// v3 P0-1：range 一律传原始字符串，由工具内 parseRangeSpec 严格校验（旧 rangeArg 静默吞错已移除）

// ── 各命令参数组装 ───────────────────────────────────────────────────
function buildArgs(tool: string, p: Parsed): unknown {
  switch (tool) {
    case 'init':
      return { dir: p.pos[0] ?? '.', template: flagStr(p, 'template') ?? 'mv-mini', force: flagBool(p, 'force') };
    case 'projects':
      return { forget: flagStr(p, 'forget') };
    case 'library':
      return {
        action: p.pos[0] ?? 'list',
        file: flagStr(p, 'file') ?? (p.pos[0] === 'add' ? p.pos[1] : undefined),
        kind: flagStr(p, 'kind'),
        name: flagStr(p, 'name'),
        ns: flagStr(p, 'ns'),
        tags: tagList(flagStr(p, 'tags')),
        status: flagStr(p, 'status'),
        license: flagStr(p, 'license'),
        source: flagStr(p, 'source'),
        ref: flagStr(p, 'ref') ?? p.pos[1],
        query: p.pos.slice(1).join(' ') || undefined,
        force: flagBool(p, 'force'),
        dryRun: flagBool(p, 'dry-run'),
        as: flagStr(p, 'as'),
        dir: flagStr(p, 'dir'),
      };
    case 'music':
      return {
        action: p.pos[0] ?? 'info',
        file: flagStr(p, 'file') ?? (p.pos[0] === 'add' ? p.pos[1] : undefined),
        ref: flagStr(p, 'ref') ?? p.pos[1],
        name: flagStr(p, 'name'),
        tags: tagList(flagStr(p, 'tags')),
        ns: flagStr(p, 'ns'),
        limit: flagNum(p, 'limit'),
      };
    case 'voice':
      return {
        action: p.pos[0] ?? 'list',
        name: flagStr(p, 'name') ?? p.pos[1],
        text: flagStr(p, 'text'),
        file: flagStr(p, 'file'),
        out: flagStr(p, 'out'),
        speed: flagNum(p, 'speed'),
        // 三态：未传 = undefined（用音色档案的 pause_cap）；显式 --normalize false 才是关
        normalize: p.flags.has('normalize') ? flagBool(p, 'normalize') : undefined,
        endpoint: flagStr(p, 'endpoint'),
        gap: flagNum(p, 'gap'),
        lead: flagNum(p, 'lead'),
        peak: flagNum(p, 'peak'),
      };
    case 'forge':
      return {
        action: p.pos[0] ?? 'list',
        kind: flagStr(p, 'kind') ?? p.pos[1],
        name: flagStr(p, 'name') ?? p.pos[2],
        ref: flagStr(p, 'ref') ?? (p.pos[0] === 'save' || p.pos[0] === 'register' ? p.pos[1] : undefined),
        file: flagStr(p, 'file'),
        tags: tagList(flagStr(p, 'tags')),
        ns: flagStr(p, 'ns'),
        visual: flagBool(p, 'visual'),
      };
    case 'style':
      return {
        action: p.pos[0] ?? 'show',
        ref: flagStr(p, 'ref') ?? p.pos[1],
        tx: flagBool(p, 'tx'),
        quote: flagStr(p, 'quote'),
        preview: flagBool(p, 'preview'),
      };
    case 'widgets':
      return { action: p.pos[0] ?? 'list', name: flagStr(p, 'name') ?? p.pos[1] };
    case 'rules':
      return { code: flagStr(p, 'code') ?? p.pos[0] };
    case 'info':
    case 'versions':
      return {};
    case 'compile':
      return { writeIR: flagBool(p, 'write'), strict: flagBool(p, 'strict') };
    case 'map':
      return { t: flagNum(p, 't'), frame: flagNum(p, 'frame'), full: flagBool(p, 'full') };
    case 'probe':
      return { at: flagNum(p, 'at'), hash: flagBool(p, 'hash') };
    case 'find':
      return { query: p.pos.join(' '), scene: flagStr(p, 'scene'), range: flagStr(p, 'range'), kind: flagStr(p, 'kind') };
    case 'explain':
      return { path: p.pos[0] ?? '' };
    case 'impact':
      return { paths: p.pos };
    case 'edit':
      return {
        expr: p.pos.length ? p.pos.join(' ') : undefined,
        file: flagStr(p, 'file'),
        quote: flagStr(p, 'quote') ?? '',
        tx: flagBool(p, 'tx'),
        preview: flagBool(p, 'preview'),
        id: flagStr(p, 'id'),
      };
    case 'layout':
      return { scene: flagStr(p, 'scene'), at: flagNum(p, 'at'), strict: flagBool(p, 'strict') };
    case 'contact':
      return {
        scene: flagStr(p, 'scene'),
        t0: flagNum(p, 't0'),
        t1: flagNum(p, 't1'),
        count: flagNum(p, 'count'),
        cols: flagNum(p, 'cols'),
        cell: flagNum(p, 'cell'),
      };
    case 'measure':
      return { metric: p.pos[0] ?? '', scene: flagStr(p, 'scene'), at: flagNum(p, 'at'), range: flagStr(p, 'range'), expect: flagStr(p, 'expect'), step: flagNum(p, 'step') };
    case 'audit':
      return { strict: flagBool(p, 'strict'), syntaxOnly: flagBool(p, 'syntax-only'), step: flagNum(p, 'step') };
    case 'check':
      return { id: flagStr(p, 'id'), noBaseline: flagBool(p, 'no-baseline'), step: flagNum(p, 'step') };
    case 'baseline':
      return { save: flagBool(p, 'save'), version: flagStr(p, 'version') };
    case 'diff':
      return { a: p.pos[0] ?? '', b: p.pos[1] ?? 'latest' };
    case 'preview':
      return { at: flagNum(p, 'at'), dur: flagNum(p, 'dur'), audio: !flagBool(p, 'no-audio'), keepFrames: flagBool(p, 'keep-frames') };
    case 'render':
      return {
        range: flagStr(p, 'range'),
        preset: flagStr(p, 'preset'),
        workDir: flagStr(p, 'work-dir'),
        workers: flagNum(p, 'workers'),
        noCache: flagBool(p, 'no-cache'),
        keepFrames: flagBool(p, 'keep-frames'),
        version: flagStr(p, 'version'),
        audio: !flagBool(p, 'no-audio'),
      };
    case 'verify':
      return { file: flagStr(p, 'file'), version: flagStr(p, 'version'), shots: !flagBool(p, 'no-shots') };
    case 'changelog':
      return { since: flagStr(p, 'since'), tx: flagStr(p, 'tx'), limit: flagNum(p, 'limit') };
    case 'rollback':
      return { txId: p.pos[0] ?? '' };
    case 'cache':
      return {
        action: (p.pos[0] as 'status' | 'gc') ?? 'status',
        maxBytes: flagNum(p, 'max') !== undefined ? flagNum(p, 'max')! * 1024 ** 3 : undefined,
        workMaxBytes: flagNum(p, 'work-max') !== undefined ? flagNum(p, 'work-max')! * 1024 ** 3 : undefined,
        dryRun: flagBool(p, 'dry-run'),
      };
    case 'doctor':
      return { fix: flagBool(p, 'fix') };
    default:
      return {};
  }
}

// ── 输出 ─────────────────────────────────────────────────────────────
function printResult(tool: string, r: ToolResult, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    return;
  }
  const head = r.verdict ? `${tool} · ${r.verdict}` : tool;
  const out: string[] = [];
  out.push(`== kine ${head} ==`);
  if (r.error) {
    out.push(`✖ ${r.error.code}: ${r.error.message}`);
    if (r.error.where) out.push(`   at: ${typeof r.error.where === 'string' ? r.error.where : JSON.stringify(r.error.where)}`);
  }
  for (const f of r.facts ?? []) out.push(`  ${f}`);
  if (r.hints && r.hints.length) {
    out.push('  -- hints --');
    for (const h of r.hints) out.push(`  · ${h}`);
  }
  if (r.nextActions && r.nextActions.length) {
    out.push('  -- next --');
    for (const na of r.nextActions) out.push(`  → ${na.tool}${na.args ? ' ' + JSON.stringify(na.args) : ''}${na.reason ? `   # ${na.reason}` : ''}`);
  }
  process.stdout.write(out.join('\n') + '\n');
}

function printHelp(): void {
  const lines = [
    'kine — AI 原生确定性视频剪辑/合成',
    '',
    '用法：kine <命令> [参数] [--dir <工程目录>] [--json] [--quiet]',
    '',
    '命令：',
  ];
  for (const t of TOOLS) lines.push(`  ${t.name.padEnd(10)} ${t.title}`);
  lines.push('', '示例：');
  lines.push('  kine map --t 12.5');
  lines.push('  kine edit "set scenes[code].camera.tw=0.5" --tx --quote "代码幕太静了" --preview');
  lines.push('  kine render --range 0:300            # 帧区间（默认按帧）');
  lines.push('  kine render --range 0:5s --preset ultrafast   # 秒区间 + 快速档迭代');
  lines.push('  kine render --workers 4');
  lines.push('', '工程定位：');
  lines.push('  · 不带 --dir 时按顺序解析：当前目录向上找 timeline.yaml → 向下扫描（深度 3）自动发现');
  lines.push('  · 多个候选时取最近使用的工程（kine projects 查看登记表）；全部找不到才报错');
  lines.push('  · 显式 --dir <工程目录> 最精确；kine projects --forget <片段> 清理登记');
  lines.push('', 'edit 说明：');
  lines.push('  · patch 表达式：set <路径>=<值> / del <路径>；路径支持 scenes[id].layers[id].props.size');
  lines.push('  · 数组/对象直接写：set scenes[s].layers[l].props.notes=[220.0, 261.63]（带引号的 "[..]"/"{..}" 会自动去引号）');
  lines.push('  · patch 文件：--file <yaml>，格式 [{path, value}] 或 [{path, del: true}]（或 map 简写）');
  lines.push('  · 无 id 的容器用数字下标（scenes[0].layers[1]）；容器歧义时用 --id 显式消歧');
  lines.push('  · 不带 --tx 为干跑（只出 impact/diff 不落盘）；--quote 为必填的用户原话，可复用同一句');
  process.stdout.write(lines.join('\n') + '\n');
}

// ── 主入口 ───────────────────────────────────────────────────────────
export async function main(argv: string[]): Promise<number> {
  const [maybeTool, ...rest] = argv;
  if (!maybeTool || maybeTool === '--help' || maybeTool === '-h' || maybeTool === 'help') {
    printHelp();
    return 0;
  }
  if (maybeTool === 'mcp') {
    const mcpFlag = argv.includes('--dir') ? flagStr(parseArgs(rest), 'dir') : undefined;
    const mcpBase = process.env.KINE_CWD ?? process.cwd();
    let mcpDir = mcpFlag ? path.resolve(mcpBase, mcpFlag) : mcpBase;
    let mcpVia: 'explicit' | 'ancestor' | 'scan' | 'registry' | 'direct' = mcpFlag ? 'explicit' : 'direct';
    if (mcpFlag === undefined) {
      // 启动时尽力智能发现（祖先→向下扫描→登记表）；失败保留 base，由每次工具调用再试并给出明确报错
      try {
        const rd = resolveTargetDir(undefined, { explicit: false, base: mcpBase });
        mcpDir = rd.dir;
        mcpVia = rd.via ?? 'direct';
      } catch {
        mcpDir = mcpBase;
      }
    }
    await runMcpServer(mcpDir, { via: mcpVia });
    // stdio 服务器：main 永不 resolve，避免外层 process.exit 杀掉服务进程；
    // stdin 关闭（客户端 EOF）后事件循环清空，进程自然退出。
    return new Promise<number>(() => {
      /* keep alive */
    });
  }
  const def = findTool(maybeTool);
  if (!def) {
    process.stderr.write(`未知命令 "${maybeTool}"。可用：${toolNames().join(', ')}\n`);
    return 2;
  }
  const p = parseArgs(rest);
  const dirFlag = flagStr(p, 'dir');
  const userBase = process.env.KINE_CWD ?? process.cwd();
  const json = flagBool(p, 'json');
  const quiet = flagBool(p, 'quiet');

  // 工程目录解析（init/projects 无需工程上下文）：显式 --dir 仅做祖先查找；缺省走智能发现（祖先→向下扫描→登记表）
  let resolvedDir: ResolvedDir;
  if (def.name === 'init' || def.name === 'projects') {
    resolvedDir = { dir: dirFlag ? path.resolve(userBase, dirFlag) : userBase, explicit: dirFlag !== undefined };
  } else {
    try {
      resolvedDir = resolveTargetDir(dirFlag, { explicit: dirFlag !== undefined, base: userBase });
    } catch (e) {
      const re = e as ResolveError;
      const r = fail(def.name, typeof re.code === 'string' ? re.code : 'E-PROJ-001', re.message ?? String(e), {
        facts: re.facts ?? [],
        hints: re.hints ?? [],
      });
      printResult(def.name, r, json);
      return 1;
    }
  }

  const ctx = new AgentContext({
    dir: resolvedDir.dir,
    dirSource: resolvedDir.via ?? 'direct',
    actor: 'cli',
    quiet: quiet || json,
    progress: (ev) => {
      if (!quiet && !json) process.stderr.write(`  [${ev.phase}] ${ev.message}\n`);
    },
  });

  let r: ToolResult;
  try {
    r = await def.handler(ctx, buildArgs(def.name, p) as never);
  } catch (e) {
    const err = e as { code?: string; message?: string; hints?: string[]; facts?: string[] };
    r = {
      ok: false, tool: def.name, data: null, facts: err.facts ?? [],
      error: {
        code: typeof err.code === 'string' && /^E-/.test(err.code) ? err.code : 'E-CLI-001',
        message: err.message ?? String(e),
        hints: err.hints ?? ['这是未捕获的异常，请附带命令上下文反馈'],
      },
    };
  }

  if (resolvedDir.note) r = { ...r, facts: [resolvedDir.note, ...(r.facts ?? [])] };
  printResult(def.name, r, json);
  if (r.ok && r.verdict !== 'FAIL') return 0;
  return 1;
}

const isMain = process.argv[1] && /cli\.(ts|mjs|js)$/.test(process.argv[1]);
if (isMain) {
  main(process.argv.slice(2)).then((code) => process.exit(code)).catch((e) => {
    process.stderr.write(`fatal: ${(e as Error).stack ?? e}\n`);
    process.exit(1);
  });
}

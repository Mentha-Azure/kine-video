// SMOKE-MCP2：验证 MCP 的多工程能力——
//  ① 无 --dir 启动时按启动目录（KINE_CWD / workspace）绑定默认工程；
//  ② 工具调用可传 dir 参数覆盖默认工程目录（init 除外）。
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const cliPath = path.join(repoRoot, 'packages', 'agent', 'src', 'cli.ts');
const mvMini = path.join(repoRoot, 'examples', 'mv-mini');
const doublePace = path.join(repoRoot, 'fixtures', 'double-pace');

const child = spawn(process.execPath, ['--import', 'tsx', cliPath, 'mcp'], {
  cwd: mvMini, // 模拟「在工程目录里启动」；kine.mjs 会把启动目录传给 KINE_CWD
  stdio: ['pipe', 'pipe', 'pipe'],
});

let nextId = 1;
const pending = new Map<number, (v: unknown) => void>();
let buf = '';
child.stdout.on('data', (d) => {
  buf += d.toString('utf8');
  let idx: number;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg: { id?: number; [k: string]: unknown };
    try {
      msg = JSON.parse(line) as { id?: number };
    } catch {
      continue;
    }
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)!(msg);
      pending.delete(msg.id);
    }
  }
});
child.stderr.on('data', (d) => process.stderr.write(`[server stderr] ${d}`));

function rpc(method: string, params: unknown, timeoutMs = 60000): Promise<Record<string, unknown>> {
  const id = nextId++;
  const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`RPC 超时：${method}`));
    }, timeoutMs);
    pending.set(id, (v) => {
      clearTimeout(t);
      resolve(v as Record<string, unknown>);
    });
    child.stdin.write(payload);
  });
}
function notify(method: string, params: unknown): void {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

interface ToolPayload {
  ok?: boolean;
  data?: Record<string, unknown>;
  verdict?: string;
}

async function callTool(name: string, args: unknown): Promise<ToolPayload> {
  const res = await rpc('tools/call', { name, arguments: args }, 180000);
  const result = res['result'] as { content?: { text?: string }[]; isError?: boolean } | undefined;
  const text = result?.content?.[0]?.text ?? '';
  try {
    return JSON.parse(text) as ToolPayload;
  } catch {
    return { ok: false, data: { _raw: text, isError: result?.isError } };
  }
}

function assert(cond: unknown, msg: string): void {
  if (!cond) {
    console.error(`x ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`ok ${msg}`);
  }
}

try {
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'smoke-mcp2', version: '0' },
  });
  const si = (init['result'] as { serverInfo?: { name?: string; version?: string } } | undefined)?.serverInfo;
  console.log(`initialize -> ${si?.name} ${si?.version}`);
  notify('notifications/initialized', {});

  // ① 无 dir 参数：应绑定启动目录（examples/mv-mini）
  const info = await callTool('kine.info', {});
  const infoData = info.data ?? {};
  assert(info.ok === true, `无 dir 参数 -> 绑定启动目录（specHash8=${String(infoData['specHash8'])})`);
  assert(String(infoData['specHash8'] ?? '').startsWith('cfc54762'), '默认工程 = examples/mv-mini（specHash8=cfc54762）');

  // ② dir 覆盖：应切到 fixtures/double-pace（t=5.5 → frame 330 场景 s2）
  const map = await callTool('kine.map', { t: 5.5, dir: doublePace });
  const md = map.data ?? {};
  const sceneObj = md['scene'] as { id?: string } | string | undefined;
  const sceneId = typeof sceneObj === 'string' ? sceneObj : String(sceneObj?.id ?? '');
  assert(
    map.ok === true && md['frame'] === 330 && sceneId === 's2',
    `dir 覆盖 -> double-pace（t=5.5 -> frame=${String(md['frame'])} scene=${sceneId}）`,
  );

  console.log(process.exitCode ? 'SMOKE-MCP2 FAIL' : 'SMOKE-MCP2 OK');
} catch (e) {
  console.error(`SMOKE-MCP2 FAIL：${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  child.kill();
}

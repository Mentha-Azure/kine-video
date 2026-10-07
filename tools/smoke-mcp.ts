// tools/smoke-mcp.ts — MCP 服务器冒烟：spawn cli.ts mcp，走 JSON-RPC stdio 协议
// 验证：initialize → tools/list（22 个）→ tools/call kine.map / kine.probe → resources/read kine://map
import { spawn } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const cliPath = path.join(root, 'packages', 'agent', 'src', 'cli.ts');
const projDir = path.resolve(root, 'examples', 'mv-mini');

interface RpcMsg {
  jsonrpc: string;
  id?: number | string;
  method?: string;
  result?: unknown;
  error?: { code: number; message: string };
}

const child = spawn(process.execPath, ['--import', 'tsx', cliPath, 'mcp', '--dir', projDir], {
  cwd: root,
  stdio: ['pipe', 'pipe', 'pipe'],
});

let buf = '';
const pending = new Map<number, (m: RpcMsg) => void>();
const notifications: RpcMsg[] = [];

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk: string) => {
  buf += chunk;
  let idx: number;
  while ((idx = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    let msg: RpcMsg;
    try {
      msg = JSON.parse(line) as RpcMsg;
    } catch {
      console.error('[smoke-mcp] 非 JSON 行:', line.slice(0, 200));
      continue;
    }
    if (msg.id !== undefined && pending.has(Number(msg.id))) {
      const fn = pending.get(Number(msg.id))!;
      pending.delete(Number(msg.id));
      fn(msg);
    } else {
      notifications.push(msg);
    }
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (c: string) => {
  const s = String(c).trim();
  if (s) console.error('[server stderr]', s.slice(0, 300));
});

let nextId = 1;
function rpc(method: string, params?: unknown, timeoutMs = 120000): Promise<RpcMsg> {
  const id = nextId++;
  const msg = { jsonrpc: '2.0', id, method, params };
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`RPC 超时：${method}`));
    }, timeoutMs);
    pending.set(id, (m) => {
      clearTimeout(t);
      resolve(m);
    });
    child.stdin.write(JSON.stringify(msg) + '\n');
  });
}

function note(method: string, params?: unknown): void {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

function dump(label: string, obj: unknown, max = 600): void {
  const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
  console.log(`${label}: ${s && s.length > max ? s.slice(0, max) + ' …' : s}`);
}

async function main(): Promise<void> {
  const init = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'kine-smoke', version: '0.0.1' },
  });
  if (init.error) throw new Error(`initialize 失败：${init.error.message}`);
  dump('initialize', init.result);
  note('notifications/initialized');

  const tools = (await rpc('tools/list')).result as { tools: { name: string }[] };
  console.log(`tools/list: ${tools.tools.length} 个工具（${tools.tools.slice(0, 4).map((t) => t.name).join(', ')} … ）`);

  const map = (await rpc('tools/call', { name: 'kine.map', arguments: { t: 12 } })).result as {
    content: { text: string }[];
    isError?: boolean;
  };
  const mapPayload = JSON.parse(map.content[0]!.text) as { ok: boolean; data: { t: number; T: number; frame: number; scene: { id: string } } };
  console.log(`kine.map ✓ ok=${mapPayload.ok} t=${mapPayload.data.t} T=${mapPayload.data.T} frame=${mapPayload.data.frame} scene=${mapPayload.data.scene.id}`);

  const probe = (await rpc('tools/call', { name: 'kine.probe', arguments: { at: 12 } }, 180000)).result as {
    content: { text: string }[];
    isError?: boolean;
  };
  const probePayload = JSON.parse(probe.content[0]!.text) as { ok: boolean; data: { scene: { id: string }; elements: unknown[] } };
  console.log(`kine.probe ✓ ok=${probePayload.ok} scene=${probePayload.data.scene.id} elements=${probePayload.data.elements.length}`);

  const resList = (await rpc('resources/list')).result as { resources: { uri: string }[] };
  console.log(`resources/list: ${resList.resources.map((r) => r.uri).join(', ')}`);

  const resRead = (await rpc('resources/read', { uri: 'kine://map' })).result as { contents: { text: string }[] };
  const mapRes = JSON.parse(resRead.contents[0]!.text) as { frames: number };
  console.log(`resources/read kine://map ✓ frames=${mapRes.frames}`);

  child.stdin.end();
  console.log('SMOKE-MCP OK');
}

main()
  .catch((e) => {
    console.error('SMOKE-MCP FAIL:', e instanceof Error ? e.message : e);
    process.exitCode = 1;
  })
  .finally(() => {
    setTimeout(() => {
      child.kill();
      process.exit(process.exitCode ?? 0);
    }, 300);
  });

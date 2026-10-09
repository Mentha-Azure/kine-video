// Kine 用户控制台 — 本地 Web UI（默认 http://127.0.0.1:4747）
// 用途：了解库/工程/磁盘信息；上传音乐入库（自动转 48k + 分析）；浏览资源库（音乐/色板/…）。
// 启动：npx tsx console/server.ts [--port 4747] [--no-open]   （或 pnpm console）
// 说明：仅绑定本机回环地址；写操作只有「音乐入库」「删除条目」两类，均复用 kine 自身能力。
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { createReadStream, existsSync, statfsSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  kineLibraryRoot,
  libraryBlobPath,
  listLibraryEntries,
  removeLibraryEntry,
  resolveLibraryEntry,
  type LibraryEntry,
} from '@kine/store';
import { kineHome, readRegistry } from '@kine/agent';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const kineBin = join(repoRoot, 'packages', 'agent', 'bin', 'kine.mjs');
const uiFile = join(here, 'index.html');

const argv = process.argv.slice(2);
const portArg = argv.indexOf('--port');
const PORT = Number(portArg >= 0 ? argv[portArg + 1] : process.env.KINE_CONSOLE_PORT ?? 4747);
const NO_OPEN = argv.includes('--no-open');
const UPLOAD_LIMIT_MB = 300;
const AUDIO_EXT = new Set(['.wav', '.mp3', '.flac', '.m4a', '.aac', '.ogg', '.opus', '.aiff', '.wma']);

function json(res: ServerResponse, code: number, obj: unknown): void {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function readBody(req: IncomingMessage, limitMb = UPLOAD_LIMIT_MB): Promise<Buffer> {
  return new Promise((res, rej) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limitMb * 1024 * 1024) {
        rej(new Error(`上传超过上限 ${limitMb}MB`));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => res(Buffer.concat(chunks)));
    req.on('error', rej);
  });
}

/** 通过 kine launcher 调 CLI（--json），解析返回体。 */
function runKine(args: string[], timeoutMs = 600_000): { code: number; json: unknown | null; stderr: string } {
  const r = spawnSync(process.execPath, [kineBin, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true,
  });
  const stdout = (r.stdout ?? '').replace(/^\uFEFF/, '');
  let json: unknown | null = null;
  const start = stdout.indexOf('{');
  if (start >= 0) {
    try {
      json = JSON.parse(stdout.slice(start));
    } catch {
      json = null;
    }
  }
  return { code: r.status ?? -1, json, stderr: (r.stderr ?? '').slice(-2000) };
}

function summarize(e: LibraryEntry): Record<string, unknown> {
  const a = (e.analysis ?? {}) as Record<string, unknown>;
  return {
    id: e.id,
    kind: e.kind,
    name: e.name,
    ns: e.ns,
    tags: e.tags,
    status: e.status,
    version: e.version,
    size: e.size ?? null,
    sha256: e.sha256 ? e.sha256.slice(0, 12) : null,
    source: e.source ?? null,
    created: e.created,
    updated: e.updated,
    analysis:
      e.kind === 'music'
        ? {
            duration: a.duration ?? null,
            peakDbfs: a.peakDbfs ?? null,
            rmsDbfs: a.rmsDbfs ?? null,
            bpm: a.bpm ?? null,
            bpmConfidence: a.bpmConfidence ?? null,
            beatsCount: a.beatsCount ?? null,
          }
        : null,
    data: e.kind === 'palette' ? (e.data ?? null) : null,
  };
}

function diskInfo(): Array<{ drive: string; freeGb: number | null; totalGb: number | null }> {
  const out: Array<{ drive: string; freeGb: number | null; totalGb: number | null }> = [];
  for (const d of ['C:\\', 'D:\\']) {
    try {
      const s = statfsSync(d);
      out.push({ drive: d, freeGb: +(s.bavail * s.bsize / 1e9).toFixed(2), totalGb: +(s.blocks * s.bsize / 1e9).toFixed(2) });
    } catch {
      out.push({ drive: d, freeGb: null, totalGb: null });
    }
  }
  return out;
}

function gitHash(): string {
  try {
    const r = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: repoRoot, encoding: 'utf8', windowsHide: true });
    return r.status === 0 ? (r.stdout ?? '').trim() : '';
  } catch {
    return '';
  }
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  const root = kineLibraryRoot();

  // ---- UI
  if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    createReadStream(uiFile).pipe(res);
    return;
  }
  if (path === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ---- 总览
  if (req.method === 'GET' && path === '/api/overview') {
    const entries = listLibraryEntries(root);
    const byKind: Record<string, number> = {};
    for (const e of entries) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    const reg = readRegistry();
    json(res, 200, {
      ok: true,
      data: {
        version: gitHash(),
        kineHome: kineHome(),
        libraryRoot: root,
        total: entries.length,
        byKind,
        disk: diskInfo(),
        projects: reg.projects.slice(0, 30).map((p) => ({
          dir: p.dir,
          title: p.title ?? null,
          lastUsed: p.lastUsed,
          exists: existsSync(join(p.dir, 'timeline.yaml')),
        })),
      },
    });
    return;
  }

  // ---- 库列表（kind / q 过滤）
  if (req.method === 'GET' && path === '/api/library') {
    const kind = url.searchParams.get('kind') ?? undefined;
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    let entries = listLibraryEntries(root, kind ? { kind: kind as never } : {});
    if (q) entries = entries.filter((e) => (e.id + ' ' + e.name + ' ' + e.tags.join(' ')).toLowerCase().includes(q));
    json(res, 200, { ok: true, data: { entries: entries.map(summarize), total: entries.length } });
    return;
  }

  // ---- 音频试听（流式，仅本地）
  if (req.method === 'GET' && path === '/api/audio') {
    const id = url.searchParams.get('id') ?? '';
    const r = resolveLibraryEntry(root, id);
    if (!r.ok || !r.entry.blob || !r.entry.sha256) {
      json(res, 404, { ok: false, error: { code: 'E-LIB-001', message: `音频条目不存在：${id}` } });
      return;
    }
    const file = libraryBlobPath(root, r.entry.sha256);
    if (!existsSync(file)) {
      json(res, 404, { ok: false, error: { code: 'E-LIB-004', message: 'blob 文件缺失（可跑 kine library verify）' } });
      return;
    }
    res.writeHead(200, { 'content-type': 'audio/wav', 'cache-control': 'no-store' });
    createReadStream(file).pipe(res);
    return;
  }

  // ---- 音乐入库（原始字节上传；复用 kine music add：转 48k + 分析 + 内容寻址）
  if (req.method === 'POST' && path === '/api/music/add') {
    const rawName = (url.searchParams.get('filename') ?? 'upload').trim();
    const ext = AUDIO_EXT.has(extname(rawName).toLowerCase()) ? extname(rawName).toLowerCase() : '.bin';
    const name = (url.searchParams.get('name') ?? basename(rawName, extname(rawName))).trim();
    const tags = (url.searchParams.get('tags') ?? '').trim();
    if (!name) {
      json(res, 400, { ok: false, error: { code: 'E-MUSIC-002', message: '缺少 name（条目名）' } });
      return;
    }
    let body: Buffer;
    try {
      body = await readBody(req);
    } catch (e) {
      json(res, 413, { ok: false, error: { code: 'E-MUSIC-003', message: (e as Error).message } });
      return;
    }
    if (body.length === 0) {
      json(res, 400, { ok: false, error: { code: 'E-MUSIC-004', message: '上传内容为空' } });
      return;
    }
    const tmp = join(tmpdir(), `kine-console-${Date.now()}${ext}`);
    try {
      writeFileSync(tmp, body);
      const args = ['music', 'add', tmp, '--name', name, '--json'];
      if (tags) args.splice(args.indexOf('--json'), 0, '--tags', tags);
      const r = runKine(args);
      const parsed = r.json as { ok?: boolean; verdict?: string; facts?: string[]; error?: unknown } | null;
      if (!parsed) {
        json(res, 502, { ok: false, error: { code: 'E-MUSIC-005', message: 'kine music add 未返回 JSON', detail: r.stderr } });
        return;
      }
      json(res, parsed.ok ? 200 : 400, parsed);
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        /* 临时文件清理失败可忽略 */
      }
    }
    return;
  }

  // ---- 删除条目（含 blob 回收）
  if (req.method === 'POST' && path === '/api/library/remove') {
    const id = url.searchParams.get('id') ?? '';
    try {
      const r = await removeLibraryEntry(root, id, { force: true });
      json(res, 200, { ok: true, data: { removed: summarize(r.removed), blobRemoved: r.blobRemoved } });
    } catch (e) {
      const err = e as { code?: string; message?: string };
      json(res, 400, { ok: false, error: { code: err.code ?? 'E-LIB-020', message: err.message ?? String(e) } });
    }
    return;
  }

  // ---- 工程 info（调用 kine info）
  if (req.method === 'POST' && path === '/api/project/info') {
    const dir = url.searchParams.get('dir') ?? '';
    if (!dir) {
      json(res, 400, { ok: false, error: { code: 'E-PROJ-001', message: '缺少 dir' } });
      return;
    }
    const r = runKine(['info', '--dir', dir, '--json'], 120_000);
    if (!r.json) {
      json(res, 502, { ok: false, error: { code: 'E-CLI-001', message: 'kine info 未返回 JSON', detail: r.stderr } });
      return;
    }
    json(res, 200, r.json);
    return;
  }

  json(res, 404, { ok: false, error: { code: 'E-HTTP-404', message: `未知路径 ${path}` } });
}

const server = createServer((req, res) => {
  handle(req, res).catch((e) => {
    try {
      json(res, 500, { ok: false, error: { code: 'E-CONSOLE-001', message: (e as Error).message } });
    } catch {
      /* 已断开 */
    }
  });
});

server.listen(PORT, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${PORT}`;
  console.log(`Kine 控制台已就绪：${url}`);
  console.log(`库根：${kineLibraryRoot()}`);
  if (!NO_OPEN && process.platform === 'win32') {
    try {
      spawn('cmd', ['/c', 'start', '', url], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
    } catch {
      /* 打不开浏览器时手动访问即可 */
    }
  }
});

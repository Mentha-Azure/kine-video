// @kine/store — kine-py sidecar 客户端（stdio JSON 协议，venv 绝对路径 + 启动自检）
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 仓库根目录（packages/store/src → 上三级） */
export function kineRepoRoot(): string {
  return path.resolve(here, '..', '..', '..');
}

export function kinePyDir(): string {
  return path.join(kineRepoRoot(), 'py', 'kine-py');
}

export interface ProtocolMessage {
  id?: number;
  ok?: boolean;
  data?: unknown;
  error?: { code?: string; message?: string };
}

/** 解析一行协议 JSON；-Infinity/Infinity/NaN（python json.dumps 非标准常量）净化重试；无法解析返回 null */
export function parseProtocolLine(line: string, diagnostics?: string[]): ProtocolMessage | null {
  try {
    return JSON.parse(line) as ProtocolMessage;
  } catch {
    try {
      const cleaned = line.replace(/([:,\[\s])(-?Infinity|NaN)\b/g, '$1null');
      const msg = JSON.parse(cleaned) as ProtocolMessage;
      diagnostics?.push(`[pyside] 协议行含非标准 JSON 常量（已净化重试）：${line.slice(0, 160)}`);
      return msg;
    } catch {
      return null;
    }
  }
}

export interface PyInfo {
  version: string;
  versions: { synth: string; metrics: string; env: string; mix: string };
  numpy: string;
  scipy: string;
  pil: string;
}

export interface ResolvedPython {
  python: string;
  source: 'env' | 'venv' | 'system';
}

/** 解释器发现：KINE_PYTHON → py/kine-py/.venv → 系统 python（带 numpy 自检） */
export function resolvePython(pyDir = kinePyDir()): ResolvedPython {
  const envPy = process.env.KINE_PYTHON;
  if (envPy && fs.existsSync(envPy)) return { python: envPy, source: 'env' };
  const venvWin = path.join(pyDir, '.venv', 'Scripts', 'python.exe');
  const venvNix = path.join(pyDir, '.venv', 'bin', 'python');
  if (fs.existsSync(venvWin)) return { python: venvWin, source: 'venv' };
  if (fs.existsSync(venvNix)) return { python: venvNix, source: 'venv' };
  // 系统 python 兜底：必须先通过 numpy/scipy/PIL 自检
  const probe = spawnSync('python', ['-c', 'import numpy,scipy,PIL'], { encoding: 'utf8', timeout: 30000 });
  if (probe.status === 0) return { python: 'python', source: 'system' };
  throw Object.assign(
    new Error('找不到可用的 Python：请先运行 py/kine-py 下的 venv 安装脚本，或设置 KINE_PYTHON 指向含 numpy/scipy/PIL 的解释器'),
    {
      code: 'E-ENV-001',
      hints: [
        `推荐（Windows）：cd ${kinePyDir()} && python -m venv --system-site-packages .venv`,
        '或设置环境变量 KINE_PYTHON=C:\\...\\python.exe（需含 numpy/scipy/PIL）',
      ],
    },
  );
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

const EXPECTED_SYNTH = 'kine-synth/2';

export class KinePy {
  private proc: ChildProcess | null = null;
  private buf = '';
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private stderrTail: string[] = [];
  info: PyInfo | null = null;
  private starting: Promise<void> | null = null;

  constructor(private readonly pyDir = kinePyDir()) {}

  async start(): Promise<void> {
    if (this.proc) return;
    if (this.starting) return this.starting;
    this.starting = this.doStart();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async doStart(): Promise<void> {
    const { python, source } = resolvePython(this.pyDir);
    const entry = path.join(this.pyDir, 'run.py');
    if (!fs.existsSync(entry)) {
      throw Object.assign(new Error(`kine-py 入口不存在：${entry}`), { code: 'E-ENV-002' });
    }
    const proc = spawn(python, ['-u', entry], {
      cwd: this.pyDir,
      env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;
    proc.stdout!.setEncoding('utf8');
    proc.stdout!.on('data', (chunk: string) => this.onData(chunk));
    proc.stderr!.setEncoding('utf8');
    proc.stderr!.on('data', (chunk: string) => {
      this.stderrTail.push(...String(chunk).split('\n').filter(Boolean));
      this.stderrTail = this.stderrTail.slice(-20);
    });
    proc.on('exit', (code) => {
      const err = new Error(`kine-py 进程退出（code=${code}）：${this.stderrTail.slice(-3).join(' | ')}`);
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(err);
      }
      this.pending.clear();
      this.proc = null;
      this.info = null;
    });
    const info = await this.call<PyInfo>('ping', {}, { timeoutMs: 30000 });
    if (info.versions.synth !== EXPECTED_SYNTH) {
      this.close();
      throw Object.assign(new Error(`kine-py 协议版本不匹配：synth=${info.versions.synth}，期待 ${EXPECTED_SYNTH}（双语言漂移防护）`), { code: 'E-ENV-003' });
    }
    this.info = info;
    if (source === 'system') {
      // 允许但提示（规范建议 venv 固定绝对路径）
      console.error(`[kine-py] 警告：使用系统 python（${process.env.KINE_PYTHON ?? 'PATH'}）。建议用 py/kine-py/.venv 固定解释器。`);
    }
  }

  private onData(chunk: string): void {
    this.buf += chunk;
    let idx: number;
    while ((idx = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, idx).trim();
      this.buf = this.buf.slice(idx + 1);
      if (!line) continue;
      const msg = parseProtocolLine(line, this.stderrTail);
      if (!msg) continue; // 非协议行忽略
      const p = msg.id != null ? this.pending.get(msg.id) : undefined;
      if (!p) continue;
      this.pending.delete(msg.id!);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.data);
      else p.reject(Object.assign(new Error(msg.error?.message ?? 'kine-py 未知错误'), { code: msg.error?.code ?? 'E-PY-001', stderr: this.stderrTail.slice(-5) }));
    }
  }

  async call<T>(cmd: string, payload: Record<string, unknown> = {}, opts: { timeoutMs?: number } = {}): Promise<T> {
    if (!this.proc) await this.start(); // 注意：start 内部会调 call('ping')，此处判 proc 避免自等待死锁
    const id = this.nextId++;
    const body = JSON.stringify({ id, cmd, ...payload });
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`kine-py ${cmd} 超时（${opts.timeoutMs ?? 120000}ms）`), { code: 'E-PY-002', stderr: this.stderrTail.slice(-5) }));
      }, opts.timeoutMs ?? 120000);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.proc!.stdin!.write(body + '\n');
    });
  }

  close(): void {
    if (this.proc) {
      try { this.proc.stdin!.end(); } catch { /* ignore */ }
      try { this.proc.kill(); } catch { /* ignore */ }
    }
    this.proc = null;
  }
}

let singleton: KinePy | null = null;

export async function getKinePy(): Promise<KinePy> {
  if (!singleton) singleton = new KinePy();
  await singleton.start();
  return singleton;
}

export function shutdownKinePy(): void {
  singleton?.close();
  singleton = null;
}

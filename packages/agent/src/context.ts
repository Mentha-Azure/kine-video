// @kine/agent — AgentContext：项目定位、IR 编译缓存、日志、进度
import path from 'node:path';
import {
  loadAndCompile, type KineIR, type Issue, type LoadedProject,
} from '@kine/dsl';
import {
  openProject, writeIR, logToolCall, type ProjectStore, type ToolLogEntry,
} from '@kine/store';
import { registerProject } from './resolve';

export interface CompileResult {
  loaded: LoadedProject;
  ir: KineIR;
  issues: Issue[];
  lintIssues: Issue[];
}

export interface AgentContextOptions {
  dir: string;
  actor?: 'cli' | 'mcp' | 'internal';
  quiet?: boolean;
  progress?: (ev: { phase: string; message: string; pct?: number }) => void;
  log?: boolean;
}

export class AgentContext {
  readonly dir: string;
  readonly actor: 'cli' | 'mcp' | 'internal';
  readonly quiet: boolean;
  readonly onProgress?: (ev: { phase: string; message: string; pct?: number }) => void;
  private _store: ProjectStore | null = null;
  private _compileCache: CompileResult | null = null;
  private _log: boolean;

  constructor(opts: AgentContextOptions) {
    this.dir = path.resolve(opts.dir);
    this.actor = opts.actor ?? 'cli';
    this.quiet = opts.quiet ?? false;
    this.onProgress = opts.progress;
    this._log = opts.log ?? true;
  }

  get store(): ProjectStore {
    if (!this._store) {
      this._store = openProject(this.dir);
      registerProject(this._store.root); // 登记全局工程表（默认 dir 解析用）
    }
    return this._store;
  }

  /** 编译（带缓存；写盘时同步写 IR 文件） */
  compile(opts: { fresh?: boolean; writeIR?: boolean; strict?: boolean } = {}): CompileResult {
    if (!opts.fresh && this._compileCache) return this._compileCache;
    const res = loadAndCompile(this.store.layout.timelineFile, {
      strict: opts.strict ?? false,
      projectDir: this.store.root,
    });
    this._compileCache = res;
    if (opts.writeIR) writeIR(this.store, res.ir);
    return res;
  }

  ir(): KineIR {
    return this.compile().ir;
  }

  /** 修改 timeline 后必须清缓存，避免读到旧 IR */
  clearCompileCache(): void {
    this._compileCache = null;
  }

  progress(phase: string, message: string, pct?: number): void {
    if (!this.quiet) this.onProgress?.({ phase, message, pct });
  }

  async logged<T>(tool: string, args: Record<string, unknown>, fn: () => Promise<{ result: T; summary?: string; error?: string }>): Promise<T> {
    const t0 = Date.now();
    try {
      const { result, summary } = await fn();
      this.writeLog(tool, args, { ok: true, ms: Date.now() - t0, resultSummary: summary });
      return result;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.writeLog(tool, args, { ok: false, ms: Date.now() - t0, error: { message: msg } });
      throw e;
    }
  }

  writeLog(tool: string, args: Record<string, unknown>, extra: Partial<ToolLogEntry>): void {
    if (!this._log) return;
    try {
      logToolCall(this.store.layout.logsDir, {
        ts: new Date().toISOString(),
        tool,
        actor: this.actor,
        args: sanitizeArgs(args),
        ok: true,
        ms: 0,
        ...extra,
      });
    } catch { /* 日志失败不阻塞主流程 */ }
  }
}

function sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string' && v.length > 500) out[k] = `${v.slice(0, 500)}…`;
    else out[k] = v;
  }
  return out;
}

/** 找到工程目录（文件或目录皆可） */
export function resolveProjectDir(input: string): string {
  const abs = path.resolve(input);
  const store = openProject(abs);
  return store.root;
}

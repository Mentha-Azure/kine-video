// @kine/agent — 通用工具返回契约（§5.1）
export type Verdict = 'PASS' | 'FAIL' | 'AMBIGUOUS' | 'NEED_INPUT';

export interface ToolError {
  code: string;
  message: string;
  where?: Record<string, unknown>;
  hints?: string[];
}

export interface NextAction {
  tool: string;
  args?: Record<string, unknown>;
  reason?: string;
}

export interface ToolResult<T = unknown> {
  ok: boolean;
  tool: string;
  data: T | null;
  verdict?: Verdict;
  /** 可直接引用的实测事实（含数值与单位） */
  facts: string[];
  hints?: string[];
  nextActions?: NextAction[];
  error?: ToolError;
  truncated?: boolean;
  total?: number;
}

export function ok<T>(tool: string, data: T, extra: Partial<ToolResult<T>> = {}): ToolResult<T> {
  return { ok: true, tool, data, facts: extra.facts ?? [], ...extra };
}

export function fail(tool: string, code: string, message: string, extra: Partial<ToolResult<unknown>> = {}): ToolResult<never> {
  return {
    ok: false,
    tool,
    data: (extra.data ?? null) as never,
    facts: extra.facts ?? [],
    error: { code, message, ...(extra.error ?? {}) },
    hints: extra.hints,
    nextActions: extra.nextActions,
    verdict: extra.verdict,
  };
}

export interface AmbiguityOption {
  label: string;
  id: string;
  facts: string[];
}

export function ambiguous(tool: string, question: string, options: AmbiguityOption[]): ToolResult<{ question: string; options: AmbiguityOption[] }> {
  return {
    ok: true,
    tool,
    data: { question, options },
    verdict: 'AMBIGUOUS',
    facts: options.map((o) => `${o.id}: ${o.facts.join(' / ')}`),
    hints: ['歧义协议：向用户转呈选项，得到明确选择后用 --id 显式重调'],
  };
}

export function needInput(tool: string, message: string, hints: string[] = []): ToolResult<null> {
  return { ok: true, tool, data: null, verdict: 'NEED_INPUT', facts: [message], hints };
}

/** 分页截断辅助 */
export function paginate<T>(items: T[], offset = 0, limit = 50): { page: T[]; truncated: boolean; total: number } {
  const total = items.length;
  const page = items.slice(offset, offset + limit);
  return { page, truncated: offset + limit < total, total };
}

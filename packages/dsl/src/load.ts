// @kine/dsl — YAML 装载：语法解析、行号映射、schema 校验（E-SCHEMA-00x 带行号）
import { readFileSync } from 'node:fs';
import YAML from 'yaml';
import { LineCounter, type Document, isMap, isSeq, isScalar } from 'yaml';
import { ProjectSpec, type ProjectSpecT } from './schema';
import type { Issue } from './errors';

export interface LineLookup {
  (path: (string | number)[]): number | undefined;
}

export interface LoadedProject {
  file: string;
  src: string;
  /** 原始 JS 对象（保留未知字段，供 edit/patch 回写） */
  raw: Record<string, unknown>;
  /** 校验+默认值填充后的规格 */
  spec: ProjectSpecT;
  lineOf: LineLookup;
}

function keyOf(path: (string | number)[]): string {
  return path.map((p) => String(p)).join('\u0001');
}

/** 构建 索引路径 → 行号 映射（1-based 行） */
export function buildLineIndex(doc: Document.Parsed, lineCounter: LineCounter): LineLookup {
  const lines = new Map<string, number>();
  const walk = (node: unknown, path: (string | number)[]): void => {
    if (!node || typeof node !== 'object') return;
    const n = node as { range?: [number, number, number]; items?: unknown[]; value?: unknown };
    if (n.range && path.length > 0) {
      try {
        lines.set(keyOf(path), lineCounter.linePos(n.range[0]).line);
      } catch { /* ignore */ }
    }
    if (isMap(n as never)) {
      for (const item of (n as never as { items: { key: unknown; value: unknown }[] }).items) {
        const k = (item.key as { value?: unknown }).value;
        if (k == null) continue;
        walk(item.value, [...path, String(k)]);
      }
    } else if (isSeq(n as never)) {
      const items = (n as never as { items: unknown[] }).items;
      items.forEach((it, i) => walk(it, [...path, i]));
    }
  };
  walk(doc.contents, []);
  return (path) => lines.get(keyOf(path));
}

export interface ParsedYaml {
  doc: Document.Parsed | null;
  raw: Record<string, unknown> | null;
  lineOf: LineLookup;
  issues: Issue[];
}

export function parseYamlWithLines(src: string, file: string): ParsedYaml {
  const lineCounter = new LineCounter();
  const issues: Issue[] = [];
  let doc: Document.Parsed | null = null;
  try {
    doc = YAML.parseDocument(src, { lineCounter, keepSourceTokens: false });
  } catch (e) {
    issues.push({
      code: 'E-SCHEMA-001',
      severity: 'error',
      message: `YAML 语法错误：${(e as Error).message}`,
      where: { file },
    });
    return { doc: null, raw: null, lineOf: () => undefined, issues };
  }
  for (const e of doc.errors) {
    const pos = e.pos?.[0] ?? 0;
    let line: number | undefined;
    try { line = lineCounter.linePos(pos).line; } catch { /* ignore */ }
    issues.push({
      code: 'E-SCHEMA-001',
      severity: 'error',
      message: `YAML 语法错误：${e.message}`,
      where: { file, line },
    });
  }
  const lineOf = buildLineIndex(doc, lineCounter);
  let raw: Record<string, unknown> | null = null;
  try {
    raw = (doc.toJS() ?? null) as Record<string, unknown> | null;
  } catch (e) {
    issues.push({ code: 'E-SCHEMA-001', severity: 'error', message: `YAML 解析失败：${(e as Error).message}`, where: { file } });
  }
  return { doc, raw, lineOf, issues };
}

const SCHEMA_CODE: Record<string, string> = {
  invalid_type: 'E-SCHEMA-002',
  invalid_value: 'E-SCHEMA-004',
  invalid_format: 'E-SCHEMA-004',
  too_big: 'E-SCHEMA-004',
  too_small: 'E-SCHEMA-004',
  invalid_union: 'E-SCHEMA-004',
  invalid_key: 'E-SCHEMA-001',
  unrecognized_keys: 'W-SCHEMA-001',
  custom: 'E-SCHEMA-004',
};

export function zodIssuesToIssues(errors: { issues: readonly { code: string; message: string; path: PropertyKey[] }[] }, file: string, lineOf: LineLookup): Issue[] {
  return errors.issues.map((i) => {
    const code = SCHEMA_CODE[i.code] ?? 'E-SCHEMA-001';
    const path = i.path.map((p) => (typeof p === 'number' ? p : String(p)));
    const wanted = code === 'E-SCHEMA-002'
      ? '与 kine/1 规定的类型不符'
      : code === 'E-SCHEMA-004'
        ? '取值超出 kine/1 允许范围'
        : '字段不合 kine/1 规定';
    return {
      code,
      severity: code === 'W-SCHEMA-001' ? 'warn' : 'error',
      message: `字段 ${path.join('.') || '(根)'} ${wanted}：${i.message}`,
      where: { file, line: lineOf(path), path: path.join('.') },
      hints: [`对照 03-时间轴DSL规范.md / kine schema --json 的定义`],
    };
  });
}

export function validateProject(raw: unknown, file: string, lineOf: LineLookup): { spec?: ProjectSpecT; issues: Issue[] } {
  const res = ProjectSpec.safeParse(raw);
  if (res.success) return { spec: res.data, issues: [] };
  return { issues: zodIssuesToIssues(res.error, file, lineOf) };
}

export function loadProject(file: string): LoadedProject {
  const src = readFileSync(file, 'utf8');
  const parsed = parseYamlWithLines(src, file);
  const issues: Issue[] = [...parsed.issues];
  if (!parsed.raw) {
    const e = issues[0] ?? { code: 'E-SCHEMA-001' as const, severity: 'error' as const, message: '文件为空', where: { file } };
    throw Object.assign(new Error(`${e.code}: ${e.message}`), { issues });
  }
  const { spec, issues: vIssues } = validateProject(parsed.raw, file, parsed.lineOf);
  issues.push(...vIssues);
  const errors = issues.filter((i) => i.severity === 'error');
  if (!spec || errors.length > 0) {
    const e = new Error(errors.map((i) => `${i.code} ${i.message}${i.where?.line ? ` (行 ${i.where.line})` : ''}`).join('\n'));
    throw Object.assign(e, { issues });
  }
  return { file, src, raw: parsed.raw, spec, lineOf: parsed.lineOf };
}

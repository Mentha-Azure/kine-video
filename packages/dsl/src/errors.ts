// @kine/dsl — 错误与诊断（错误码表见 05-Agent接口规范 §5.7）
export interface IssueWhere {
  file?: string;
  line?: number;
  path?: string;
  t?: number;
  T?: number;
  scene?: string;
}

export interface Issue {
  code: string;
  message: string;
  severity: 'error' | 'warn';
  where?: IssueWhere;
  hints?: string[];
  facts?: string[];
}

export class KineError extends Error {
  code: string;
  severity: 'error' | 'warn';
  where?: IssueWhere;
  hints: string[];
  facts: string[];
  constructor(issue: Issue) {
    super(`${issue.code}: ${issue.message}`);
    this.name = 'KineError';
    this.code = issue.code;
    this.severity = issue.severity;
    this.where = issue.where;
    this.hints = issue.hints ?? [];
    this.facts = issue.facts ?? [];
  }
  toIssue(): Issue {
    return {
      code: this.code,
      message: this.message.replace(/^.*?: /, ''),
      severity: this.severity,
      where: this.where,
      hints: this.hints,
      facts: this.facts,
    };
  }
}

export function err(issue: Issue): KineError {
  return new KineError(issue);
}

/** 行号映射：把 zod 的 path 数组转成索引路径串，用于查询行号 */
export function pathToKey(path: (string | number)[]): string {
  return path.join('.');
}

export function fmtIssue(i: Issue, file?: string): string {
  const loc = i.where?.line != null ? `${i.where.file ?? file ?? ''}:${i.where.line}` : (i.where?.file ?? file ?? '');
  const parts = [loc ? `${loc} ` : '', `${i.code} ${i.message}`];
  if (i.where?.path) parts.push(` (at ${i.where.path})`);
  let s = parts.join('');
  if (i.facts?.length) s += '\n      facts: ' + i.facts.join(' | ');
  if (i.hints?.length) s += '\n      hints: ' + i.hints.join(' | ');
  return s;
}

// @kine/dsl — JSONPath-ish patch（edit 事务的底层操作）
// 语法： set scenes[title].layers[glitch_title].props.flash_period = 0.32 / del path
import YAML from 'yaml';
import { err } from './errors';

export interface PatchOp {
  op: 'set' | 'del';
  path: string;
  value?: unknown;
}

export interface PatchDiff {
  op: 'set' | 'del';
  /** 显示路径（保留原选择器写法） */
  path: string;
  from?: unknown;
  to?: unknown;
}

export interface AppliedPatch {
  diff: PatchDiff;
}

type Tok = { t: 'key'; k: string } | { t: 'sel'; s: string };

export function tokenizePath(path: string): Tok[] {
  const toks: Tok[] = [];
  const re = /([^.[\]]+)|\[([^\]]*)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path))) {
    if (m[1] !== undefined) toks.push({ t: 'key', k: m[1] });
    else if (m[2] !== undefined) toks.push({ t: 'sel', s: m[2] });
  }
  if (toks.length === 0) throw err({ code: 'E-TX-001', severity: 'error', message: `patch 路径为空或非法：${path}` });
  // 归一：key 后紧跟 sel 不合法（应为 key[sel]）；sel 必须是数组访问
  return toks;
}

function isArtifact(v: unknown): v is { id: string } {
  return !!v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string';
}

function resolveArrayIndex(arr: unknown[], sel: string, path: string): number {
  if (/^\d+$/.test(sel)) {
    const i = parseInt(sel, 10);
    if (i >= 0 && i < arr.length) return i;
    throw err({ code: 'E-TX-004', severity: 'error', message: `patch 目标不存在：${path}（数组下标 ${i} 越界，长度 ${arr.length}）` });
  }
  const i = arr.findIndex((it) => isArtifact(it) && it.id === sel);
  if (i >= 0) return i;
  const cands = arr.filter(isArtifact).map((it) => it.id);
  throw err({
    code: 'E-TX-004',
    severity: 'error',
    message: `patch 目标不存在：${path} 中未找到 id="${sel}"`,
    facts: [`候选 id：${cands.join(', ') || '(无)'}`],
    hints: ['先用 kine find 确认元素 id', '若为歧义匹配（多个近义元素），用 --id 显式指定'],
  });
}

function resolveParent(doc: unknown, toks: Tok[], path: string): { parent: unknown; last: Tok } {
  let cur: unknown = doc;
  for (let i = 0; i < toks.length - 1; i++) {
    const tok = toks[i];
    if (tok.t === 'key') {
      if (cur == null || typeof cur !== 'object' || Array.isArray(cur)) {
        throw err({
          code: 'E-TX-004',
          severity: 'error',
          message: `patch 路径无效：${path} 在 ${tok.k} 处期望对象`,
          hints: ['patch 不会自动创建中间对象：请对存在的父对象整体 set，如 set scenes[code].post = { flash: 0.032 }'],
        });
      }
      cur = (cur as Record<string, unknown>)[tok.k];
      if (cur === undefined) {
        throw err({
          code: 'E-TX-004',
          severity: 'error',
          message: `patch 目标不存在：${path} 中字段 ${tok.k} 未定义`,
          hints: [
            'patch 不会自动创建中间对象：请对存在的父对象整体 set，如 set scenes[code].post = { flash: 0.032 }',
            '或先用空对象占位：set scenes[code].post = {}，再逐字段 set（后一步即可命中）',
          ],
        });
      }
    } else {
      if (!Array.isArray(cur)) {
        throw err({ code: 'E-TX-004', severity: 'error', message: `patch 路径无效：${path} 在 [${tok.s}] 处期望数组` });
      }
      cur = cur[resolveArrayIndex(cur, tok.s, path)];
    }
  }
  return { parent: cur, last: toks[toks.length - 1] };
}

function readAt(parent: unknown, last: Tok, path: string): unknown {
  if (last.t === 'key') {
    if (parent == null || typeof parent !== 'object' || Array.isArray(parent)) return undefined;
    return (parent as Record<string, unknown>)[last.k];
  }
  if (!Array.isArray(parent)) return undefined;
  const i = resolveArrayIndex(parent, last.s, path);
  return parent[i];
}

export function applyPatch(doc: Record<string, unknown>, op: PatchOp): PatchDiff {
  const toks = tokenizePath(op.path);
  const { parent, last } = resolveParent(doc, toks, op.path);
  const from = op.op === 'set' ? readAt(parent, last, op.path) : undefined;

  if (last.t === 'key') {
    if (parent == null || typeof parent !== 'object' || Array.isArray(parent)) {
      throw err({ code: 'E-TX-004', severity: 'error', message: `patch 路径无效：${op.path} 的父节点不是对象` });
    }
    const obj = parent as Record<string, unknown>;
    if (op.op === 'set') {
      const prev = obj[last.k];
      obj[last.k] = op.value;
      return { op: 'set', path: op.path, from: prev, to: op.value };
    }
    const prev = obj[last.k];
    delete obj[last.k];
    return { op: 'del', path: op.path, from: prev, to: undefined };
  }
  if (!Array.isArray(parent)) {
    throw err({ code: 'E-TX-004', severity: 'error', message: `patch 路径无效：${op.path} 的父节点不是数组` });
  }
  const i = resolveArrayIndex(parent, last.s, op.path);
  const prev = parent[i];
  if (op.op === 'set') {
    parent[i] = op.value;
    return { op: 'set', path: op.path, from: prev, to: op.value };
  }
  parent.splice(i, 1);
  return { op: 'del', path: op.path, from: prev, to: undefined };
}

export function reversePatch(diff: PatchDiff): PatchOp {
  if (diff.op === 'set') {
    return diff.from === undefined
      ? { op: 'del', path: diff.path }
      : { op: 'set', path: diff.path, value: diff.from };
  }
  return { op: 'set', path: diff.path, value: diff.from };
}

/** 解析 "set a.b[c]=1" / "del x" 行 */
export function parsePatchExpr(expr: string): PatchOp {
  const s = expr.trim();
  const m = s.match(/^(set|del)\s+([\s\S]+)$/);
  if (!m) {
    throw err({
      code: 'E-TX-001',
      severity: 'error',
      message: `无法解析 patch：${expr}`,
      hints: ['格式：set scenes[id].layers[id].props.key = value 或 del path'],
    });
  }
  const op = m[1] as 'set' | 'del';
  const rest = m[2];
  if (op === 'del') return { op, path: rest.trim() };
  const eq = findAssignEq(rest);
  if (eq < 0) {
    throw err({ code: 'E-TX-001', severity: 'error', message: `set 缺少 "=" 赋值：${expr}` });
  }
  const path = rest.slice(0, eq).trim();
  let valueText = rest.slice(eq + 1).trim();
  // v3 P1-2：值为「带引号的数组/对象」时先去引号再解析（否则 YAML 视作字符串——如 "[220.0, 261.63]"）
  if (
    valueText.length >= 2 &&
    ((valueText.startsWith('"') && valueText.endsWith('"')) || (valueText.startsWith("'") && valueText.endsWith("'")))
  ) {
    const inner = valueText.slice(1, -1).trim();
    if (inner.startsWith('[') || inner.startsWith('{')) valueText = inner;
  }
  return { op, path, value: parseValue(valueText) };
}

function findAssignEq(s: string): number {
  let inS = false, inD = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'" && !inD) inS = !inS;
    else if (c === '"' && !inS) inD = !inD;
    else if (c === '=' && !inS && !inD) return i;
  }
  return -1;
}

export function parseValue(text: string): unknown {
  const t = text.trim();
  if (t === '') return '';
  try {
    const v = YAML.parse(t);
    if (typeof v === 'string' && v === t) return v;
    return v;
  } catch {
    return t;
  }
}

/** 加载 --file patch.yaml（支持 [{path,value}|{path,del}] 或 map 简写） */
export function parsePatchFile(src: string): PatchOp[] {
  const doc = YAML.parse(src);
  const ops: PatchOp[] = [];
  if (Array.isArray(doc)) {
    for (const it of doc) {
      if (!it || typeof it !== 'object' || !('path' in it)) {
        throw err({ code: 'E-TX-001', severity: 'error', message: 'patch 文件条目必须为 {path, value} 或 {path, del: true}' });
      }
      const rec = it as { path: string; value?: unknown; del?: boolean; op?: string };
      if (rec.del || rec.op === 'del') ops.push({ op: 'del', path: rec.path });
      else if (rec.value === undefined && rec.path.includes('=')) ops.push(parsePatchExpr(rec.path));
      else ops.push({ op: 'set', path: rec.path, value: rec.value ?? '' });
    }
    return ops;
  }
  if (doc && typeof doc === 'object') {
    for (const [k, v] of Object.entries(doc as Record<string, unknown>)) {
      if (v === null) ops.push({ op: 'del', path: k });
      else ops.push({ op: 'set', path: k, value: v });
    }
    return ops;
  }
  throw err({ code: 'E-TX-001', severity: 'error', message: 'patch 文件内容必须是列表或键值表' });
}

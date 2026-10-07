// @kine/store — 事务：dry-run 暂存（stage）→ 影响分析 → 提交（backup + 原子写 + changelog）→ 回滚
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import {
  applyPatch,
  parseTargetPath,
  parseYamlWithLines,
  validateProject,
  reversePatch,
  type Issue,
  type ParsedTarget,
  type PatchDiff,
  type PatchOp,
} from '@kine/dsl';
import { appendChangelog, findEntry, nextTxId, type ChangelogEntry } from './changelog';
import { atomicWriteFile, tsStamp } from './layout';
import { withLock } from './locks';
import type { ProjectStore } from './project';

export interface StagedEdit {
  txId: string;
  ops: PatchOp[];
  diffs: PatchDiff[];
  rawAfter: Record<string, unknown>;
  /** 暂存后的 timeline.yaml 全文 */
  yaml: string;
  /** 暂存版本自身的校验问题（error 级存在则不应提交） */
  issues: Issue[];
  targets: ParsedTarget[];
  target: { path: string; id?: string; scene?: string };
  /** 人读 patch 摘要（逐行） */
  summary: string[];
}

function fmtVal(v: unknown): string {
  if (v === undefined) return '(未定义)';
  if (typeof v === 'string') return JSON.stringify(v);
  if (v === null) return 'null';
  return JSON.stringify(v);
}

function summarize(diffs: PatchDiff[]): string[] {
  return diffs.map((d) => (d.op === 'del' ? `${d.path}: ${fmtVal(d.from)} → (删除)` : `${d.path}: ${fmtVal(d.from)} → ${fmtVal(d.to)}`));
}

function pickTarget(diffs: PatchDiff[], ops: PatchOp[]): { path: string; id?: string; scene?: string } {
  const first = ops[0]?.path ?? diffs[0]?.path ?? '(空)';
  const t = parseTargetPath(first);
  return { path: first, id: t.layerId, scene: t.sceneId };
}

/** 阶段一：dry-run 暂存（不改任何文件） */
export function stageEdit(store: ProjectStore, ops: PatchOp[], opts: { txId?: string } = {}): StagedEdit {
  if (ops.length === 0) {
    throw Object.assign(new Error('patch 为空：没有要应用的改动'), { code: 'E-TX-001' });
  }
  const loaded = store.load();
  const rawAfter = structuredClone(loaded.raw) as Record<string, unknown>;
  const diffs: PatchDiff[] = [];
  for (const op of ops) {
    diffs.push(applyPatch(rawAfter, op));
  }
  const yaml = YAML.stringify(rawAfter, { lineWidth: 0 });
  const parsed = parseYamlWithLines(yaml, store.layout.timelineFile);
  const v = validateProject(parsed.raw, store.layout.timelineFile, parsed.lineOf);
  const issues: Issue[] = [...parsed.issues, ...v.issues];
  const targets = ops.map((o) => parseTargetPath(o.path));
  return {
    txId: opts.txId ?? nextTxId(store.layout.changelogFile),
    ops,
    diffs,
    rawAfter,
    yaml,
    issues,
    targets,
    target: pickTarget(diffs, ops),
    summary: summarize(diffs),
  };
}

export interface CommitOptions {
  quote: string;
  tool?: string;
  impact?: { invalidates: string[]; kept: string[] };
  preview?: string | null;
  checks?: { audit?: string; check?: string };
  specHashBefore?: string;
  specHashAfter?: string;
}

/** 阶段二：提交（backup 先写 → 原子替换 → changelog 追加）。全程持锁。 */
export async function commitEdit(store: ProjectStore, stage: StagedEdit, opts: CommitOptions): Promise<ChangelogEntry> {
  if (!opts.quote || !opts.quote.trim()) {
    throw Object.assign(new Error('缺少 --quote 用户原话：事务拒绝执行'), { code: 'E-TX-002' });
  }
  const errs = stage.issues.filter((i) => i.severity === 'error');
  if (errs.length > 0) {
    throw Object.assign(new Error(`暂存版本校验失败（${errs.length} 个错误），拒绝提交：${errs[0].code} ${errs[0].message}`), { code: 'E-TX-003', issues: errs });
  }
  return withLock(store.layout.locksDir, 'timeline', () => {
    const ts = new Date().toISOString();
    const backupFile = path.join(store.layout.backupDir, `${tsStamp()}_${stage.txId}.yaml`);
    atomicWriteFile(backupFile, fs.readFileSync(store.layout.timelineFile));
    atomicWriteFile(store.layout.timelineFile, stage.yaml);
    const entry: ChangelogEntry = {
      tx: stage.txId,
      ts,
      tool: opts.tool ?? 'kine.edit',
      quote: opts.quote,
      patch: stage.summary.join('; '),
      target: stage.target,
      impact: opts.impact,
      preview: opts.preview ?? null,
      checks: opts.checks,
      rollbackOf: null,
      details: {
        ops: stage.ops,
        diffs: stage.diffs,
        backupFile,
        specHashBefore: opts.specHashBefore,
        specHashAfter: opts.specHashAfter,
      },
    };
    appendChangelog(store.layout.changelogFile, entry);
    return entry;
  });
}

export interface RollbackResult {
  rolledBack: ChangelogEntry;
  entry: ChangelogEntry;
}

/** 阶段三：回滚（优先 backup 还原；无 backup 则反向 patch），写入新 changelog 条目 */
export async function rollbackEdit(store: ProjectStore, txId: string, opts: { tool?: string } = {}): Promise<RollbackResult> {
  const target = findEntry(store.layout.changelogFile, txId);
  if (!target) {
    throw Object.assign(new Error(`找不到事务 ${txId}`), {
      code: 'E-TX-005',
      hints: ['用 kine changelog 查看可用事务列表'],
    });
  }
  return withLock(store.layout.locksDir, 'timeline', () => {
    const ts = new Date().toISOString();
    const newTx = nextTxId(store.layout.changelogFile);
    const backupFile = path.join(store.layout.backupDir, `${tsStamp()}_${newTx}.yaml`);
    atomicWriteFile(backupFile, fs.readFileSync(store.layout.timelineFile));

    let restoredFrom: string;
    const srcBackup = target.details?.backupFile as string | undefined;
    if (srcBackup && fs.existsSync(srcBackup)) {
      atomicWriteFile(store.layout.timelineFile, fs.readFileSync(srcBackup));
      restoredFrom = `backup ${path.basename(srcBackup)}`;
    } else {
      // 反向 patch 路径
      const loaded = store.load();
      const raw = structuredClone(loaded.raw) as Record<string, unknown>;
      const diffs = (target.details?.diffs ?? []) as PatchDiff[];
      for (const d of [...diffs].reverse()) {
        applyPatch(raw, reversePatch(d));
      }
      atomicWriteFile(store.layout.timelineFile, YAML.stringify(raw, { lineWidth: 0 }));
      restoredFrom = '反向 patch';
    }

    const entry: ChangelogEntry = {
      tx: newTx,
      ts,
      tool: opts.tool ?? 'kine.rollback',
      quote: `回滚 ${txId}`,
      patch: `恢复至 ${txId} 变更前（${restoredFrom}）`,
      target: target.target,
      rollbackOf: txId,
      details: { backupFile, restoredFrom },
    };
    appendChangelog(store.layout.changelogFile, entry);
    return { rolledBack: target, entry };
  });
}

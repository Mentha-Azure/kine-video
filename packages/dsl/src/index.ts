// @kine/dsl — 公共入口
import { dirname, resolve } from 'node:path';
export * from './schema';
export * from './errors';
export * from './hash';
export * from './time';
export * from './load';
export * from './compile';
export * from './deps';
export * from './patch';
export * from './lint';
export * from './rand';
export * from './camera';
export * from './library';
export * from './srt';
export * from './palette';

import { compile, type CompileResult } from './compile';
import { loadProject, type LoadedProject } from './load';
import { lint, type LintOptions } from './lint';
import { pointAt } from './time';
import type { Issue } from './errors';
import { KineError } from './errors';
import type { ProjectSpecT } from './schema';
import type { TimeMap } from './time';

export interface FullCompileResult extends CompileResult {
  loaded: LoadedProject;
  lintIssues: Issue[];
}

/**
 * loadProject + compile + lint 一站式（agent 各工具的统一入口）
 * 注意：projectDir 缺省时取 timeline.yaml 所在目录（而非 cwd）——保证 hash 与资源解析
 * 与调用位置无关（第 N 帧 = f(N) 唯一确定的一部分：工程身份不随 cwd 漂移）。
 */
export function loadAndCompile(file: string, opts?: { strict?: boolean; projectDir?: string }): FullCompileResult {
  const loaded = loadProject(file);
  const projectDir = opts?.projectDir ?? dirname(resolve(file));
  const { ir, issues } = compile(loaded.spec, { projectDir });
  const lintIssues = lint(loaded.spec, loaded.raw, {
    file,
    lineOf: loaded.lineOf,
    strict: opts?.strict,
  } as LintOptions);
  return { ir, issues, loaded, lintIssues };
}

export function throwIfErrors(issues: Issue[]): void {
  const errors = issues.filter((i) => i.severity === 'error');
  if (errors.length > 0) {
    const e = new KineError(errors[0]);
    (e as KineError & { allIssues?: Issue[] }).allIssues = errors;
    throw e;
  }
}

/** t ↔ T 双向映射快照（agent 工具统一走此函数） */
export function mapPoint(map: TimeMap, t: number) {
  return pointAt(map, t);
}

export type { ProjectSpecT };

// tests/resolve.test.ts — 默认 dir 解析与工程登记表（第三轮反馈 P1）
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ResolveError, readRegistry, registerProject, resolveTargetDir, scanForProjects, writeRegistry } from '@kine/agent';

const tmpDirs: string[] = [];
let oldHome: string | undefined;

function mkTmp(prefix: string): string {
  const d = mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
}

function mkProject(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'timeline.yaml'), 'schema: kine/1\nproject: { id: probe, title: probe }\n', 'utf8');
}

function expectResolveError(fn: () => unknown, code: string): ResolveError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ResolveError);
    const re = e as ResolveError;
    expect(re.code).toBe(code);
    return re;
  }
  throw new Error(`期望抛出 ResolveError(${code}) 但未抛出`);
}

beforeEach(() => {
  oldHome = process.env.KINE_HOME;
  process.env.KINE_HOME = mkTmp('kine-home-');
});

afterEach(() => {
  if (oldHome === undefined) delete process.env.KINE_HOME;
  else process.env.KINE_HOME = oldHome;
  for (const d of tmpDirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('scanForProjects', () => {
  it('深度 3 内命中、跳过 node_modules 与点目录、超深度不找', () => {
    const ws = mkTmp('kine-ws-');
    mkProject(path.join(ws, 'a'));
    mkProject(path.join(ws, 'b', 'c'));
    mkProject(path.join(ws, 'node_modules', 'pkg'));
    mkProject(path.join(ws, '.hidden'));
    mkProject(path.join(ws, 'deep', 'x', 'y', 'z')); // 深度 4：不可达
    const found = scanForProjects(ws);
    expect(found).toEqual([path.join(ws, 'a'), path.join(ws, 'b', 'c')].sort());
  });
});

describe('resolveTargetDir', () => {
  it('显式目录不是工程：E-PROJ-002（不做智能回退）', () => {
    const ws = mkTmp('kine-ws-');
    mkProject(path.join(ws, 'a')); // ws 内有工程，但显式 ws 自身不是工程 → 直接报错
    const re = expectResolveError(() => resolveTargetDir(ws, { base: ws }), 'E-PROJ-002');
    expect(re.message).toContain('timeline.yaml');
  });

  it('显式工程目录：直接解析（无 note）', () => {
    const ws = mkTmp('kine-ws-');
    mkProject(path.join(ws, 'a'));
    const r = resolveTargetDir('a', { base: ws });
    expect(r.dir).toBe(path.join(ws, 'a'));
    expect(r.explicit).toBe(true);
    expect(r.note).toBeUndefined();
  });

  it('默认：唯一命中自动发现（带 note）', () => {
    const ws = mkTmp('kine-ws-');
    mkProject(path.join(ws, 'only', 'proj'));
    const r = resolveTargetDir(undefined, { base: ws });
    expect(r.dir).toBe(path.join(ws, 'only', 'proj'));
    expect(r.note).toContain('自动发现');
  });

  it('默认：多命中且登记表为空 → E-PROJ-003 列候选', () => {
    const ws = mkTmp('kine-ws-');
    mkProject(path.join(ws, 'a'));
    mkProject(path.join(ws, 'b'));
    const re = expectResolveError(() => resolveTargetDir(undefined, { base: ws }), 'E-PROJ-003');
    expect(re.facts.length).toBe(2);
  });

  it('默认：多命中时取登记表最近使用的', () => {
    const ws = mkTmp('kine-ws-');
    mkProject(path.join(ws, 'a'));
    mkProject(path.join(ws, 'b'));
    writeRegistry({
      version: 1,
      projects: [
        { dir: path.join(ws, 'b'), lastUsed: new Date().toISOString() },
        { dir: path.join(ws, 'a'), lastUsed: new Date(Date.now() - 86400_000).toISOString() },
      ],
    });
    const r = resolveTargetDir(undefined, { base: ws });
    expect(r.dir).toBe(path.join(ws, 'b'));
    expect(r.note).toContain('最近使用');
  });

  it('默认：无命中时回退唯一有效登记工程', () => {
    const ws = mkTmp('kine-ws-');
    const empty = mkTmp('kine-empty-');
    mkProject(path.join(ws, 'a'));
    writeRegistry({ version: 1, projects: [{ dir: path.join(ws, 'a'), lastUsed: new Date().toISOString() }] });
    const r = resolveTargetDir(undefined, { base: empty });
    expect(r.dir).toBe(path.join(ws, 'a'));
    expect(r.note).toContain('唯一登记工程');
  });

  it('默认：什么都没有 → E-PROJ-001', () => {
    const empty = mkTmp('kine-empty-');
    expectResolveError(() => resolveTargetDir(undefined, { base: empty }), 'E-PROJ-001');
  });

  it('登记表：registerProject 去重且可读回', () => {
    const ws = mkTmp('kine-ws-');
    mkProject(path.join(ws, 'a'));
    registerProject(path.join(ws, 'a'), 'probe');
    registerProject(path.join(ws, 'a'));
    const reg = readRegistry();
    expect(reg.projects.length).toBe(1);
    expect(reg.projects[0]!.dir.toLowerCase()).toBe(path.join(ws, 'a').toLowerCase());
    expect(reg.projects[0]!.title).toBe('probe');
  });
});

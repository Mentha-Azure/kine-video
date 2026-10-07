// kine.projects —— 全局工程登记表（「不传 dir 时默认解析」的依据；可 --forget 清理）
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { kineHome, readRegistry, registryFile, writeRegistry } from '../resolve';
import { fail, ok, type ToolResult } from '../types';

export interface ProjectsArgs {
  forget?: string;
}

export async function toolProjects(args: ProjectsArgs = {}): Promise<ToolResult> {
  const reg = readRegistry();

  if (args.forget !== undefined && args.forget.trim() !== '') {
    const key = args.forget.trim();
    const normKey = key.toLowerCase();
    const idx = reg.projects.findIndex((e) => {
      const d = e.dir.toLowerCase();
      return d === normKey || path.resolve(e.dir).toLowerCase() === normKey || d.endsWith(normKey);
    });
    if (idx < 0) {
      return fail('projects', 'E-PROJ-005', `登记表中未找到：${key}`, {
        facts: reg.projects.map((e) => `工程：${e.dir}`),
        hints: ['用完整路径或路径末尾片段匹配', 'kine projects 查看现有条目'],
      });
    }
    const removed = reg.projects.splice(idx, 1)[0]!;
    writeRegistry(reg);
    return ok('projects', { removed: removed.dir, remaining: reg.projects.length }, {
      verdict: 'PASS',
      facts: [`已移除登记：${removed.dir}`, `剩余 ${reg.projects.length} 个登记工程`],
    });
  }

  const facts = [`登记表：${registryFile()}`, `共 ${reg.projects.length} 个工程`];
  for (const e of reg.projects) {
    const alive = existsSync(path.join(e.dir, 'timeline.yaml'));
    facts.push(`工程：${e.dir}（最近使用 ${e.lastUsed}${alive ? '' : '，⚠ 已失效'}）`);
  }
  if (reg.projects.length === 0) {
    facts.push('提示：成功打开过的工程会自动登记（用于「不传 dir 时默认解析」）');
  }
  return ok('projects', { file: registryFile(), kineHome: kineHome(), projects: reg.projects }, {
    verdict: 'PASS',
    facts,
    hints: ['移除条目：kine projects --forget <路径或片段>'],
  });
}

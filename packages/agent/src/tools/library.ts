// @kine/agent — kine.library.*：用户级资源库管理
// add/list/search/rm/gc/verify/pin/tags —— 内容寻址、标签句柄、引用校验。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { parse as parseYamlText } from 'yaml';
import {
  addBlob,
  addLibraryEntry,
  BLOB_KINDS,
  gcLibrary,
  kineLibraryRoot,
  kineRepoRoot,
  LIBRARY_KINDS,
  listLibraryEntries,
  normalizeTag,
  pinLibraryAsset,
  removeLibraryEntry,
  resolveLibraryEntry,
  verifyLibrary,
  type LibraryKind,
} from '@kine/store';
import type { AgentContext } from '../context';
import { fail, ok, type NextAction, type ToolResult } from '../types';

export interface LibraryArgs {
  action: 'add' | 'list' | 'search' | 'rm' | 'gc' | 'verify' | 'pin' | 'tags' | 'seed';
  file?: string;
  kind?: string;
  name?: string;
  ns?: 'core' | 'ai' | 'usr';
  tags?: string[];
  status?: 'draft' | 'library';
  license?: string;
  source?: string;
  ref?: string;
  query?: string;
  force?: boolean;
  dryRun?: boolean;
  as?: string;
  dir?: string;
}

const KIND_LIST = LIBRARY_KINDS.join(' | ');

function resolveUserFile(ctx: AgentContext, file: string): string {
  const base = process.env.KINE_CWD ?? process.cwd();
  const a = path.resolve(base, file);
  if (existsSync(a)) return a;
  const b = path.resolve(ctx.dir, file);
  if (existsSync(b)) return b;
  return a;
}

/** 设计类的最小骨架数据（无 --file 时） */
function blankDataFor(kind: LibraryKind, name: string): unknown {
  switch (kind) {
    case 'palette':
      return {
        bg: ['#060609', '#0a0a12'],
        text: '#e8e8ea',
        text_dim: '#9a9aa2',
        accent: '#ff2e3f',
        accent_secondary: { color: '#4da3ff', max_frames: 2, use: 'glitch' },
      };
    case 'theme':
      return { name };
    case 'blueprint':
      return { scenes: [{ id: 'main', dur: 5, layers: [] }] };
    default:
      return { name };
  }
}

export async function toolLibrary(ctx: AgentContext, args: LibraryArgs): Promise<ToolResult<unknown>> {
  const tool = 'library';
  const root = kineLibraryRoot();
  switch (args.action) {
    case 'add': {
      if (!args.name) return fail(tool, 'E-LIB-020', '缺少 --name（条目名）');
      const kind = (args.kind ?? 'music') as LibraryKind;
      if (!LIBRARY_KINDS.includes(kind)) {
        return fail(tool, 'E-LIB-021', `未知 kind "${args.kind ?? ''}"`, { facts: [`可用：${KIND_LIST}`] });
      }
      if (BLOB_KINDS.includes(kind)) {
        if (!args.file) return fail(tool, 'E-LIB-020', `blob 类（${kind}）必须提供 --file`);
        const file = resolveUserFile(ctx, args.file);
        if (!existsSync(file)) return fail(tool, 'E-LIB-022', `文件不存在：${file}`);
        const blobInfo = await addBlob(root, file);
        const entry = await addLibraryEntry(root, {
          name: args.name,
          kind,
          ns: args.ns ?? 'usr',
          tags: args.tags,
          status: args.status ?? 'library',
          sha256: blobInfo.sha256,
          size: blobInfo.size,
          blob: blobInfo.blob,
          license: args.license ?? null,
          source: args.source ?? path.basename(file),
        });
        return ok(tool, entry, {
          facts: [
            `已入库：${entry.id}（${entry.kind} · ${entry.status} · v${entry.version}）`,
            `sha256：${blobInfo.sha256.slice(0, 16)}…（${blobInfo.size} 字节${blobInfo.existed ? '；内容寻址去重命中' : ''}）`,
            `tags：${entry.tags.length > 0 ? entry.tags.map((t) => `@${t}`).join(' ') : '（未设）'}`,
            `引用：library://${entry.id}`,
          ],
        });
      }
      // 设计类（theme/palette/blueprint/preset/...）：内联 data
      let data: unknown;
      if (args.file) {
        const file = resolveUserFile(ctx, args.file);
        if (!existsSync(file)) return fail(tool, 'E-LIB-022', `文件不存在：${file}`);
        try {
          data = parseYamlText(readFileSync(file, 'utf8'));
        } catch (e) {
          return fail(tool, 'E-LIB-023', `--file 解析失败：${(e as Error).message}`);
        }
      } else {
        data = blankDataFor(kind, args.name);
      }
      const entry = await addLibraryEntry(root, {
        name: args.name,
        kind,
        ns: args.ns ?? 'usr',
        tags: args.tags,
        status: args.status ?? 'draft',
        data,
        source: args.source ?? null,
      });
      return ok(tool, entry, {
        facts: [
          `已入库（设计类）：${entry.id}（${entry.kind} · ${entry.status} · v${entry.version}）`,
          entry.status === 'draft' ? '当前为 draft：可用 kine forge register 验证后入册' : '已入册',
          `引用：library://${entry.id}`,
        ],
      });
    }
    case 'list': {
      const entries = listLibraryEntries(root, {
        kind: args.kind as LibraryKind | undefined,
        tag: args.tags?.[0],
        status: args.status,
        ns: args.ns,
      });
      return ok(
        tool,
        { entries, total: entries.length },
        {
          facts: [
            `库根：${root}`,
            ...entries.slice(0, 40).map(
              (e) =>
                `${e.id}（${e.kind} · ${e.status} · v${e.version}）${e.tags.length > 0 ? ' ' + e.tags.map((t) => `@${t}`).join(' ') : ''}`,
            ),
            entries.length > 40 ? `…共 ${entries.length} 条（已截断）` : null,
          ].filter(Boolean) as string[],
        },
      );
    }
    case 'search': {
      const q = (args.query ?? '').toLowerCase();
      if (!q) return fail(tool, 'E-LIB-020', '缺少查询词（kine library search <词>）');
      const all = listLibraryEntries(root);
      const hits = all.filter(
        (e) =>
          e.id.toLowerCase().includes(q) ||
          e.name.toLowerCase().includes(q) ||
          e.kind.includes(q) ||
          e.tags.some((t) => t.includes(q.replace(/^@/, ''))),
      );
      return ok(tool, { hits, total: hits.length }, {
        facts: hits.slice(0, 40).map((e) => `${e.id}（${e.kind} · ${e.status}）`),
      });
    }
    case 'rm': {
      if (!args.ref) return fail(tool, 'E-LIB-020', '缺少条目引用（id 或 @tag）');
      try {
        const r = await removeLibraryEntry(root, args.ref, { force: args.force });
        return ok(tool, { removed: r.removed.id, blobRemoved: r.blobRemoved }, {
          facts: [
            `已移除：${r.removed.id}（${r.removed.kind}）`,
            r.blobRemoved ? 'blob 已回收（无其他引用）' : 'blob 保留（仍被引用）',
          ],
          hints: ['清单外备份仍在 .kine/backup；库操作已记录在案（changelog 由上层命令写入）'],
        });
      } catch (e) {
        const err = e as { code?: string; message?: string };
        return fail(tool, err.code ?? 'E-LIB-012', err.message ?? '移除失败');
      }
    }
    case 'gc': {
      const r = await gcLibrary(root, { dryRun: args.dryRun });
      return ok(tool, r, {
        facts: [
          `${args.dryRun ? '[dry-run] 将回收' : '已回收'}无引用 blob ${r.removed.length} 个（${(r.freedBytes / 1024).toFixed(1)} KB）`,
          `保留 ${(r.keptBytes / 1024).toFixed(1)} KB`,
        ],
        hints: args.dryRun ? ['确认后去掉 --dry-run 执行'] : undefined,
      });
    }
    case 'verify': {
      const r = await verifyLibrary(root, { dir: args.dir ? path.resolve(process.env.KINE_CWD ?? process.cwd(), args.dir) : undefined });
      return ok(tool, r, {
        verdict: r.ok ? 'PASS' : 'FAIL',
        facts: [...r.checks, ...r.issues.map((i) => `⚠ ${i}`), ...r.options.map((o) => `· ${o}`)],
      });
    }
    case 'pin': {
      if (!args.ref) return fail(tool, 'E-LIB-020', '缺少条目引用（id 或 @tag）');
      const projectDir = args.dir ? path.resolve(process.env.KINE_CWD ?? process.cwd(), args.dir) : ctx.dir;
      try {
        const r = await pinLibraryAsset(root, projectDir, args.ref, { as: args.as });
        const rel = path.relative(projectDir, r.file).replace(/\\/g, '/');
        const actions: NextAction[] = [
          {
            tool: 'kine.edit',
            args: { expr: `set audio.music.file=${rel}`, quote: `把音乐冻结为工程内副本 ${rel}`, tx: true },
            reason: '把引用改为工程内副本（#pin 语义，不再跟随库更新）',
          },
        ];
        return ok(tool, { file: r.file, relative: rel, sha256: r.sha256, entry: r.entry.id }, {
          facts: [`已复制到工程：${rel}（sha256 ${r.sha256.slice(0, 12)}…）`, '把 timeline 引用改为该相对路径即冻结版本'],
          nextActions: actions,
        });
      } catch (e) {
        const err = e as { code?: string; message?: string };
        return fail(tool, err.code ?? 'E-LIB-013', err.message ?? 'pin 失败');
      }
    }
    case 'seed': {
      // v3 P1-4：内置种子内容（seeds/palettes/*.yaml → 用户资源库 core/ 命名空间）——幂等：已存在跳过
      const seedsDir = path.join(kineRepoRoot(), 'seeds', 'palettes');
      if (!existsSync(seedsDir)) {
        return fail(tool, 'E-LIB-025', `种子目录不存在：${seedsDir}`, {
          hints: ['seeds 目录随 kine 仓库分发；确认运行的是完整仓库副本'],
        });
      }
      const files = readdirSync(seedsDir).filter((f) => f.endsWith('.yaml')).sort();
      const existing = new Set(listLibraryEntries(root).map((e) => e.id));
      const added: string[] = [];
      const skipped: string[] = [];
      const errors: string[] = [];
      for (const f of files) {
        const name = f.replace(/\.yaml$/, '');
        const id = `core/${name}`;
        if (existing.has(id)) {
          skipped.push(id);
          continue;
        }
        try {
          const data = parseYamlText(readFileSync(path.join(seedsDir, f), 'utf8')) as Record<string, unknown>;
          if (!data || typeof data !== 'object') throw new Error('YAML 内容为空');
          const bg = data.bg;
          if (!Array.isArray(bg) || bg.length !== 2) throw new Error('bg 需为两个颜色');
          for (const c of bg) {
            const mm = /^#?([0-9a-fA-F]{6})$/.exec(String(c).trim());
            if (!mm) throw new Error(`bg 颜色非法：${String(c)}（需 #rrggbb）`);
            const v = parseInt(mm[1]!, 16);
            if (Math.max((v >> 16) & 255, (v >> 8) & 255, v & 255) > 32) throw new Error(`bg 过亮（通道应 ≤32）：${String(c)}`);
          }
          for (const k of ['text', 'text_dim', 'accent']) {
            if (!/^#?[0-9a-fA-F]{6}$/.test(String(data[k] ?? '').trim())) throw new Error(`${k} 颜色非法：${String(data[k])}`);
          }
          await addLibraryEntry(root, {
            name: String(data.name ?? name),
            kind: 'palette',
            ns: 'core',
            id,
            tags: Array.isArray(data.tags) ? (data.tags as unknown[]).map((t) => normalizeTag(String(t))) : [normalizeTag(name)],
            status: 'library',
            data,
            source: `seeds/palettes/${f}`,
          });
          added.push(id);
        } catch (e) {
          errors.push(`${id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return ok(tool, { added, skipped, errors }, {
        verdict: errors.length > 0 ? 'FAIL' : 'PASS',
        facts: [
          `种子色板：新增 ${added.length}｜跳过（已存在）${skipped.length}｜失败 ${errors.length}`,
          ...added.map((sid) => `+ ${sid} → 引用：theme.palette: library://${sid}`),
          ...errors.map((e2) => `✖ ${e2}`),
        ],
        hints: [
          added.length > 0 ? '应用：kine style apply --ref library://core/noir --tx --quote "…"' : '全部种子已注册；kine library list --kind palette 查看',
        ],
        nextActions: [{ tool: 'kine.style', args: { action: 'show' } }, { tool: 'kine.library', args: { action: 'list', kind: 'palette' } }],
      });
    }
    case 'tags': {
      const all = listLibraryEntries(root);
      const counts = new Map<string, number>();
      for (const e of all) for (const t of e.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
      const cloud = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      return ok(tool, { tags: cloud.map(([tag, count]) => ({ tag, count })) }, {
        facts: cloud.length > 0 ? cloud.map(([t, c]) => `@${t} ×${c}`) : ['库中还没有标签'],
      });
    }
    default:
      return fail(tool, 'E-LIB-020', `未知 action "${args.action}"`, { facts: ['可用：add | list | search | rm | gc | verify | pin | tags | seed'] });
  }
}

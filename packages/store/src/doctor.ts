// @kine/store — doctor：校验 IR/缓存/版本/锁一致性并可修复
import fs from 'node:fs';
import path from 'node:path';
import { compile } from '@kine/dsl';
import { loadCacheIndex, cacheStatus, saveCacheIndex, workStatus } from './cache';
import { atomicWriteFile } from './layout';
import { cleanStaleLocks } from './locks';
import { kineRepoRoot } from './pyside';
import type { ProjectStore } from './project';
import { listVersions, readLatest, setLatest } from './versions';

export interface DoctorCheck {
  name: string;
  status: 'PASS' | 'WARN' | 'FAIL';
  detail: string;
  fixed?: boolean;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  ok: boolean;
  fixedCount: number;
}

export function doctor(store: ProjectStore, opts: { fix?: boolean } = {}): DoctorReport {
  const checks: DoctorCheck[] = [];
  const fix = opts.fix ?? false;
  let fixedCount = 0;

  // 1) timeline.yaml 可装载
  let specHash: string | null = null;
  try {
    const loaded = store.load();
    const res = compile(loaded.spec, { projectDir: store.root });
    specHash = res.ir.specHash;
    const errs = res.issues.filter((i) => i.severity === 'error');
    checks.push({
      name: 'timeline',
      status: errs.length === 0 ? 'PASS' : 'FAIL',
      detail: errs.length === 0 ? `可编译，specHash ${specHash.slice(0, 8)}` : `${errs.length} 个编译错误：${errs[0].code} ${errs[0].message}`,
    });
  } catch (e) {
    checks.push({ name: 'timeline', status: 'FAIL', detail: `装载失败：${(e as Error).message}` });
  }

  // 2) IR 与 specHash 一致
  if (fs.existsSync(store.layout.irFile)) {
    let irHash: string | null = null;
    try {
      irHash = JSON.parse(fs.readFileSync(store.layout.irFile, 'utf8')).specHash ?? null;
    } catch { /* ignore */ }
    if (irHash === specHash) {
      checks.push({ name: 'ir', status: 'PASS', detail: 'IR 与当前 DSL 一致' });
    } else {
      let didFix = false;
      if (fix && specHash) {
        try {
          const loaded = store.load();
          const res = compile(loaded.spec, { projectDir: store.root });
          atomicWriteFile(store.layout.irFile, JSON.stringify(res.ir, null, 2) + '\n');
          didFix = true;
          fixedCount++;
        } catch { /* leave */ }
      }
      checks.push({ name: 'ir', status: didFix ? 'PASS' : 'WARN', detail: didFix ? 'IR 已重新编译刷新' : `IR specHash ${String(irHash).slice(0, 8)} ≠ 当前 ${String(specHash).slice(0, 8)}（建议 kine compile）`, fixed: didFix });
    }
  } else {
    let didFix = false;
    if (fix && specHash) {
      try {
        const res = compile(store.load().spec, { projectDir: store.root });
        atomicWriteFile(store.layout.irFile, JSON.stringify(res.ir, null, 2) + '\n');
        didFix = true;
        fixedCount++;
      } catch { /* leave */ }
    }
    checks.push({ name: 'ir', status: didFix ? 'PASS' : 'WARN', detail: didFix ? 'IR 已生成' : 'IR 不存在（运行 kine compile）', fixed: didFix });
  }

  // 3) 缓存索引：丢失条目清理
  const cacheDir = store.layout.cacheDir;
  if (fs.existsSync(cacheDir)) {
    const idx = loadCacheIndex(cacheDir);
    const missing = Object.entries(idx.entries).filter(([, e]) => !fs.existsSync(path.join(cacheDir, e.path)));
    if (missing.length > 0) {
      let didFix = false;
      if (fix) {
        for (const [k] of missing) delete idx.entries[k];
        saveCacheIndex(cacheDir, idx);
        didFix = true;
        fixedCount++;
      }
      checks.push({ name: 'cache', status: didFix ? 'PASS' : 'WARN', detail: `${missing.length} 条索引指向丢失文件${didFix ? '（已清理）' : ''}`, fixed: didFix });
    } else {
      const st = cacheStatus(cacheDir);
      checks.push({ name: 'cache', status: 'PASS', detail: `${st.entries} 条缓存，${(st.totalBytes / 1048576).toFixed(1)}MB，孤儿 ${st.orphans.length}` });
    }
  } else {
    checks.push({ name: 'cache', status: 'PASS', detail: '缓存目录未建立（无缓存）' });
  }

  // 4) latest 指针有效
  const latest = readLatest(store.layout.outDir);
  if (latest) {
    const vdir = path.join(store.layout.outDir, latest.version);
    const ok = fs.existsSync(vdir);
    if (!ok && fix) {
      // 指向下一个存在的版本
      const versions = listVersions(store.layout.outDir);
      if (versions.length > 0) {
        setLatest(store.layout.outDir, { version: versions[versions.length - 1].version });
        fixedCount++;
        checks.push({ name: 'latest', status: 'PASS', detail: `指针已修复为 ${versions[versions.length - 1].version}`, fixed: true });
      } else {
        fs.rmSync(path.join(store.layout.outDir, 'latest.json'), { force: true });
        fixedCount++;
        checks.push({ name: 'latest', status: 'PASS', detail: '无效指针已清除', fixed: true });
      }
    } else {
      checks.push({ name: 'latest', status: ok ? 'PASS' : 'FAIL', detail: `latest → ${latest.version}${ok ? '' : '（目录不存在）'}` });
    }
  } else {
    checks.push({ name: 'latest', status: 'PASS', detail: '尚无终版指针' });
  }

  // 5) stale 锁清理
  const removed = cleanStaleLocks(store.layout.locksDir);
  checks.push({
    name: 'locks',
    status: removed.length ? (fix ? 'PASS' : 'WARN') : 'PASS',
    detail: removed.length ? `${removed.length} 个陈旧锁${fix ? '（已清理）' : ''}` : '无陈旧锁',
    fixed: removed.length > 0 && fix,
  });
  if (removed.length) fixedCount += fix ? 1 : 0;

  // 6) work 目录体积报告（派生/采样/复用分项 —— cache gc 按档回收）
  const wk = workStatus(store.layout.workDir);
  const regen = wk.scratchBytes + wk.sampleBytes;
  checks.push({
    name: 'work',
    status: regen > 1024 * 1024 * 1024 ? 'WARN' : 'PASS',
    detail:
      `work ${(wk.totalBytes / 1048576).toFixed(1)}MB：frames ${(wk.scratchBytes / 1048576).toFixed(1)}MB / 采样 ${(wk.sampleBytes / 1048576).toFixed(1)}MB / 复用 ${(wk.cacheBytes / 1048576).toFixed(1)}MB` +
      (regen > 1024 * 1024 * 1024 ? '｜可回收项超 1GB，建议 kine cache gc' : ''),
  });

  // 7) 宿主 bundle 新鲜度（v5：反馈——改源码后 MCP 常驻旧模块且难确认）
  try {
    const repo = kineRepoRoot();
    const bundle = path.join(repo, 'packages', 'render', 'assets', 'kine-host.js');
    if (fs.existsSync(bundle)) {
      const bt = fs.statSync(bundle).mtimeMs;
      let newest = 0;
      for (const dir of ['packages/runtime/src', 'packages/widgets/src', 'packages/render/host']) {
        const d = path.join(repo, dir);
        if (!fs.existsSync(d)) continue;
        for (const f of fs.readdirSync(d)) {
          if (!f.endsWith('.ts')) continue;
          const mt = fs.statSync(path.join(d, f)).mtimeMs;
          if (mt > newest) newest = mt;
        }
      }
      if (newest > bt + 1000) {
        checks.push({ name: 'bundle', status: 'WARN', detail: '宿主 bundle 早于源码：先 npx tsx tools/build-web.ts 重建，再重启 MCP 服务' });
      } else {
        checks.push({ name: 'bundle', status: 'PASS', detail: `宿主 bundle 新鲜（${(fs.statSync(bundle).size / 1024).toFixed(0)}KB）` });
      }
    } else {
      checks.push({ name: 'bundle', status: 'WARN', detail: '宿主 bundle 缺失（渲染前运行 npx tsx tools/build-web.ts）' });
    }
  } catch {
    /* 检查失败不阻塞 */
  }

  return { checks, ok: checks.every((c) => c.status !== 'FAIL'), fixedCount };
}

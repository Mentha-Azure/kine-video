// @kine/render — 浏览器会话：Edge/Chromium 发现、独立 user-data-dir、确定性启动参数（规格文档04 §4.2、文档09 §8.6）
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import lockfile from 'proper-lockfile';
import { chromium, type BrowserContext, type Page } from 'playwright-core';
import type { KineIR } from '@kine/dsl';

export interface BrowserInfo {
  path: string;
  kind: 'edge' | 'chrome' | 'chromium' | 'env';
  version?: string;
}

/** 发现顺序：KINE_BROWSER → Playwright 自带 Chromium → Edge → Chrome */
export function findBrowser(): BrowserInfo {
  if (process.env.KINE_BROWSER) return { path: process.env.KINE_BROWSER, kind: 'env' };
  const local = process.env.LOCALAPPDATA ?? path.join(homedir(), 'AppData', 'Local');
  const pwRoot = path.join(local, 'ms-playwright');
  if (existsSync(pwRoot)) {
    for (const d of readdirSync(pwRoot)) {
      if (!d.startsWith('chromium')) continue;
      for (const rel of ['chrome-win/chrome.exe', 'chrome-win64/chrome.exe']) {
        const p = path.join(pwRoot, d, rel);
        if (existsSync(p)) return { path: p, kind: 'chromium' };
      }
    }
  }
  const edge = [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  ].find((p) => existsSync(p));
  if (edge) return { path: edge, kind: 'edge' };
  const chrome = [
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ].find((p) => existsSync(p));
  if (chrome) return { path: chrome, kind: 'chrome' };
  throw new Error(
    '找不到可用浏览器。请安装 Microsoft Edge / Google Chrome，或设置 KINE_BROWSER 指向浏览器 exe，' +
      '或安装 Playwright Chromium（npx playwright install chromium）。',
  );
}

/** 确定性渲染必需的启动参数（逐字节复现的前提，规格文档04 §4.7） */
export function determinismArgs(dpr = 1): string[] {
  return [
    '--headless=new',
    '--disable-gpu',
    '--run-all-compositor-stages-before-draw',
    '--force-color-profile=srgb',
    '--force-device-scale-factor=' + String(dpr),
    '--font-render-hinting=none',
    '--disable-lcd-text',
    '--hide-scrollbars',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--disable-features=CalculateNativeWinOcclusion',
  ];
}

export function hostBundlePath(): string {
  return fileURLToPath(new URL('../assets/kine-host.js', import.meta.url));
}

/** 跨进程浏览器启动互斥锁（多 worker/多工具并发时串行化启动窗口，文档09 §8.6 多浏览器冲突防护） */
async function acquireBrowserLaunchLock(): Promise<() => Promise<void>> {
  const dir = path.join(homedir(), '.local', 'share', 'kine', 'locks');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'browser.launch');
  if (!existsSync(file)) writeFileSync(file, '', 'utf8');
  const release = await lockfile.lock(file, {
    stale: 30_000,
    retries: { retries: 100, factor: 1.3, minTimeout: 250, maxTimeout: 2500, randomize: true },
  });
  return async () => {
    try {
      await release();
    } catch {
      /* 锁已过期释放等场景：忽略 */
    }
  };
}

export interface ScanError {
  t: number;
  message: string;
  stack: string;
}

/** 页面内运行时接口（host bundle 注入的 window.__kine） */
interface PageKine {
  load(ir: unknown): void;
  jump(T: number): void;
  probe(T: number): unknown;
  stateHash(T: number): string;
  setSeed(seed: number): void;
  scan(t0: number, t1: number, step: number): ScanError[];
  probeMany(ts: number[]): unknown[];
  hashMany(ts: number[]): { T: number; hash: string }[];
}

export interface SessionOptions {
  width: number;
  height: number;
  userDataDir: string;
  dpr?: number;
  timeoutMs?: number;
}

export interface KineSession {
  page: Page;
  context: BrowserContext;
  info: BrowserInfo;
  load(ir: KineIR | unknown): Promise<void>;
  jump(T: number): Promise<void>;
  probe(T: number): Promise<unknown>;
  stateHash(T: number): Promise<string>;
  hashMany(ts: number[]): Promise<{ T: number; hash: string }[]>;
  scan(t0: number, t1: number, step: number): Promise<ScanError[]>;
  /** jump → rAF×2 → 全页截图（确定性抓帧，规格文档04 §4.2） */
  shoot(T: number, opts?: { firstFrame?: boolean; dt?: number }): Promise<Buffer>;
  /** drainCast 等价物：多次渲染并丢弃（消除首帧加载残影） */
  warmup(ts: number[]): Promise<void>;
  consoleErrors(): string[];
  close(): Promise<void>;
}

export async function openSession(opts: SessionOptions): Promise<KineSession> {
  const timeout = opts.timeoutMs ?? 30_000;
  const bundle = hostBundlePath();
  if (!existsSync(bundle)) {
    throw new Error(`宿主 bundle 不存在：${bundle}\n请先运行：pnpm build:web`);
  }
  mkdirSync(opts.userDataDir, { recursive: true });
  const info = findBrowser();
  // 跨进程启动互斥：Edge/Chromium 并发启动会互杀（Target closed / exitCode 21）
  const releaseLaunch = await acquireBrowserLaunchLock();
  let ctx: BrowserContext;
  try {
    ctx = await chromium.launchPersistentContext(opts.userDataDir, {
      executablePath: info.path,
      headless: true,
      args: determinismArgs(opts.dpr ?? 1),
      viewport: { width: opts.width, height: opts.height },
      deviceScaleFactor: opts.dpr ?? 1,
    });
  } finally {
    await releaseLaunch();
  }
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.setViewportSize({ width: opts.width, height: opts.height });

  const consoleErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text());
  });
  page.on('pageerror', (e) => consoleErrors.push(String(e.message)));

  const html =
    '<!doctype html><html><head><meta charset="utf-8"><style>' +
    'html,body{margin:0;padding:0;background:#000;overflow:hidden}' +
    'canvas#kine{display:block}</style></head>' +
    '<body><canvas id="kine"></canvas></body></html>';
  await page.setContent(html, { timeout });
  await page.addScriptTag({ content: readFileSync(bundle, 'utf8') });
  await page.waitForFunction('window.__kineReady === true', undefined, { timeout });

  // 快速自检：宿主接口齐备（在页面内检查，避免函数无法经 CDP 序列化）
  const apiOk = await page.evaluate(
    () =>
      typeof (window as unknown as { __kine?: { jump?: unknown; probe?: unknown; stateHash?: unknown } }).__kine?.jump ===
        'function' &&
      typeof (window as unknown as { __kine?: { jump?: unknown; probe?: unknown; stateHash?: unknown } }).__kine?.probe ===
        'function',
  );
  if (!apiOk) {
    await ctx.close().catch(() => undefined);
    throw new Error('宿主页 __kine 接口不完整（bundle 版本不符？请重新 build:web）');
  }

  const session: KineSession = {
    page,
    context: ctx,
    info,
    consoleErrors: () => [...consoleErrors],
    async load(ir) {
      await page.evaluate((irJson) => (window as unknown as { __kine: PageKine }).__kine.load(irJson), ir as never);
    },
    async jump(T) {
      await page.evaluate((t) => (window as unknown as { __kine: PageKine }).__kine.jump(t), T);
    },
    async probe(T) {
      return page.evaluate((t) => (window as unknown as { __kine: PageKine }).__kine.probe(t), T);
    },
    async stateHash(T) {
      return page.evaluate((t) => (window as unknown as { __kine: PageKine }).__kine.stateHash(t), T);
    },
    async hashMany(ts) {
      return page.evaluate((arr) => (window as unknown as { __kine: PageKine }).__kine.hashMany(arr), ts);
    },
    async scan(t0, t1, step) {
      return page.evaluate(
        ([a, b, s]) => (window as unknown as { __kine: PageKine }).__kine.scan(a as number, b as number, s as number),
        [t0, t1, step] as [number, number, number],
      );
    },
    async shoot(T, o = {}) {
      const firstFrame = o.firstFrame ?? false;
      const dt = o.dt ?? 1 / 60;
      if (firstFrame) {
        await session.jump(T + dt);
        await session.jump(T);
      } else {
        await session.jump(T);
      }
      await session.page.evaluate(
        () =>
          new Promise<void>((r) => {
            requestAnimationFrame(() => requestAnimationFrame(() => r()));
          }),
      );
      return session.page.screenshot({ type: 'png', animations: 'disabled', timeout: 10_000 });
    },
    async warmup(ts) {
      for (const t of ts) {
        await session.jump(t);
        await session.page.evaluate(
          () =>
            new Promise<void>((r) => {
              requestAnimationFrame(() => requestAnimationFrame(() => r()));
            }),
        );
        await session.page.screenshot({ type: 'png', animations: 'disabled' });
      }
    },
    async close() {
      await ctx.close().catch(() => undefined);
    },
  };

  return session;
}

/** withTimeout 工具 */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`超时（${ms}ms）：${label}`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 启动间隔 ≥1.2s（多浏览器实例错峰，规格文档09 §8.6） */
export function staggerDelay(workerIndex: number): number {
  return workerIndex * 1200;
}

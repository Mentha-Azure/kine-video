// @kine/render — 宿主页入口（esbuild IIFE bundle → assets/kine-host.js）
// 页面契约：window.__kine = {load,jump,probe,stateHash,setSeed,scan,probeMany,hashMany}
//           window.__kineReady = true（就绪握手，规格文档04 §4.2）
import { createRuntime } from '@kine/runtime';
import { registerAll } from '@kine/widgets';

registerAll();

const canvas = document.getElementById('kine') as HTMLCanvasElement | null;
if (!canvas) throw new Error('宿主页缺少 <canvas id="kine">');

const rt = createRuntime(canvas);

const api = {
  load(ir: unknown): void {
    rt.load(ir as never);
  },
  jump(T: number): void {
    rt.jump(T);
  },
  probe(T: number): unknown {
    return rt.probe(T);
  },
  stateHash(T: number): string {
    return rt.stateHash(T);
  },
  setSeed(seed: number): void {
    rt.setSeed(seed);
  },
  /** 运行时扫描：0.25s 步进全轴抓错（audit 第三层，规格文档05 §5.10） */
  scan(t0: number, t1: number, step: number): Array<{ t: number; message: string; stack: string }> {
    const errs: Array<{ t: number; message: string; stack: string }> = [];
    for (let t = t0; t <= t1 + 1e-9; t += step) {
      try {
        rt.jump(t);
      } catch (e) {
        errs.push({
          t,
          message: e instanceof Error ? e.message : String(e),
          stack: e instanceof Error ? String(e.stack ?? '').slice(0, 800) : '',
        });
      }
    }
    return errs;
  },
  probeMany(ts: number[]): unknown[] {
    return ts.map((T) => rt.probe(T));
  },
  hashMany(ts: number[]): Array<{ T: number; hash: string }> {
    return ts.map((T) => ({ T, hash: rt.stateHash(T) }));
  },
  listWidgets(): string[] {
    return rt.listWidgets();
  },
};

(window as unknown as { __kine: typeof api }).__kine = api;
(window as unknown as { __kineReady: boolean }).__kineReady = true;

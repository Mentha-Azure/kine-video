// 像素指标包装：全部经 kine-py（PIL/numpy）执行，RGB 0-255 口径，禁色彩管理
import { getKinePy } from '@kine/store';

export interface DensityData {
  value: number; litPixels: number; total: number;
  backgroundRgb: [number, number, number];
  hotspots: { row: number; col: number; ratio: number }[];
  grid?: number[] | number[][];
}
export interface FrameDiffData { value: number; grid: number[] | number[][] }
export interface EdgeBandData { value: number; band: number; sides: Record<string, number> }
export interface BlackLevelData { value: number; rgb: [number, number, number]; maxChannel: number }
export interface SpikeData { value: number; diffs: number[]; hits: { index: number; from: number; to: number; ratio: number; neighborhoodMean: number }[] }

export async function pyDensity(png: string, opts: { lit?: number; invert?: boolean } = {}): Promise<DensityData> {
  const py = await getKinePy();
  return py.call<DensityData>('density', { png, lit: opts.lit ?? 40, invert: opts.invert ?? false });
}
export async function pyFrameDiff(a: string, b: string, opts: { eps?: number } = {}): Promise<FrameDiffData> {
  const py = await getKinePy();
  return py.call<FrameDiffData>('frame_diff', { a, b, eps: opts.eps ?? 8 });
}
export async function pyEdgeBand(png: string, opts: { band?: number; lit?: number; invert?: boolean } = {}): Promise<EdgeBandData> {
  const py = await getKinePy();
  return py.call<EdgeBandData>('edge_band', { png, band: opts.band ?? 34, lit: opts.lit ?? 40, invert: opts.invert ?? false });
}
export async function pyBlackLevel(png: string, opts: { pick?: 'dark' | 'light' } = {}): Promise<BlackLevelData> {
  const py = await getKinePy();
  return py.call<BlackLevelData>('black_level', { png, pick: opts.pick ?? 'dark' });
}
export async function pyTransitionSpike(pngs: string[], opts: { eps?: number; factor?: number } = {}): Promise<SpikeData> {
  const py = await getKinePy();
  return py.call<SpikeData>('transition_spike', { pngs, eps: opts.eps ?? 8, factor: opts.factor ?? 2.2 });
}
export async function pyGridOverlay(png: string, out: string, highlights?: unknown): Promise<{ file: string }> {
  const py = await getKinePy();
  return py.call('grid_overlay', { png, out, highlights });
}
export async function pyMontage(pngs: string[], out: string, opts: { cols?: number; cell?: number; labels?: string[] } = {}): Promise<{ file: string }> {
  const py = await getKinePy();
  return py.call('montage', { pngs, out, cols: opts.cols ?? 3, cell: opts.cell ?? 300, labels: opts.labels });
}

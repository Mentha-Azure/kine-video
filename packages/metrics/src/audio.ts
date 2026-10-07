// 音频指标包装（经 kine-py）：RMS 窗、累积能量、重拍检测、卡点偏差
import { getKinePy } from '@kine/store';
import type { KineIR } from '@kine/dsl';

export interface AudioStatsData {
  rmsCurve: { t: number; dbfs: number }[];
  peakDbfs: number;
  rmsDbfs: number;
  t99_9: number;
  tailPeakDbfs: number;
  duration: number;
}
export interface WindowLevel { t0: number; t1: number; peakDbfs: number; rmsDbfs: number }
export interface BeatsData { beats: { t: number; strength: number }[]; count: number; gate: number; gain: number; decay: number }

export async function audioStatsOf(wav: string, window = 0.1): Promise<AudioStatsData> {
  const py = await getKinePy();
  return py.call<AudioStatsData>('audio_stats', { wav, window });
}

export async function windowLevelsOf(wav: string, windows: { t0: number; t1: number }[]): Promise<WindowLevel[]> {
  const py = await getKinePy();
  const r = await py.call<{ levels: WindowLevel[] }>('window_levels', { wav, windows });
  return r.levels;
}

export async function beatsOf(wav: string, fps = 60): Promise<BeatsData> {
  const py = await getKinePy();
  return py.call<BeatsData>('beats', { wav, fps });
}

export interface BeatDeltaData {
  /** 匹配对中最大 |Δ|（ms）；无匹配时为 0 */
  maxAbsMs: number;
  matched: { beat: number; event: number; deltaMs: number; sfx: string }[];
  unmatchedBeats: number;
  unmatchedEvents: number;
  beats: number;
  events: number;
}

/** 卡点偏差：音乐重拍 ↔ SFX 事件（各找 0.3s 内最近者配对，取并集） */
export function computeBeatDelta(beats: number[], events: { at: number; sfx: string; strict?: boolean }[]): BeatDeltaData {
  const W = 0.3;
  const matched: BeatDeltaData['matched'] = [];
  const usedEvents = new Set<number>();
  let unmatchedBeats = 0;
  for (const b of beats) {
    let best = -1;
    let bestD = Infinity;
    events.forEach((e, i) => {
      const d = Math.abs(e.at - b);
      if (d < bestD) { bestD = d; best = i; }
    });
    if (best >= 0 && bestD <= W) {
      usedEvents.add(best);
      matched.push({ beat: b, event: events[best].at, deltaMs: (b - events[best].at) * 1000, sfx: events[best].sfx });
    } else {
      unmatchedBeats++;
    }
  }
  // 事件侧：未被任何重拍命中的卡点事件
  let unmatchedEvents = 0;
  events.forEach((e, i) => {
    if (usedEvents.has(i)) return;
    const nearest = beats.reduce((acc, b) => Math.min(acc, Math.abs(b - e.at)), Infinity);
    if (nearest > W) unmatchedEvents++;
  });
  const maxAbsMs = matched.reduce((m, x) => Math.max(m, Math.abs(x.deltaMs)), 0);
  return { maxAbsMs, matched, unmatchedBeats, unmatchedEvents, beats: beats.length, events: events.length };
}

export function strictEvents(ir: KineIR): { at: number; sfx: string; strict: boolean }[] {
  return ir.audioPlan.sfxEvents.map((e) => {
    const strict = e.params?.['strict'] === true || e.params?.['beat'] === true;
    return { at: e.at, sfx: e.sfx as string, strict };
  });
}

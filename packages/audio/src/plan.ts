// @kine/audio — 音频计划展开：drone 床逐幕展开 + kine-py 合成事件表
import type { KineIR } from '@kine/dsl';

export interface SynthEvent {
  id: string;
  sfx: string;
  /** 成片秒 */
  at: number;
  gain: number;
  bus: string;
  params: Record<string, unknown>;
}

export interface SynthPlan {
  events: SynthEvent[];
  busGains: Record<string, number>;
  seed: number;
  sr: number;
  duration: number;
}

/**
 * 把 IR 的音频计划展开为 kine-py 可消费的事件表：
 * - ir.audioPlan.sfxEvents（已是成片秒）
 * - drone_levels：逐幕一条 drone 事件（gain=该幕级别，dur=幕长+1s 交叉淡接）
 * 全部纯函数，同输入同输出（字节级复现的前提）。
 */
export function synthEvents(ir: KineIR, sr = 48000): SynthPlan {
  const events: SynthEvent[] = ir.audioPlan.sfxEvents.map((e) => ({
    id: e.id,
    sfx: e.sfx,
    at: e.at,
    gain: e.gain,
    bus: e.bus,
    params: e.params,
  }));

  const lv = ir.audioPlan.droneLevels;
  if (lv && lv.length > 0) {
    ir.scenes.forEach((s, i) => {
      const g = lv[i] ?? lv[lv.length - 1] ?? 0;
      if (!(g > 0)) return;
      events.push({
        id: `drone_${s.id}`,
        sfx: 'drone',
        at: s.t0,
        gain: g,
        bus: 'bed',
        params: { dur: +(s.t1 - s.t0 + 1.0).toFixed(3) },
      });
    });
  }

  const busGains: Record<string, number> = {};
  for (const b of ir.audioPlan.buses) busGains[b.id] = b.gain;

  // 事件按 (at, id) 稳定排序，保证 kine-py 求和顺序无关、可复现
  events.sort((a, b) => (a.at === b.at ? (a.id < b.id ? -1 : 1) : a.at - b.at));

  return {
    events,
    busGains,
    seed: ir.project.seed,
    sr,
    duration: ir.output.duration,
  };
}

/** 事件数量统计（verify/impact 展示用） */
export function countEventsByBus(plan: SynthPlan): Record<string, number> {
  const out: Record<string, number> = {};
  for (const e of plan.events) out[e.bus] = (out[e.bus] ?? 0) + 1;
  return out;
}

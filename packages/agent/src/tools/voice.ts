// voice.ts — 配音音色工具（list/show/synth/default）
//
// 音色档案来自资源库（kind: voice），默认音色记在 <kineHome>/voices.json。
// synth 把文本（或按行分段的脚本）合成旁白：调 TTS 服务 → 停顿归一化 → 落盘 WAV（+ 分段 schedule）。
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import {
  listVoices,
  normalizePauses,
  pauseStats,
  peakDb,
  readVoiceDefaults,
  readWavPcm16,
  resolveVoice,
  setDefaultVoice,
  writeWavPcm16,
  type VoiceData,
  type VoiceEntry,
} from '@kine/store';
import { fail, ok, type ToolResult } from '../types';
import type { AgentContext } from '../context';

export interface VoiceArgs {
  action: 'list' | 'show' | 'synth' | 'default';
  /** 音色：name / id / library://id / @tag；缺省取默认音色 */
  name?: string;
  text?: string;
  /** 文本文件（按行分段；# 开头与空行忽略） */
  file?: string;
  /** 输出 WAV（相对工程根解析；缺省 assets/voice/<音色>.wav） */
  out?: string;
  speed?: number;
  /** 停顿归一化（缺省按音色档案的 pause_cap） */
  normalize?: boolean;
  endpoint?: string;
  /** 多段时的段间静音（秒，默认 0.62） */
  gap?: number;
  /** 多段时的起始留白（秒，默认 0.80） */
  lead?: number;
  /** 混音峰值（dBFS，默认 -1.5） */
  peak?: number;
}

function db(x: number): string {
  return Number.isFinite(x) ? `${x.toFixed(2)} dB` : '-inf dB';
}

function msg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function ttsPost(endpoint: string, body: Record<string, unknown>, timeoutMs = 900_000): Promise<Buffer> {
  const res = await httpCall(endpoint, { method: 'POST', json: body, timeoutMs });
  if (res.status < 200 || res.status >= 300) {
    let detail = res.buf.toString('utf8', 0, 400);
    try {
      detail = (JSON.parse(res.buf.toString('utf8')) as { error?: string }).error ?? detail;
    } catch {
      /* 保留原文 */
    }
    throw new Error(`HTTP ${res.status}: ${detail}`);
  }
  return res.buf;
}

/**
 * 轻量 HTTP 调用（node:http，agent:false 每次新建连接）。
 * 不用全局 fetch：undici 的保活连接会让 CLI 退出时触发 libuv 断言崩溃
 * （Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)，src/win/async.c）。
 */
function httpCall(
  url: string,
  opts: { method?: string; json?: unknown; timeoutMs?: number } = {},
): Promise<{ status: number; buf: Buffer }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const payload = opts.json === undefined ? undefined : Buffer.from(JSON.stringify(opts.json), 'utf8');
    const req = mod.request(
      u,
      {
        method: opts.method ?? 'GET',
        agent: false,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length), Connection: 'close' }
          : { Connection: 'close' },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c as Buffer));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, buf: Buffer.concat(chunks) }));
      },
    );
    req.setTimeout(opts.timeoutMs ?? 30_000, () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function voiceFacts(v: VoiceEntry): string[] {
  const d = v.data;
  const has = fs.existsSync(d.ref_audio);
  const facts = [
    `${v.id}（${d.label ?? v.name}）${v.status === 'draft' ? ' [draft]' : ''}`,
    `  端点 ${d.endpoint}`,
    `  参考音 ${d.ref_audio}${has ? '' : ' —— 文件不存在！'}`,
    `  参考文本 ${d.ref_text.slice(0, 40)}${d.ref_text.length > 40 ? '…' : ''}`,
    `  语速 ${d.speed ?? 1.0}｜停顿归一化 ${d.pause_cap === null ? '关' : `>${d.pause_cap?.max_pause ?? 0.5}s → ${d.pause_cap?.to ?? 0.46}s`}`,
  ];
  if (d.model) facts.push(`  模型 ${d.model.sovits ?? '-'} / ${d.model.gpt ?? '-'}`);
  return facts;
}

export async function toolVoice(ctx: AgentContext, args: VoiceArgs): Promise<ToolResult<unknown>> {
  const action = args.action;

  if (action === 'list') {
    const all = listVoices();
    if (all.length === 0) {
      return fail('voice', 'E-VOICE-001', '音色库为空', {
        facts: ['用 kine forge create --kind voice 建档案，再 register'],
        hints: ['音色 = 参考音频(3–10s, 自然语音) + 参考文本 + 端点'],
      });
    }
    const def = readVoiceDefaults().default ?? resolveVoice(undefined)?.id ?? null;
    const facts = all.flatMap((v) => [`${v.id === def ? '★ ' : '  '}${v.id}（${v.data.label ?? v.name}）${v.status === 'draft' ? ' [draft]' : ''}`]);
    return ok('voice', { voices: all, default: def }, {
      facts,
      hints: [`★ = 标配音色；用 kine voice synth --name <id> 合成`, `切换标配：kine voice default --name <id>`],
    });
  }

  if (action === 'show') {
    const v = resolveVoice(args.name, undefined);
    if (!v) return fail('voice', 'E-VOICE-002', `未找到音色 ${args.name ?? '(默认)'}`, { facts: listVoices().map((x) => x.id) });
    const facts = voiceFacts(v);
    let probe: Record<string, unknown> | null = null;
    try {
      const r = await httpCall(v.data.endpoint.replace(/\/tts$/, '/health'), { timeoutMs: 3000 });
      probe = JSON.parse(r.buf.toString('utf8')) as Record<string, unknown>;
      facts.push(`  服务探活 /health → ${JSON.stringify(probe)}`);
    } catch (e) {
      facts.push(`  服务探活失败：${msg(e)}（合成前先启动 TTS 服务）`);
    }
    return ok('voice', { voice: v, health: probe }, { facts });
  }

  if (action === 'default') {
    const all = listVoices();
    if (all.length === 0) return fail('voice', 'E-VOICE-001', '音色库为空');
    const v = args.name ? resolveVoice(args.name) : null;
    if (!v) {
      return fail('voice', 'E-VOICE-002', `未找到音色 ${args.name ?? '(空)'}`, {
        facts: all.map((x) => `${x.id}（${x.data.label ?? x.name}）`),
        hints: ['kine voice default --name <id>'],
      });
    }
    setDefaultVoice(v.id);
    return ok('voice', { default: v.id }, { facts: [`标配配音音色 → ${v.id}（${v.data.label ?? v.name}）`] });
  }

  if (action !== 'synth') {
    return fail('voice', 'E-VOICE-003', `未知 action ${action}`, { facts: ['可用：list | show | synth | default'] });
  }

  // ---- synth ----
  const v = resolveVoice(args.name, undefined);
  if (!v) {
    return fail('voice', 'E-VOICE-002', `未找到音色 ${args.name ?? '(默认)'}`, {
      facts: listVoices().map((x) => `${x.id}（${x.data.label ?? x.name}）`),
    });
  }
  const d: VoiceData = v.data;
  const endpoint = args.endpoint ?? d.endpoint;
  if (!endpoint) return fail('voice', 'E-VOICE-004', '音色档案缺 endpoint');

  let segments: string[] = [];
  if (args.file) {
    const f = path.isAbsolute(args.file) ? args.file : path.resolve(ctx.dir, args.file);
    if (!fs.existsSync(f)) return fail('voice', 'E-VOICE-005', `文本文件不存在：${f}`);
    segments = fs
      .readFileSync(f, 'utf8')
      .split(/\r?\n/)
      .map((s) => s.trim())
      .filter((s) => s && !s.startsWith('#'));
  }
  if (args.text && args.text.trim()) segments = [args.text.trim()];
  if (segments.length === 0) {
    return fail('voice', 'E-VOICE-006', '需要 --text 或 --file（按行分段）', {
      facts: [`例：kine voice synth --name ${v.id} --file script.txt --out assets/narration.wav`],
    });
  }

  const speed = args.speed ?? d.speed ?? 1.0;
  const doNorm = args.normalize ?? d.pause_cap !== null;
  const cap = d.pause_cap ?? { max_pause: 0.5, to: 0.46 };

  const pieces: Float32Array[] = [];
  let sr = 32000;
  const rows: Array<Record<string, number>> = [];
  try {
    for (const [i, text] of segments.entries()) {
      const raw = await ttsPost(endpoint, {
        text,
        format: 'wav',
        speed,
        language: d.language ?? 'Chinese',
        ref_audio: d.ref_audio,
        ref_text: d.ref_text,
      });
      const wav = readWavPcm16(raw);
      sr = wav.sr;
      const st = pauseStats(wav.samples, sr);
      const out = doNorm ? normalizePauses(wav.samples, sr, cap) : { samples: wav.samples, before: st, after: st };
      pieces.push(out.samples.subarray() as Float32Array);
      rows.push({
        seg: i + 1,
        dur: out.samples.length / sr,
        pauses: out.after.count,
        pause_total: Math.round(out.after.total * 100) / 100,
        longest_pause: out.after.longest,
        peak_db: Math.round(peakDb(out.samples) * 100) / 100,
      });
    }
  } catch (e) {
    return fail('voice', 'E-VOICE-007', `合成失败：${msg(e)}`, {
      facts: [`端点 ${endpoint}`, '确认 TTS 服务已启动（GET /health）'],
    });
  }

  const LEAD = args.lead ?? 0.8;
  const GAP = args.gap ?? 0.62;
  const n = pieces.length;
  const speech = pieces.reduce((s, p) => s + p.length / sr, 0);
  const total = LEAD + speech + GAP * Math.max(0, n - 1) + 1.0;
  const NN = Math.round(total * sr);
  const mix = new Float32Array(NN);
  const starts: number[] = [];
  let cur = LEAD;
  for (const [i, p] of pieces.entries()) {
    starts.push(Math.round(cur * 1000) / 1000);
    const o = Math.round(cur * sr);
    for (let k = 0; k < p.length && o + k < NN; k++) mix[o + k] += p[k];
    cur += p.length / sr + (i < n - 1 ? GAP : 0);
  }
  const target = 10 ** ((args.peak ?? -1.5) / 20);
  const pk = peakDb(mix);
  if (Number.isFinite(pk) && pk > -Infinity) {
    const g = 10 ** (((args.peak ?? -1.5) - pk) / 20);
    for (let i = 0; i < NN; i++) mix[i] = Math.max(-1, Math.min(1, mix[i] * g));
  }

  const rel = args.out ?? path.join('assets', 'voice', `${v.name}.wav`);
  const outFile = path.isAbsolute(rel) ? rel : path.resolve(ctx.store?.root ?? ctx.dir, rel);
  writeWavPcm16(outFile, mix, sr);

  let schedule: string | null = null;
  if (n > 1) {
    schedule = `${outFile.replace(/\.wav$/i, '')}.schedule.json`;
    fs.writeFileSync(
      schedule,
      JSON.stringify({ starts, dur: rows.map((r) => Math.round(r.dur * 1000) / 1000), total: Math.round(total * 1000) / 1000, gap: GAP, lead: LEAD, voice: v.id, speed }, null, 2),
    );
  }

  const facts = [
    `音色 ${v.id}（${d.label ?? v.name}）· 语速 ${speed} · 停顿归一化 ${doNorm ? `>${cap.max_pause}s→${cap.to}s` : '关'}`,
    `旁白 ${outFile}：${(NN / sr).toFixed(3)}s @ ${sr}Hz，峰值 ${db(peakDb(mix))}（原 ${db(pk)}）`,
    ...rows.map((r) => `  段${r.seg} ${r.dur.toFixed(2)}s 停顿 ${r.pauses} 个/${r.pause_total}s（最长 ${r.longest_pause}s）峰值 ${r.peak_db}dB`),
  ];
  if (schedule) facts.push(`分段 schedule：${schedule}（starts/dur 可直接对齐幕时长）`);

  return ok('voice', { file: outFile, schedule, voice: v.id, segments: rows, total: NN / sr, peak_db: peakDb(mix) }, {
    facts,
    hints: [
      '要贴合既有画面时间轴：先用 schedule.dur 与幕时长比对，再用 ffmpeg atempo 逐段微调（≤6% 不影响听感）',
      '参考音硬约束：3–10 秒、自然连续语音、ref_text 逐字一致',
    ],
    nextActions: [{ tool: 'voice', args: { action: 'show', name: v.id } }],
  });
}

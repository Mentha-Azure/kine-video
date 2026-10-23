// voice 音色档案校验 + 停顿归一化（v7：kine 配音音色）
import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { normalizePauses, pauseStats, peakDb, readWavPcm16, writeWavPcm16 } from '@kine/store';
import { validateForgeData } from '@kine/agent';

const SR = 32000;

function tone(sec: number, amp = 0.5): Float32Array {
  const n = Math.round(sec * SR);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = amp * Math.sin((2 * Math.PI * 220 * i) / SR);
  return a;
}
function sil(sec: number): Float32Array {
  return new Float32Array(Math.round(sec * SR));
}
function cat(...parts: Float32Array[]): Float32Array {
  const n = parts.reduce((s, p) => s + p.length, 0);
  const o = new Float32Array(n);
  let k = 0;
  for (const p of parts) {
    o.set(p, k);
    k += p.length;
  }
  return o;
}

describe('停项归一化（音色配音的关键后处理）', () => {
  it('把 >0.5s 的停顿压到 0.46s，保留短停顿，语音一个采样不动', () => {
    const input = cat(tone(1), sil(1.0), tone(1), sil(0.3), tone(1));
    const before = pauseStats(input, SR);
    const { samples, after } = normalizePauses(input, SR, { max_pause: 0.5, to: 0.46 });
    expect(before.list).toHaveLength(2);
    expect(after.list.every((p) => p <= 0.47)).toBe(true);
    // 只砍掉长停顿多出来的 0.54s
    expect(before.total - after.total).toBeCloseTo(0.54, 2);
    // 语音时长不变（1+1+1）
    expect(input.length / SR - before.total).toBeCloseTo(samples.length / SR - after.total, 4);
  });

  it('没有超长停顿时原样返回', () => {
    const input = cat(tone(1), sil(0.2), tone(1));
    const { samples } = normalizePauses(input, SR, { max_pause: 0.5, to: 0.46 });
    expect(samples.length).toBe(input.length);
  });

  it('peakDb 正确', () => {
    expect(peakDb(new Float32Array([0, 0.5, -0.5]))).toBeCloseTo(20 * Math.log10(0.5), 6);
    expect(peakDb(new Float32Array([0, 0]))).toBe(-Infinity);
  });
});

describe('WAV 读写往返', () => {
  it('写 16-bit 单声道再读回来，采样一致（量化误差内）', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'kine-voice-'));
    try {
      const src = cat(tone(0.5), sil(0.1), tone(0.5));
      const f = path.join(dir, 't.wav');
      writeWavPcm16(f, src, SR);
      const back = readWavPcm16(require('node:fs').readFileSync(f));
      expect(back.sr).toBe(SR);
      expect(back.channels).toBe(1);
      expect(back.samples.length).toBe(src.length);
      let maxErr = 0;
      for (let i = 0; i < src.length; i++) maxErr = Math.max(maxErr, Math.abs(back.samples[i] - src[i]));
      expect(maxErr).toBeLessThan(1 / 32767 + 1e-6);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('音色档案（forge kind=voice）校验', () => {
  const base = {
    endpoint: 'http://127.0.0.1:9880/tts',
    ref_audio: __filename, // 任意存在文件（本测试文件自身）
    ref_text: '参考文本',
  };

  it('合法档案通过', () => {
    const { errors } = validateForgeData('voice', { ...base, speed: 1.0, pause_cap: { max_pause: 0.5, to: 0.46 } });
    expect(errors).toEqual([]);
  });

  it('端点非法 / 参考音不存在 / 缺参考文本 → 报错', () => {
    expect(validateForgeData('voice', { ...base, endpoint: 'ftp://x' }).errors.join()).toMatch(/endpoint/);
    expect(validateForgeData('voice', { ...base, ref_audio: 'D:/nope/none.wav' }).errors.join()).toMatch(/不存在/);
    expect(validateForgeData('voice', { ...base, ref_text: '  ' }).errors.join()).toMatch(/ref_text/);
  });

  it('pause_cap 顺序错误 / speed 越界 → 报错', () => {
    expect(validateForgeData('voice', { ...base, pause_cap: { max_pause: 0.3, to: 0.5 } }).errors.join()).toMatch(/pause_cap/);
    expect(validateForgeData('voice', { ...base, speed: 2 }).errors.join()).toMatch(/speed/);
  });
});

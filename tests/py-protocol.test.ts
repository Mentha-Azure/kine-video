// pyside 协议解析 + 全静音 wav 统计回归（测试反馈 P0 链条：-Infinity → JSON.parse 失败 → 请求挂死）
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { getKinePy, parseProtocolLine, shutdownKinePy } from '@kine/store';

const dir = mkdtempSync(path.join(tmpdir(), 'kine-silent-'));
const wav = path.join(dir, 'silent.wav');

/** 写一个全零 PCM16 单声道 wav */
function silentWav(file: string, seconds: number, sr = 48000): void {
  const n = Math.round(seconds * sr);
  const data = Buffer.alloc(n * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(sr, 24);
  h.writeUInt32LE(sr * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  writeFileSync(file, Buffer.concat([h, data]));
}

describe('pyside 协议行解析', () => {
  it('标准 JSON 行直接解析', () => {
    const m = parseProtocolLine('{"id":1,"ok":true,"data":{"x":1}}');
    expect(m?.ok).toBe(true);
    expect((m?.data as { x: number }).x).toBe(1);
  });

  it('-Infinity/NaN 净化重试且记诊断（P0 防护）', () => {
    const diag: string[] = [];
    const m = parseProtocolLine('{"id":2,"ok":true,"data":{"peak":-Infinity,"n":NaN}}', diag);
    expect(m?.ok).toBe(true);
    expect((m?.data as { peak: unknown }).peak).toBeNull();
    expect((m?.data as { n: unknown }).n).toBeNull();
    expect(diag.length).toBe(1);
  });

  it('垃圾行返回 null 不抛', () => {
    expect(parseProtocolLine('not-json{')).toBeNull();
  });
});

describe('全静音 wav 统计（P0 回归）', () => {
  it('audio_stats / window_levels 返回有限值且可严格反序列化', async () => {
    silentWav(wav, 0.5);
    const py = await getKinePy();
    const stats = (await py.call('audio_stats', { wav })) as Record<string, unknown>;
    for (const k of ['peakDbfs', 'rmsDbfs', 'tailPeakDbfs']) {
      expect(typeof stats[k]).toBe('number');
      expect(Number.isFinite(stats[k] as number)).toBe(true);
    }
    expect(stats.peakDbfs as number).toBeLessThan(-150); // SILENT_DBFS(-200) 而非 -Infinity
    const wl = (await py.call('window_levels', { wav, windows: [[0, 0.5]] })) as unknown;
    expect(JSON.stringify(wl)).not.toMatch(/Infinity|NaN/);
  }, 120_000);
});

afterAll(() => {
  shutdownKinePy();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

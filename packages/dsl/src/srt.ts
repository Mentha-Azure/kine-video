// @kine/dsl — SRT 字幕解析（v5）
export interface SrtCue {
  from: number;
  to: number;
  text: string;
}

const TIME_RE = /(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})\s*-->\s*(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/;

function toSec(h: string, m: string, s: string, ms: string): number {
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms.padEnd(3, '0')) / 1000;
}

/** 解析 SRT 文本 → cue 列表（成片秒）；忽略序号行，容忍 CRLF/BOM。 */
export function parseSrt(text: string): { cues: SrtCue[]; bad: number } {
  const blocks = text.replace(/^\uFEFF/, '').split(/\r?\n\r?\n+/);
  const cues: SrtCue[] = [];
  let bad = 0;
  for (const b of blocks) {
    const lines = b.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length < 1) continue;
    const ti = lines.findIndex((l) => TIME_RE.test(l));
    if (ti < 0) {
      bad += 1;
      continue;
    }
    const m = TIME_RE.exec(lines[ti]!)!;
    const from = toSec(m[1]!, m[2]!, m[3]!, m[4]!);
    const to = toSec(m[5]!, m[6]!, m[7]!, m[8]!);
    const body = lines.slice(ti + 1).join('\n');
    if (!body.trim() || to <= from) {
      bad += 1;
      continue;
    }
    cues.push({ from: +from.toFixed(3), to: +to.toFixed(3), text: body.trim() });
  }
  cues.sort((a, b2) => a.from - b2.from);
  return { cues, bad };
}

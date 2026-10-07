// 断言 expect 语法： "<op> <阈值><单位>?"，op ∈ >= <= == != > < ；或 "in <a>..<b>"
// 单位：%（比例→百分比）、px、dB、ms、s、°（度）、count/x（无量纲）
export interface ExpectParsed {
  op: '>=' | '<=' | '==' | '!=' | '>' | '<' | 'in';
  threshold?: number;
  range?: [number, number];
  unit: string | null;
  raw: string;
}

const UNIT_ALIASES: Record<string, string> = {
  '%': '%', 'percent': '%',
  'px': 'px', 'p': 'px',
  'db': 'dB', 'dbFS': 'dB', 'dbsp': 'dB',
  'ms': 'ms',
  's': 's', 'sec': 's',
  '°': 'deg', 'deg': 'deg',
  'x': 'x', 'count': 'x', 'frames': 'x',
};

export function parseExpect(s: string): ExpectParsed {
  const raw = s.trim();
  const inM = /^in\s+(-?[\d.]+)\s*\.\.\s*(-?[\d.]+)\s*([^\s]*)$/i.exec(raw);
  if (inM) {
    return {
      op: 'in',
      range: [Number(inM[1]), Number(inM[2])],
      unit: normalizeUnit(inM[3] ?? ''),
      raw,
    };
  }
  const m = /^(>=|<=|==|!=|>|<)\s*(-?[\d.]+)\s*([^\s]*)$/.exec(raw);
  if (!m) throw new Error(`断言 expect 无法解析: "${s}"（支持 ">= 0.9%", "in 6..9", "== 0"）`);
  return {
    op: m[1] as ExpectParsed['op'],
    threshold: Number(m[2]),
    unit: normalizeUnit(m[3] ?? ''),
    raw,
  };
}

function normalizeUnit(u: string): string | null {
  if (!u) return null;
  return UNIT_ALIASES[u] ?? UNIT_ALIASES[u.toLowerCase()] ?? u;
}

/** 阈值换算到指标的标准单位（density 等指标的标准单位是比例 0.0094 而非 0.94%） */
export function thresholdInMetricUnit(p: ExpectParsed): number | [number, number] | null {
  const conv = (v: number) => (p.unit === '%' ? v / 100 : v);
  if (p.op === 'in' && p.range) return [conv(p.range[0]), conv(p.range[1])];
  if (p.threshold === undefined) return null;
  return conv(p.threshold);
}

export interface CheckOptions {
  /** 多采样时：样本最小值（>= 类断言的最坏情况） */
  min?: number;
  /** 多采样时：样本最大值（<= 类断言的最坏情况） */
  max?: number;
}

/** 对代表值/样本极值执行期望检查。value 为单值；in 用 min/max。 */
export function checkExpect(p: ExpectParsed, value: number, opts: CheckOptions = {}): boolean {
  const t = thresholdInMetricUnit(p);
  switch (p.op) {
    case '>=': return value >= (t as number);
    case '<=': return value <= (t as number);
    case '>': return value > (t as number);
    case '<': return value < (t as number);
    case '==': return value === (t as number);
    case '!=': return value !== (t as number);
    case 'in': {
      const lo = (t as [number, number])[0];
      const hi = (t as [number, number])[1];
      const mn = opts.min ?? value;
      const mx = opts.max ?? value;
      return mn >= lo && mx <= hi;
    }
  }
}

export function expectUnit(p: ExpectParsed): string | null {
  return p.unit;
}

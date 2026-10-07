// @kine/dsl — 确定性随机（单一真源）
//   L-PURE-001：禁止 Math.random / crypto.getRandomValues；一切随机来自
//   rng = mulberry32(hash32(`${seed}:${channel}:${index}`))，通道名稳定。
export function fnv1a32(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 通道式确定性随机：rng(channel, index) ∈ [0,1)（纯函数，可重复调用） */
export type Rng = (channel: string, index: number) => number;

export function makeRng(seed: number | string): Rng {
  const s = String(seed);
  return (channel, index) => mulberry32(fnv1a32(`${s}:${channel}:${index}`))();
}

/** 连续序列：同一通道上取 index0, index0+1, ... 的流式采样（内部一次性生成，禁止跨帧复用实例） */
export function makeRngSeq(seed: number | string, channel: string, index0 = 0): () => number {
  const s = String(seed);
  let i = index0;
  return () => mulberry32(fnv1a32(`${s}:${channel}:${i++}`))();
}

const HEX8 = (n: number) => (n >>> 0).toString(16).padStart(8, '0');

/** 64 位（双 32 位通道）字符串 hash，用于 stateHash 等运行期比较（非加密） */
export function hash64(str: string): string {
  return HEX8(fnv1a32('k1:' + str)) + HEX8(fnv1a32('k2:' + str));
}

export function frac(x: number): number {
  return x - Math.floor(x);
}

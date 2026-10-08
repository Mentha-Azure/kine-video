// @kine/store — 全局路径（Kine 用户级目录，单一真源）
//
// 注：agent/resolve.ts 内保留了一份等价的 kineHome（避免 store 与 agent 间
// 无意义的循环依赖）；两边都以 KINE_HOME 环境变量优先。
import * as os from 'node:os';
import * as path from 'node:path';

/** Kine 用户级数据根目录（KINE_HOME 可覆盖；默认 ~/.local/share/kine） */
export function kineHome(): string {
  return process.env.KINE_HOME?.trim() || path.join(os.homedir(), '.local', 'share', 'kine');
}

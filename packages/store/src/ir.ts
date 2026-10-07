// @kine/store — IR 读写（.kine/ir/project.ir.json）
import fs from 'node:fs';
import type { KineIR } from '@kine/dsl';
import { atomicWriteFile, readJsonFile } from './layout';
import type { ProjectStore } from './project';

export function writeIR(store: ProjectStore, ir: KineIR): string {
  atomicWriteFile(store.layout.irFile, JSON.stringify(ir, null, 2) + '\n');
  return store.layout.irFile;
}

export function readIR(store: ProjectStore): KineIR | null {
  if (!fs.existsSync(store.layout.irFile)) return null;
  try { return readJsonFile<KineIR>(store.layout.irFile); } catch { return null; }
}

/** 读取 IR 的 specHash（不存在返回 null）；用于缓存失效判断与 doctor */
export function irSpecHash(store: ProjectStore): string | null {
  const ir = readIR(store);
  return ir?.specHash ?? null;
}

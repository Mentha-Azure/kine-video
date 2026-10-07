// @kine/store — 工程句柄：打开工程、读取/装载 timeline.yaml
import fs from 'node:fs';
import { loadProject, type LoadedProject } from '@kine/dsl';
import { ensureLayout, findProjectRoot, projectLayout, type ProjectLayout } from './layout';

export interface ProjectStore {
  /** 工程根目录绝对路径 */
  root: string;
  layout: ProjectLayout;
  /** 每次读取最新文件内容（不做缓存，保证读到别的进程刚写的版本） */
  load(): LoadedProject;
  readTimeline(): string;
}

export interface OpenProjectOptions {
  /** 目录不存在 timeline.yaml 时创建基础骨架 */
  init?: { id: string; title: string };
}

export function openProject(dirOrFile: string, opts: OpenProjectOptions = {}): ProjectStore {
  let root: string;
  try {
    root = findProjectRoot(dirOrFile);
  } catch (e) {
    if (!opts.init) throw e;
    // init：以给定目录为根，写最小骨架（实际内容由 agent 的 init 命令提供）
    root = fs.existsSync(dirOrFile) && fs.statSync(dirOrFile).isFile() ? dirOrFile : dirOrFile;
    fs.mkdirSync(root, { recursive: true });
  }
  const layout = projectLayout(root);
  ensureLayout(layout);
  return {
    root,
    layout,
    load: () => loadProject(layout.timelineFile),
    readTimeline: () => fs.readFileSync(layout.timelineFile, 'utf8'),
  };
}

export function hasProject(dirOrFile: string): boolean {
  try {
    findProjectRoot(dirOrFile);
    return true;
  } catch {
    return false;
  }
}

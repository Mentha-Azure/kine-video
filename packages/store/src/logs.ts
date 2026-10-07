// @kine/store — 工具调用日志：.kine/logs/<ts>_<tool>.jsonl，每次 CLI/MCP 调用写一条
import fs from 'node:fs';
import path from 'node:path';
import { tsStamp } from './layout';

export interface ToolLogEntry {
  ts: string;
  tool: string;
  actor: 'cli' | 'mcp' | 'internal';
  args?: unknown;
  ok: boolean;
  ms: number;
  resultSummary?: string;
  error?: { code?: string; message: string };
  tx?: string;
}

export function logToolCall(logsDir: string, entry: Omit<ToolLogEntry, 'ts'> & { ts?: string }): string {
  fs.mkdirSync(logsDir, { recursive: true });
  const ts = entry.ts ?? new Date().toISOString();
  const file = path.join(logsDir, `${tsStamp(new Date(ts))}_${entry.tool.replace(/[^a-zA-Z0-9._-]/g, '_')}.jsonl`);
  fs.appendFileSync(file, JSON.stringify({ ...entry, ts }) + '\n');
  return file;
}

export function readToolLogs(logsDir: string, limit = 50): ToolLogEntry[] {
  if (!fs.existsSync(logsDir)) return [];
  const files = fs.readdirSync(logsDir).filter((f) => f.endsWith('.jsonl')).sort().slice(-limit);
  const out: ToolLogEntry[] = [];
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(logsDir, f), 'utf8').split('\n')) {
      const s = line.trim();
      if (!s) continue;
      try { out.push(JSON.parse(s) as ToolLogEntry); } catch { /* skip */ }
    }
  }
  return out;
}

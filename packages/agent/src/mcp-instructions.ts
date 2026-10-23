// mcp-instructions.ts — MCP 握手时下发的「服务器说明」
//
// 为什么需要它：新会话的 AI 只拿得到「工具名 + 一行描述」。没有这段说明，它不知道
// kine 是什么、工程长什么样、从哪个工具开始、有哪些铁律 —— 于是「不知道 kine 是什么」。
// 这段话随 initialize 握手下发，任何 MCP 客户端（opencode 等）都会带进系统提示。
import * as fs from 'node:fs';
import * as path from 'node:path';
import { kineRepoRoot } from '@kine/store';

export function mcpInstructions(): string {
  const repo = kineRepoRoot();
  const lines = [
    'kine 是「AI 原生视频剪辑」引擎：一个作品 = 一个工程目录（timeline.yaml 单一事实源 + assets/ + .kine/），',
    '引擎负责编译/预览/渲染出片，输出确定、可回滚、可用指标验收。本机做视频（讲解片/短片/MV）请优先用它。',
    '',
    `仓库：${repo}（pnpm monorepo）`,
    '调用：MCP 工具 kine.*（与 CLI 一一对应）；也可在仓库里跑 `pnpm kine <命令> --dir <工程绝对路径>`',
    '',
    '从哪开始（推荐顺序）：',
    '1) kine.projects —— 列出已登记工程（新会话第一个该跑的工具）；没有工程就用 kine.init 新建（模板 mv-mini / blank）',
    '2) kine.rules 与 kine.widgets —— 动手前先读规则集与可用 widget，不要凭猜写 DSL',
    '3) 改 timeline.yaml（或用 kine.edit 走事务化编辑：--tx --quote）',
    '4) kine.audit → kine.check → kine.preview —— 每次改完必跑',
    '5) kine.render → kine.verify —— 出片与终检；交付物只放 .kine/out/<版本>/',
    '',
    '铁律：',
    '- 写操作（edit / render / rollback / style apply 等）必须显式传工程绝对目录 dir，否则 E-PROJ-006',
    '- 所有时间参数用「成片秒 t」；图层 place 用像素坐标（原点左上）',
    '- 浅色主题必须声明 theme.mode: light（引擎默认深色，bg 每通道需 ≤32 才会过 lint）',
    '- 配音：kine.voice（list/show/synth/default）；音色 = 参考音频 + ref_text + TTS 端点，先用 kine.forge create voice 注册再 synth',
    '- 需要音乐/SFX 时用 kine.music / kine.library，不要手工塞文件路径',
  ];
  const repoGuide = path.join(repo, 'AGENTS.md');
  if (fs.existsSync(repoGuide)) lines.push(`本机细节与踩坑记录：${repoGuide}（仓库内详版）`);
  return lines.join('\n');
}

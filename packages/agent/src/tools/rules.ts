// @kine/agent — rules：规则注册表（P13 护栏可解释）
//
// 供 `kine rules` 工具与 MCP 资源 kine://rules 使用：每条规则给出
// 触发含义（meaning）与修复建议（fix），错误码与 audit/lint/metrics 保持一致。
import type { AgentContext } from '../context';
import { ok, type ToolResult } from '../types';

export interface RuleInfo {
  code: string;
  severity: 'error' | 'warn' | 'info';
  scope: string;
  meaning: string;
  fix: string;
}

export const RULES: RuleInfo[] = [
  // ---- purity / 确定性
  { code: 'L-PURE-001', severity: 'error', scope: 'runtime/widgets 源码', meaning: '使用了 Math.random / crypto.getRandomValues（破坏逐帧确定性）', fix: '改用 rng(`${通道名}`, index)——通道名稳定、每帧按索引重算' },
  { code: 'L-PURE-002', severity: 'error', scope: 'runtime/widgets 源码', meaning: '累积状态（x += v 之类跨帧记忆）', fix: '由 T/lt 全量重算（第 N 帧 = f(N)）' },
  { code: 'L-PURE-003', severity: 'error', scope: 'runtime/widgets 源码', meaning: '使用 Date.now / performance.now / new Date（墙钟时间）', fix: '用传入的 t/lt/T；时间只来自 map' },
  { code: 'L-PURE-004', severity: 'error', scope: 'runtime/widgets 源码', meaning: 'CSS 自走动画（animation/@keyframes）', fix: '改由 jump(T) 驱动绘制；overlay 模式禁自走' },
  // ---- schema / 结构
  { code: 'E-SCHEMA-001', severity: 'error', scope: 'timeline.yaml', meaning: 'YAML 语法/结构错误（带行号）', fix: '按报错行修复；unknown 字段见 W-SCHEMA-001' },
  { code: 'E-SCHEMA-002', severity: 'error', scope: 'timeline.yaml', meaning: '字段类型不符（如 dur 写成字符串）', fix: '对照 kine probe/compile 报错的字段路径修正' },
  { code: 'W-SCHEMA-001', severity: 'warn', scope: 'timeline.yaml', meaning: '未知字段（不会被使用）', fix: '删除或查阅文档改正确字段名；--strict 升为错误' },
  { code: 'E-ID-001', severity: 'error', scope: 'timeline.yaml', meaning: 'id 未全局唯一（scene/layer/assert/pace/bus）', fix: '重命名重复 id；find 依赖稳定唯一 id' },
  // ---- 时间
  { code: 'E-TIME-001', severity: 'error', scope: '时间轴', meaning: 'Σscenes.dur 与 pace 映射后的 output.duration 偏差 > 1 帧', fix: '改 scenes.dur 或 output.duration 使两者对齐' },
  { code: 'E-TIME-002', severity: 'error', scope: 'pace/scenes', meaning: 'pace.until 非严格递增 / 末项 ≠ duration / Σshots.dur ≠ scene.dur', fix: '修 pace 段或 shot 时长（±2 帧容差）' },
  { code: 'E-TIME-003', severity: 'error', scope: '工具参数', meaning: '时间/帧号越界', fix: '用 kine map 查有效范围后重调' },
  // ---- 相机 / 后处理 / 色彩
  { code: 'E-CAM-001', severity: 'error', scope: 'scenes[].camera.tw', meaning: 'tw > 2.0 超出震屏硬上限', fix: '下调 tw；验收看 cam_jitter p99 ≤ 2px' },
  { code: 'W-CAM-002', severity: 'warn', scope: 'camera.bpm', meaning: 'bpm 异常（强拍呼吸节律）', fix: '核对 bpm 与音乐分析（kine music info）' },
  { code: 'W-CAM-003', severity: 'warn', scope: 'camera.z1', meaning: 'z1 缩放超出常规区间', fix: 'z1>1 时注意 HUD 安全边距（E-HUD-001）' },
  { code: 'W-POST-001', severity: 'warn', scope: 'theme.post.vignette', meaning: '暗角超硬上限（k≤0.90）', fix: '下调 base/tw_gain/beat_gain；--strict 升为错误' },
  { code: 'W-POST-002', severity: 'warn', scope: 'theme.post.scanline', meaning: '扫描线超硬上限（≤0.12）', fix: '下调 scanline.base/tw_gain' },
  { code: 'W-POST-003', severity: 'warn', scope: 'theme.post.flash', meaning: '强拍白闪峰值超硬上限（≤0.085）', fix: '下调 flash.max_alpha' },
  { code: 'W-POST-004', severity: 'warn', scope: 'theme.post', meaning: '后处理参数越界（通用）', fix: '对照 facts 中的上限值点亮 clamp' },
  { code: 'E-AUD-003', severity: 'error', scope: 'theme.post.flash.mode', meaning: 'flash.mode=env 用能量包络驱动提亮——历史灰白病根因（RGB(6,6,8)→(28,28,32)）', fix: '改回 transient（瞬态驱动 GATE .005/GAIN 130/DECAY .80）' },
  { code: 'E-COLOR-001', severity: 'error', scope: 'theme.accent / accent_secondary', meaning: '强调色纪律：core 必须 #ff2e3f；extended/free 必须 == palette 值', fix: '改用当前 palette 的 accent；或者把色板做成库条目' },
  { code: 'E-COLOR-002', severity: 'error', scope: 'theme.bg / 色板 bg', meaning: '背景过亮（通道 > 32）会发灰（含色板注册期把关，v3 P0-3）', fix: '压暗背景（RGB 6–9 最稳）；黑电平由 black_level 指标把关' },
  { code: 'E-COLOR-003', severity: 'error', scope: 'theme.palette', meaning: 'profile=core 不允许设置 palette', fix: '加 theme.profile: extended（kine style apply --ref …）' },
  { code: 'W-FONT-001', severity: 'warn', scope: 'theme.font', meaning: '非等宽字体（破坏确定性/风格一致性）', fix: '使用等宽字体（Consolas 等）' },
  // ---- 版式 / HUD / 转场
  { code: 'E-HUD-001', severity: 'error', scope: 'layers[].place', meaning: 'z1>1 时贴边 HUD 会被推出画面（安全边距不足）', fix: '内缩内容（max(96, W*0.095) 起排）或降低 z1' },
  { code: 'W-HUD-002', severity: 'warn', scope: 'layers[].place', meaning: '元素超出画布范围', fix: '调整 place 坐标/尺寸' },
  { code: 'W-XF-001', severity: 'warn', scope: 'shots[].transition', meaning: '相邻镜头用了同一种转场（单调）', fix: '换用 transition 库其它种类' },
  { code: 'W-ACC-001', severity: 'warn', scope: 'scenes[].accel', meaning: 'accel=cut 会压缩幕内动画并在幕尾保持末姿', fix: '用 kine explain 查看有效 lt；阈值类断言需重校' },
  // ---- 音频
  { code: 'E-AUD-001', severity: 'error', scope: 'audio.music', meaning: 'cut_from 早于淡出窗口结束（会截断淡出）', fix: 'cut_from ≥ fade_out.at + dur' },
  { code: 'E-AUD-004', severity: 'error', scope: 'audio.sfx.events[].bus', meaning: '事件引用了未声明的总线', fix: '在 audio.sfx.buses 声明该 bus' },
  { code: 'W-AUD-005', severity: 'warn', scope: 'audio', meaning: '收尾尾段不足（SFX 贴近片尾）', fix: '调大 audio.tail_fade（0.1–3）或提前收尾' },
  { code: 'W-SYNTH-001', severity: 'warn', scope: 'audio.sfx.events[].params', meaning: 'SFX 未知参数键（会被合成器静默忽略——死旋钮）', fix: '对照参数白名单（README「SFX 参数表」）改键名' },
  { code: 'W-SYNTH-002', severity: 'warn', scope: 'piano_motif.params.gain', meaning: 'gain > 0.5 会被合成器内部上限截断（静默降级）', fix: '参数保留 0–0.5；整体响度用事件级 gain' },
  { code: 'E-SYNTH-001', severity: 'error', scope: 'audio.sfx.events[].params 值', meaning: '合成器参数值类型/范围非法（如 piano_motif.notes 不是频率数组——render 期才会炸）', fix: '按参数规格修正：notes 用频率数组如 [220.0, 261.63, 329.63]；数字参数注意上下限' },
  { code: 'E-AUDIO-MIX-001', severity: 'error', scope: 'render/交付路径音频构建', meaning: '音频构建失败且交付路径为 strict（拒绝无声成片）', fix: '排查 audio 配置（sfx 参数/音乐文件）；或显式 render --no-audio 渲染无声版' },
  { code: 'W-LIB-002', severity: 'warn', scope: 'theme.palette', meaning: 'extended 色板与 core 视觉完全相同（profile 形同虚设——v3 实测同质化根因）', fix: '换差异化色板（kine library list --kind palette）或回到 profile: core' },
  { code: 'W-COLOR-004', severity: 'warn', scope: 'theme.palette', meaning: 'palette 生效时，timeline 中显式写的 theme.bg/text/text_dim/accent_secondary 会被静默覆盖（改了不生效——v4 反馈）', fix: '改色请改色板条目本身（kine forge save palette <name> --file …），或删除这些显式字段' },
  { code: 'W-TEXT-001', severity: 'warn', scope: 'text.content', meaning: '文本层含未知占位符（将被按字面显示）——v4 插值支持 {frame} {t} {T} {lt}（可带格式如 {t:.2f}）', fix: '检查拼写；受支持列表：{frame} {t} {T} {lt}' },
  { code: 'W-WIDGET-001', severity: 'warn', scope: 'widget.props', meaning: 'widget 不认识该 props 键（会被静默忽略——v4：对照 WIDGET_META 静态检查）', fix: 'kine widgets info <widget> 查看支持参数与默认值' },
  { code: 'E-PROJ-006', severity: 'error', scope: 'dir 解析', meaning: '写入类命令（edit/rollback/style）在「自动解析的工程目录」（向下扫描/登记表回退）上被拒绝执行——防不传 dir 时误改意外工程（v4 反馈）', fix: '显式指定：kine <命令> --dir <工程目录>（MCP 传 dir 参数）' },
  { code: 'E-RENDER-007', severity: 'error', scope: 'render 磁盘', meaning: '工作盘剩余空间不足 1GB，渲染中止以免写坏缓存（v4 反馈：C 盘收紧时渲染脆弱）', fix: 'kine cache gc 清理旧分片；或设置 KINE_WORK_DIR=D:\\kine-work 重定向工作目录' },
  // ---- 资源库 / 风格
  { code: 'E-LIB-001', severity: 'error', scope: 'library 引用', meaning: 'library:// 引用未找到条目', fix: 'kine library list 查看；或先 kine library add' },
  { code: 'E-LIB-002', severity: 'error', scope: 'library 引用', meaning: '引用歧义（标签/模糊命中多个候选）', fix: '用完整 id 或唯一 @tag 精确引用' },
  { code: 'E-LIB-003', severity: 'error', scope: 'palette 数据', meaning: '色板数据缺字段/格式非法', fix: '补齐 bg[2]/text/accent；参考 kine forge create palette 骨架' },
  { code: 'E-LIB-021', severity: 'error', scope: 'style apply', meaning: 'apply 缺少 --ref', fix: 'kine style apply --ref library://@tag --tx --quote "…"' },
  { code: 'E-LIB-023', severity: 'error', scope: 'forge register', meaning: '注册校验失败（保持 draft，不阻断创作）', fix: '按 facts 列出的问题修数据后重新 register' },
  // ---- 事务 / 工程定位
  { code: 'E-TX-001', severity: 'error', scope: 'edit', meaning: '空 patch（没有任何变更）', fix: '给出至少一个 set/del 操作' },
  { code: 'E-TX-002', severity: 'error', scope: 'edit --tx', meaning: '--quote 缺失或不合法（事务必须记录用户原话）', fix: '加 --quote "用户原话"（逐字）' },
  { code: 'E-TX-003', severity: 'error', scope: 'edit', meaning: 'patch 应用后 schema/lint 有 error，拒绝提交', fix: '按问题清单修 patch' },
  { code: 'E-TX-004', severity: 'error', scope: 'edit', meaning: 'patch 路径无法解析（id/下标不存在）', fix: '对照候选清单；kine find 先定位元素 id' },
  { code: 'E-TX-005', severity: 'error', scope: 'rollback', meaning: '找不到指定事务', fix: 'kine changelog 查看可用 txId' },
  { code: 'E-PROJ-001', severity: 'error', scope: '工程定位', meaning: '默认目录下未找到/无法推断工程', fix: 'kine projects 查看登记表；或显式 --dir <工程目录>' },
  { code: 'E-PROJ-002', severity: 'error', scope: '工程定位', meaning: '显式 --dir 指向的目录不是 Kine 工程', fix: '指向含 timeline.yaml 的目录，或 kine init' },
  { code: 'E-PROJ-003', severity: 'error', scope: '工程定位', meaning: '向下扫描发现多个工程且登记表无法决定', fix: '显式 --dir 指定其中之一' },
  // ---- 渲染 / 校验 / sidecar
  { code: 'E-RENDER-001', severity: 'error', scope: 'render', meaning: '渲染管线失败（拼接/合流等）', fix: '看 error.where 与 hints；--range 缩小范围复现' },
  { code: 'E-RENDER-002', severity: 'error', scope: 'render --range', meaning: '区间越界（超出本片帧数/时长）', fix: 'kine map 查范围；--range 默认帧、秒用 0:5s' },
  { code: 'E-RENDER-003', severity: 'error', scope: '抓帧', meaning: '单帧抓取失败（超时/崩溃，已重试 2 次）', fix: '按 facts 的帧号缩小 --range 复现；检查浏览器环境' },
  { code: 'E-RENDER-005', severity: 'error', scope: 'render --range', meaning: '区间格式非法', fix: '用 a:b（帧）或 a:b s（秒，如 0:5s）' },
  { code: 'E-RENDER-006', severity: 'error', scope: 'render --preset', meaning: '未知编码档位', fix: 'ultrafast…veryslow 之一（迭代用 ultrafast）' },
  { code: 'E-PY-001', severity: 'error', scope: 'kine-py', meaning: 'sidecar 命令失败（输入/Python 侧异常）', fix: '按 message/trace 修；检查 venv 与 numpy/scipy' },
  { code: 'E-PY-002', severity: 'error', scope: 'kine-py', meaning: 'sidecar 调用超时', fix: '缩小任务（如音频更短）；确认无并发巨量任务' },
  { code: 'E-METRIC-001', severity: 'error', scope: 'measure', meaning: '未知指标名', fix: 'kine measure 列出的指标之一（density/frame_diff/…）' },
  { code: 'E-METRIC-002', severity: 'error', scope: 'measure', meaning: 'scope 选择冲突（scene/range/at 三选一）', fix: '只保留一个 scope 参数' },
  { code: 'E-VERIFY-001', severity: 'error', scope: 'verify', meaning: '成片帧数/时长与工程不符', fix: '重新 render；或被外部工具改动过产物' },
  { code: 'E-VERIFY-003', severity: 'error', scope: 'verify', meaning: '黄金帧 stateHash 与基线不一致（画面漂移）', fix: '排查渲染代码/素材变化；确认是否有意为之' },
];

export interface RulesArgs {
  code?: string;
}

export async function toolRules(_ctx: AgentContext, args: RulesArgs): Promise<ToolResult<unknown>> {
  const items = args.code ? RULES.filter((r) => r.code.toLowerCase() === args.code!.toLowerCase()) : RULES;
  return ok('rules', { count: items.length, rules: items }, {
    facts: [
      `规则 ${items.length} 条${args.code ? `（过滤 ${args.code}）` : ''}`,
      ...items.slice(0, 40).map((r) => `${r.code} [${r.severity}] ${r.meaning}——修复：${r.fix}`),
    ],
  });
}

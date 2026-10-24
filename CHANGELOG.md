# 更新日志

README 只描述**当前能力**；每一轮外部测试后的修复与新增记录在这里。
版本号按外部测试轮次推进，v1 = M0 初始版本。所有条目以「旧工程行为不变」为前提，除非显式说明。

---

## v6

- **浅色色板注册走统一校验**：`forge` 注册 `mode: light` 的色板时复用 `palette.ts` 的 `validatePaletteData`，浅底同样过 `E-COLOR-005`（对比度 ≥4.5:1），不再出现「direct 注册能过、palette 引用报错」的分叉。
- **反向 push / whip 转场偏移修复**：新增 `companionOffset`——向反方向推/甩时，取景偏移按伴随量计算，新工程不再「空两屏」。
- **浅色模式 density 豁免**：`density` 增加「设计内占位」区（浅底上的刻意留白）不参与内容密度惩罚。
- **transition_spike 可解释**：命中帧号写入 `facts`，并在解读里区分「设计内边界」与「设计外孤立尖峰」。
- **种子色板 +1**：新增 `core/light-paper`（浅色纸面），种子总数 10 → **11**。
- **`RENDER_VERSION` 升到 `/3`**：转场像素行为改变，首次渲染会全量重渲——属预期且可解释。
- 新增 `push-down` 回归 fixture 与 v6 守卫测试。

## v5：浅色模式、资产管线与字幕层

基于第五轮外测（浅色主题被封死 / image 图层静默失效 / 无字幕层 / 崩溃与误导性 verdict / 手感层）：

- **浅色模式（`theme.mode: light`）**：浅底色与深字获得合法路径——E-COLOR-002 改判「通道 ≥180」；新增 `E-COLOR-005`（正文对比度 ≥4.5:1，WCAG）；指标自动切浅底口径（`density`/`edge_band` 以暗像素计内容，`black_level` 报告**白电平**）；色板可声明 `mode: light`（注册期同套校验）；`dark`（默认）行为与哈希逐字节不变。
- **图片资产管线接通**：渲染管线从 IR 收集 `image` 图层（本地路径以 timeline 为基准 / `library://` 库 blob）→ 预解码注入运行时。缺资产：audit 期 `E-ASSET-001` 拦下 + 运行时**贴屏横幅**提示（不再有画外红框骗人）；`video` 图层明确报 `E-ASSET-002`（无确定性丢帧方案——反例比静默失败好）。
- **字幕层 `kind: subtitles`**：内联 `cues` 或引用 `.srt`（编译期内联进 IR）；自动换行 + 逐行居中，`zone` 定位（默认下缘）；lint：`E-SUB-001`（时间非法）/`W-SUB-001`（重叠）/`W-SUB-002`（SRT 坏块）。`render` 完成后自动把字幕导出为 `<version>.srt` 到交付目录。
- **布局与排版**：`place.anchor: tl|tr|bl|br|center`（右对齐 HUD 不再靠猜坐标）；文本 `style.line_height` 可显式；字号换算式写死入文档：`px = size × base × fontScale × ds × 1.06`（ds = S/1080）。
- **verdict 三段式**：`audit` 首行给出「blocking（引擎无法编译/运行）/ policy（设计纪律）/ 警告」分类计数；`check` 汇总 `PASS n / FAIL(blocking) n / FAIL(warn) n / SKIP n`——warn 级未达项不再混进顶层 verdict（报告头单独标注）。
- **MCP 陈旧与 fail-open 修复**：serverInfo 版本含 git 短哈希 + **bundle 哈希**；`doctor` 新增宿主 bundle 新鲜度检查（源码比 bundle 新 → WARN：重建 + 重启）；`W-WIDGET-001` 对「不在元数据注册表」的 widget 也会报警（不再静默跳过校验）；`registerWidget` 重名时 console.warn；FFmpeg 管道 EPIPE 吞并为分片失败（磁盘写满不再拖崩 MCP 进程）。
- **冒烟实证**：图片资产注入 → `probe` 显示 `img1=ok / img2=missing-asset`；缺失资产 audit 报 `E-ASSET-001`；mv-mini specHash `566b68cc`、visualHash `6884bbd2` **零变化**（v5 对既有工程零像素影响，分片缓存直接复用）。
- 延后（已登记）：`render --async + kine jobs`、运行时 `library://` widget-pack 加载（`custom.` 前缀）、meta 与源码一致性生成、`audio.voice` 独立轨。

## v4：文本插值、布局体检与静默失效护栏

基于第四轮外测（布局无检查 / 文本静态 / 配置静默失效 / 文档与输出问题）：

- **文本插值（第 N 帧 = f(N) 的文本版）**：text 层 `content` 支持 `{frame}`（帧号）、`{t}` / `{T}` / `{lt}`（秒），可带格式如 `{t:.2f}`；含 `{` 才进入插值（旧工程逐字节不变）。未知占位符报 `W-TEXT-001`（按字面显示）。计数类画面直接写 `content: 'FRAME {frame}'`。
- **布局体检 `kine layout`**：各幕多点采样（lt 25/50/62/75%）→ 重叠对（交集/较小盒 ≥8%；背景/全屏层除外）、出画（>8px）、贴边（<24px）；强重叠 ≥25% 或出画 → FAIL。配合 **`kine contact`**（均匀抽帧 → 接触表 PNG）快速目检全片。
- **色板静默覆盖显式化**：palette 生效时，显式写死的 `theme.bg/text/text_dim/accent_secondary` 会被覆盖——现在报 `W-COLOR-004`（facts 附色板实际值）；种子色板补全 `accent_secondary`（`profile: extended` 下不再回退锁死 `#4da3ff`）；`kine library seed` 对内容变化的种子自动刷新（条目版本递增）。
- **死参数修复**：`bdTerminal.speed` 真实生效（日志滚动速度倍率）；`bdTitle` 默认**左对齐**，新增 `align: left|center|right`。
- **widget 参数可发现**：`kine widgets info <name>` 给出**视觉描述 + 完整 props 表（类型/默认值/说明/注意）**；未知 props 报 `W-WIDGET-001`（`audit` 阶段拦下）。
- **写保护 `E-PROJ-006`**：未显式 `--dir` 且目录来自「向下扫描 / 登记表兜底」时，`edit` / `rollback` / `style apply` / `render` 拒绝执行（防误改示例工程）；请显式传 `--dir`。
- **渲染环境加固**：分片缓存要求 `.ok` 完整性凭据（文件大小复核；中断留下的截断块不再被误判为缓存命中）；磁盘剩余 <1GB 报 `E-RENDER-007`（hints 含 `kine cache gc` 与 **`KINE_WORK_DIR`** 环境变量——支持把工作区重定向出 C 盘）。
- **输出精简**：`kine edit` 的 diffs / summary / facts 对长值自动折叠（不再整段 `scenes` 重复四遍）；`check` 的断言消息与报告对比例指标补百分数解读（如 `<= 0.6（比例 ≤ 60%）`，0.88% 判 PASS 的依据一眼可见）。
- **MCP 版本标记**：serverInfo 版本包含 git 短哈希——源码改动并重启后，一眼确认加载的是哪一版。

## v3：护栏三修与种子内容

基于第三轮外测的四个 P0 与三个 P1，v3 修复「校验对象与错误路径」（旧工程行为不变）：

- **range 严格校验**：`measure` / `find` 的 `--range` 一律为成片秒 `a:b`（如 `0:5` / `12.5:14`），严格解析——非法值直接报 `E-METRIC-003` / `E-TIME-003`（不再静默退化为默认采样）。
- **音频静默降级归零**：`render` 交付路径混音失败抛 `E-AUDIO-MIX-001`（带 hints；可 `--no-audio` 跳过）；其余工具失败也会留痕（progress/stderr），不再有「无声成片 + 误导错误码」。
- **lint 与渲染同一对象**：颜色/字体/后处理检查作用于 **palette 应用后的有效主题**；色板注册期即校验 bg（非法→`E-LIB-003`、过亮→`E-COLOR-002`）；新增 `W-LIB-002`（色板与 core 视觉完全相同）。
- **SFX 参数值校验**：键名白名单（`W-SYNTH-001`）之外再校验值类型/范围，非法报 `E-SYNTH-001`（如 `notes` 必须是频率数组）。
- **内置种子**：`kine library seed` 一键注册官方色板（`core/noir`、`core/midnight`、`core/forest`、`core/wine`、`core/bw-high-contrast`、`core/amber`、`core/ember`、`core/cyan-lab`、`core/violet`、`core/ice`；v6 起增加 `core/light-paper`，现为 **11 个**）——幂等（已存在跳过）；引用：`theme.palette: library://core/noir` 或 `kine style apply --ref library://core/noir`。
- **edit 支持数组/对象值**：`kine edit "set scenes[s].layers[l].props.notes=[220.0, 261.63]" …`（带引号的 `"[..]"`/`"{..}"` 会自动去引号）。

## v2：资源库与创作层

v2 在「护栏即唯一值」之上引入分层自由度（Tier 模型，全部**可选、有默认值**）：Tier0 铁律（符号/色彩/post 上限、purity、内置转场 15 种）不可动；Tier1 风格档案（`theme.profile: core|extended|free` + `theme.palette`）从注册色板中选配；Tier2 注册扩展（色板 / 主题 / 版式 / SFX 预设 / 蓝图进库需过校验）。默认 `core` 的工程行为与 v1 完全一致。

- **用户资源库**（跨工程）：`~/.local/share/kine/library/`（`KINE_HOME` 可覆盖）；内容寻址（`blobs/<sha256>`）+ `index.json`。
  - `kine library add <file> --kind music|theme|palette|layout|blueprint|preset|sfx-preset|xf-suite|kit|voice|image|video|font`
  - `kine library list|search|tags`；`rm|gc|verify`（`verify --dir <工程>` 检查工程引用与库内容漂移）
  - 工程内引用：`library://<id>`（或 `@tag`）；被引资产 sha256 参与 **specHash 的 assets 子键**——库内容变化在下次 compile 即显现（不静默）。
- **创作层**：`kine forge create <kind> <name>` 产出 draft（自动骨架，或 `--file` 自备 YAML）→ `kine forge register <name>` 自动验证（结构校验 + 可选 `--visual` 黑电平/密度/边缘带门槛）→ 晋升 `library` 状态并自动打色相标签；验证失败**不阻断**，保持 draft。
- **音乐库**：`kine music add <file> --name demo`（ffmpeg → 48k 无损 + 分析：时长/峰值/RMS/BPM 与置信度/拍网格）；`kine music info|analyze|beats|fit`——`fit` 比对音乐长度与成片时长，不匹配时给 2–3 个选项（延长终幕 / 提前淡出 / 循环补段；不建议变速）。
- **风格档案**：`kine style show` 查看当前 profile 与色板解析；`kine style apply --ref library://ai/noir --tx --quote "…"` 走标准事务（impact 保留全部音频节点，自动 audit）。
- 新 MCP 资源：`kine://rules`（规则含义与修复示例）、`kine://library`、`kine://widgets`、`kine://music`。
- 哈希兼容：未显式设置 `profile`/`palette` 的旧工程，specHash/visualHash **逐字节不变**（canonical 投影）。

## v1（M0）

- 确定性内核：`__kine.jump(T)` 全量重算、四禁令 purity 契约、`tools/repro-check.ts` 逐字节复现。
- DSL 编译：`timeline.yaml` → IR（zod 校验 + purity lint + 依赖图 + 时间对照表）。
- 渲染流水线：Edge CDP 逐帧抓帧 → ffmpeg image2pipe → `.ts` 分片 → concat → mux；4 worker 与单 worker 产物一致。
- 度量断言：`density` / `frame_diff` / `edge_band` / `black_level` / `cam_jitter` / `transition_spike` 等指标 + 断言引擎 + 基线 diff。
- 音频：离线 SFX 合成（7 种）+ 成片时钟声明 + 只砍 song 路的收尾纪律。
- Agent 接口：CLI 与 MCP 工具同构、`facts / hints / nextActions` 返回契约、`AMBIGUOUS` 歧义协议、事务编辑与 changelog/rollback。
- 7 个回归 fixture（v6 增加 `push-down`，现为 8 个）：`accel-cut` / `ambiguous` / `double-pace` / `env-flash` / `hud-clip` / `pump-tw` / `short-transition`。

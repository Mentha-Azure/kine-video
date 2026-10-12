# Kine 使用说明（给 AI 智能体）

Kine 是确定性视频剪辑/合成软件：**一个工程 = 一个目录**（`timeline.yaml` 单一真源 + `assets/` + `.kine/` 派生数据）。
核心纪律：读事实 → 量指标 → 显式改动 → 验证出片。第 N 帧永远是 f(N) 的纯函数结果，任何改动都必须可解释、可回滚。

## 接入方式

- **MCP**：server 名 `kine`，工具名 `kine.<tool>`（与 CLI 子命令同名，共 31 个）。
  - 不传 `dir` 的工程定位顺序：① 启动目录向上查找 `timeline.yaml`；② 向下扫描（深度 3）唯一命中即用；③ 多个命中取**最近登记**的工程（返回 facts 会注明）；④ 失败报 `E-PROJ-*` 并列候选（`kine.projects` 可查看/清理登记）。
  - 任何工具都可传参数 `dir="<工程目录>"` 覆盖默认目录（`kine.init` 除外——它的 `dir` 是"目标工程目录"语义）；
  - 资源：`kine://project/info`、`kine://map`、`kine://baseline`、`kine://rules`、`kine://library`、`kine://widgets`、`kine://music`。
  - 注意：MCP 服务器进程常驻；**修改 Kine 源码后需重启服务器**才会加载新代码。
- **CLI**：`npx kine <command> --dir <工程目录> [--json]`（在 kine 仓库下）；任意目录可用
  `node <kine仓库>/packages/agent/bin/kine.mjs <command> ...`。

## 标准工作流

1. **读事实**：`kine info` → `kine map --t <成片秒>` → `kine probe --at <成片秒>`；元素定位用 `find`，旋钮语义用 `explain`。
2. **先量后改**：`kine measure <metric> [--scene X | --range a:b | --at t]`（如 density / frame_diff / cam_jitter；`--range`/`--at` 均为**成片秒**，严格校验——非法值直接报错）。
3. **改动**：`kine edit "set <path>=<value>" --quote "用户原话" --tx [--preview]`
   —— 不带 `--tx` 是 dry-run（看 impact）；提交会写 changelog、留备份、可回滚。
4. **三层验证**：`kine audit`（语法/纪律/运行时扫描）→ `kine check`（断言集）→ `kine preview --at X --dur 4`（给人看的成品形态短片）。
5. **出片**：`kine render` → `kine verify --version <v>`（全 PASS 或"已解释的 WARN"才算完成）→ 交付 `.kine/out/<version>/`。

## 铁律

- 所有时间参数一律用**成片秒 t**（工具返回同时给 t 与 T；内部自动经时间对照表换算）。
- 改动必须走 `edit`（`--tx --quote`），不要手改 `timeline.yaml`；回滚用 `kine rollback <txId>`。
- 工具返回 `verdict: AMBIGUOUS` 时**必须转呈用户选择**，禁止静默挑一个（用 `--id` 显式消歧后重调）。
- 方向性决策（改曲速/片长/结构）永远给「数据 + 2-3 个选项」由用户定。
- 只改用户要求的；其余发现只报告不动手。
- 交付物只放 `.kine/out/<version>/`；中间资产不外发。
- 引用库资源用 `library://<id>` 或 `@tag`；被引资产 sha256 参与 specHash——库内容变化下次 compile 即显现。风格改动走 `kine style apply`（事务），创作资源走 `kine forge create → register`。
- 文本实时数值用插值：`content: 'FRAME {frame}'` / `'{t:.2f}'`（支持 `{frame}/{t}/{T}/{lt}`；未知占位符报 W-TEXT-001）。
- 写操作（`edit`/`rollback`/`style apply`/`render`）请显式 `--dir`：目录来自扫描/登记兜底时会被 `E-PROJ-006` 拒绝（防误改）。

## 常用命令速查

| 目的 | 命令 |
| --- | --- |
| 新建工程 | `kine init <目录> --template mv-mini\|blank` |
| 时间定位 | `kine map --t 12.5` / `kine map --frame 750` |
| 画面排查 | `kine probe --at 12.5 --hash` |
| 布局体检 | `kine layout`（重叠/出画/贴边）；`kine contact --scene code --count 8`（接触表拼图） |
| 浅色主题 | `theme.mode: light`（浅底深字；E-COLOR-005 对比度 ≥4.5:1；指标走白电平/暗像素口径） |
| 字幕 | `kind: subtitles`（cues 或 `.srt`）；`kine render` 自动导出 `<version>.srt` |
| 渲染目录 | `kine render --work-dir D:\kine-work`（或 `KINE_WORK_DIR`；磁盘 <1GB 报 E-RENDER-007） |
| 元素定位 | `kine find "标题" [--scene code]` |
| 旋钮解释 | `kine explain scenes[code].camera.tw` |
| 影响分析 | `kine impact audio.music.file` |
| 量指标 | `kine measure density --scene finale` |
| 带期望断言 | `kine measure frame_diff --expect ">= 4 %"` |
| 预览 | `kine preview --at 12 --dur 4` |
| 出片/终检 | `kine render [--range 0:300 或 0:5s] [--preset ultrafast]` / `kine verify` |
| 变更历史/回滚 | `kine changelog --since 1d` / `kine rollback tx_20261007_001` |
| 资源库 | `kine library add <file> --kind music` / `kine library list --kind theme` / `kine library tags` / `kine library seed`（注册内置种子色板 core/*，幂等） |
| 音乐库 | `kine music add <file> --name demo` / `kine music fit` |
| 创作资源 | `kine forge create palette noir --tags noir` → `kine forge register noir` |
| 应用色板 | `kine style apply --ref library://ai/noir --tx --quote "换配色"` |
| 用户控制台 | `pnpm console` → http://127.0.0.1:4747（库浏览 / 音乐上传入库 / 工程与磁盘） |
| 规则速查 | `kine rules [W-SYNTH-001]` |

环境：ffmpeg 自动发现（`KINE_FFMPEG` 可覆盖）；浏览器用系统 Edge（`KINE_BROWSER` 可覆盖）；kine-py 走 `py/kine-py/.venv`（`KINE_PYTHON` 可覆盖）。

## SFX 合成参数速查

`sfx.events[].params` 白名单（未识别的键 audit 报 W-SYNTH-001 warn）：

| sfx | params |
| --- | --- |
| heartbreak | — |
| rain | drops_per_sec · bed_gain · dur |
| piano_motif | notes · spacing · gain · chord · chord_at · dur |
| keyboard | period · count · dur |
| tape | dur |
| drone | freq · dur |
| glitch | rate · blue_freq · dur |

`audio.tail_fade`（0.1–3，默认 0.4）= SFX 末段淡出时长（改它只重建音频缓存，帧不受影响）。收尾偏响的工程可调大（mv-mini 用 1.0 使尾检 0 WARN）。

## 视觉设计学习文档

- 位置：`docs/视觉设计教学文档/`（10 本设计书 PDF + `00_资源清单.md`）+ `docs/视觉设计-学习指引.md`（决策映射表）。
- **配色 / 字体 / 版式 / 信息层级 / Logo** 的方向性决策前先查指引；需要深入时用 read 工具按需读取对应 PDF。
- 结论一律转成 2–3 个选项 + 数据依据，并落地为 Kine 表达（theme / palette / place / 断言），不得替用户拍板。
参数值也有规格校验：非法值（如 `notes: 4`）报 `E-SYNTH-001` error——频率列表需写成 `[220.0, 261.63]`。

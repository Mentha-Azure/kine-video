# Kine — AI 原生的确定性视频剪辑软件

> **第 N 帧 = f(N)**。Kine（/kaɪn/，取自 kinesis「运动」）是第一个为 AI 智能体工作方式设计的视频剪辑 / 合成软件：
> 读事实 → 改 DSL → 量结果 → 验证出片。单一真源，逐帧确定性，可度量优于可感觉。

- **AI 智能体是首要用户**：所有能力以 CLI 子命令 + MCP 工具暴露，返回结构化事实（facts）与下一步建议（nextActions）。
- **人类作者是第二用户**：对话式改片，看 3–5 秒成品形态短预览与 changelog。
- **不提供拖拽实时编辑 UI**（非目标）；人类工程师可直接读 DSL / IR 扩展 widget 与指标。

---

## 快速开始（M0 验收五命令）

前置：Node ≥ 22、pnpm、Edge 或 Chromium、ffmpeg（自动发现，见「环境依赖」）。

```bash
cd kine
pnpm install                            # 首次

# 1) 从模板初始化一个工程（mv-mini = 4 幕 24s / 1080p60 演示）
npx kine init demo --template mv-mini

# 2) 三层检查的项目级入口：DSL schema + purity lint（+ 运行时全轴扫描，去掉 --syntax-only 即全开）
npx kine audit --dir demo --syntax-only

# 3) 渲染一小段审查（--range 默认帧；秒用后缀：0:5s。迭代频繁可加 --preset ultrafast）
npx kine render --range 0:300 --dir demo

# 4) 全片渲染 + 终检
npx kine render --dir demo
npx kine verify --dir demo

# 5) 成品形态短预览（3–5s、成片分辨率、带音轨）
npx kine preview --at 12 --dur 4 --dir demo
```

> `npx kine` 通过 workspace bin（`packages/agent/bin/kine.mjs`）入口运行；也可等价使用
> `node packages/agent/bin/kine.mjs <cmd>` 或 `npx tsx packages/agent/src/cli.ts <cmd>`。
> 所有命令未指定 `--dir` 时的定位顺序：① 启动目录向上查找 `timeline.yaml`；② 向下扫描（深度 3）唯一命中即用；③ 多个命中取**最近登记**的工程（返回 facts 会注明自动定位结果）；④ 全无则报 `E-PROJ-*` 并列出候选。`kine projects` 可查看/清理登记。

---

## 环境依赖

| 依赖 | 用途 | 发现顺序 |
| --- | --- | --- |
| Node ≥ 22 + pnpm | 全仓运行 / workspace | — |
| Edge 或 Chromium | headless 抓帧（CDP） | `KINE_BROWSER` → ms-playwright 缓存 → Edge → Chrome |
| ffmpeg 6+（含 libx264/mpegts） | 分片编码 / 拼接 / 合流 | `KINE_FFMPEG` → `~/.local/share/kine/bin/ffmpeg.exe` → PATH → 常见安装位置 |
| Python venv（`py/kine-py/.venv`） | 音频合成 / 混音 / 像素指标 | `KINE_PYTHON` → venv → 系统 python（需 numpy/scipy/PIL） |

浏览器与 ffmpeg 的确定性参数已内置（固定字体渲染、禁用 LCD 字体平滑、`--force-color-profile=srgb` 等），保证逐帧可复现。

---

## 架构

```
Agent 接口层   @kine/agent      CLI ×22 子命令 + MCP server（每工具一个 tool）
工程层         @kine/store      工程目录 / 事务(changelog/rollback) / 缓存 / 版本 / 基线 / 锁 / 日志
编译层         @kine/dsl        timeline.yaml --(zod 校验 + lint)--> IR（含时间对照表 map 与依赖图）
渲染层         @kine/render     Edge CDP 逐帧抓帧 → ffmpeg image2pipe → .ts 分片 → concat → mux
               @kine/runtime    window.__kine = { load, jump, probe, stateHash }（纯函数逐帧）
               @kine/widgets    33 个官方 widget（bd* / draw* 两族）
音频层         @kine/audio      SFX 离线合成 + 混音（成片时钟声明，改速度不需要重录）
验证层         @kine/metrics    像素指标 / 断言引擎 / 基线 diff
侧车           py/kine-py       stdio JSON 协议：合成器 / 混音 / 像素指标（numpy+scipy+PIL）
```

数据流：

```
timeline.yaml ──compile──▶ IR ──┬──▶ 帧抓取（N worker × 独立浏览器）──▶ chunk_*.ts ──concat──▶ video.mp4
                                ├──▶ 音频（SFX 合成 + 原曲混音）──────────────mix──▶ audio.wav
                                └──▶ 依赖图 / 时间对照表 map ──▶ impact·check·verify
video.mp4 + audio.wav ──mux──▶ out/<version>/<version>.mp4 ──verify──▶ 交付
```

一个 `timeline.yaml` 描述全片。时间只写一次；**所有工具的时间参数一律使用成片秒**，返回中同时给出渲染时钟 T；
内部换算只经 `map`（`kine map --t 125.1` ⇒ `{ t, T, frame, seg, scene }`）。

---

## CLI 工具总表（22 个，与 MCP 工具一一对应）

| 命令 | 用途 | 示例 |
| --- | --- | --- |
| `init` | 从模板建工程（mv-mini / blank） | `kine init demo --template mv-mini` |
| `info` | 工程总览（时长/帧数/幕/音频/断言/版本） | `kine info` |
| `doctor` | 工程一致性体检（可 `--fix`） | `kine doctor --fix` |
| `compile` | 编译并输出 specHash / 时间表 / 摘要（`--write-ir` 落盘 IR） | `kine compile` |
| `map` | 时间对照表：`--t` 秒→帧/幕；`--frame` 反查；无参出全表 | `kine map --t 12.5` |
| `probe` | 运行时探针：某秒的画面元素/相机/后处理/状态哈希 | `kine probe --at 12` |
| `find` | 语义寻址（alias/tags/id/name），歧义时返回 AMBIGUOUS + 候选 | `kine find 标题` |
| `explain` | 字段解释：定义处行号 / 驱动关系 / 生效公式 / 改动影响 | `kine explain pace.segments[1].ratio` |
| `impact` | 影响分析：失效节点 / 保留节点 / 预计重渲与重混 | `kine impact output.duration` |
| `edit` | 事务编辑：dry-run → impact → 应用 → changelog（`--tx --quote`） | `kine edit "set scenes[code].camera.tw=0.5" --tx --quote "代码幕震屏小一点"` |
| `measure` | 指标测量（density/frame_diff/cam_jitter/audio_rms…），可带 `--expect` | `kine measure cam_jitter` |
| `audit` | 三层检查：①schema ②purity lint ③0.25s 步进运行时扫错 | `kine audit` |
| `check` | 跑全部断言（PASS/FAIL/SKIP）+ 与最近基线 diff | `kine check` |
| `baseline` | 保存/查看基线（指标 + 黄金帧 stateHash + 音频特征） | `kine baseline --save` |
| `diff` | 两个版本/基线的三联 diff（语义/指标/关键帧） | `kine diff v0.2 v0.3` |
| `preview` | 成品形态短预览（法定形态：3–5s、成片分辨率、带音轨） | `kine preview --at 12 --dur 4` |
| `render` | 渲染：全片（默认）或 `--range a:b`（默认帧，`s` 后缀为秒）；`--preset` 编码档位；`--workers/--no-cache` | `kine render --range 0:5s --preset ultrafast` |
| `verify` | 成片终检：帧数/时长/音轨/接缝/黄金帧 + 写报告 | `kine verify --version v0.3` |
| `changelog` | 事务历史（用户原话 + patch + impact + 预览） | `kine changelog --since 2h` |
| `rollback` | 回滚某事务（备份优先，写新条目） | `kine rollback tx_20261007_001` |
| `cache` | 缓存状态 / LPU GC（默认上限 20GB） | `kine cache gc --max 20` |
| `versions` | 版本列表与终版指针 | `kine versions` |

通用返回契约：`{ ok, tool, data, verdict, facts[], hints[], nextActions[], error? }`。
`verdict` 可为 `PASS | FAIL | AMBIGUOUS | NEED_INPUT` —— **AMBIGUOUS 时禁止静默选择**，必须由用户从候选项中指定（`--id`）。

## MCP 接入

MCP 服务器名 `kine`，工具名与 CLI 一致（`kine.map`、`kine.measure`…），长任务（render/verify/baseline）支持进度通知；资源：`kine://project/info`、`kine://map`、`kine://baseline`。

```json
{
  "mcpServers": {
    "kine": {
      "command": "node",
      "args": ["<path-to>/kine/packages/agent/bin/kine.mjs", "mcp", "--dir", "<project-dir>"]
    }
  }
}
```

---

## 确定性体系

- **specHash**：IR 归一化哈希 = 工程身份（缓存、基线、回归的根键）。
- **visualHash**：帧内容根键（排除音频/断言）——**改音频不重渲帧**，缓存按 visualHash 分目录。
- **stateHash**：单帧状态归一化哈希（场景/镜头/相机/元素盒/测量），跨会话可复现，用于黄金帧回归。
- **逐帧纯函数**：`__kine.jump(T)` 全量重算；四禁令（禁 Math.random / 累积状态 / 墙钟 / CSS 自走动画）由 `audit` 扫描源码强制。
- **字节级复现验收**：`npx tsx tools/repro-check.ts examples/mv-mini/timeline.yaml 0:120`
  同一工程两次渲染（`--no-cache`）产物逐字节一致。
- **分片**：边界只落 pace 断点与幕边界；4 worker 与单 worker 产物一致（同 specHash）。
- **跨版本哈希标记**：`HASH_SCHEME`（IR 规范形式版本，`kine-hash/1`）与 `RENDER_VERSION`（渲染像素行为版本，`kine-render/1`）显式进入哈希输入。
  源码升级导致标记 bump 时 specHash/visualHash 会变化、首次 render 可能全量重渲，属**预期且可解释**的行为；
  维护者改变 IR 编译形式或渲染像素输出时**必须**同步 bump 对应常量并在此记录，用户可凭标记判断“是升级导致还是工程被改”。

### 改片标准工作流

```
find（定位元素）→ explain（看公式）→ measure（先量）→ impact（算失效范围）
→ edit --tx --quote（事务提交，自动 changelog）→ audit → check
→ preview（给用户看 3–5s）→ render → verify → 交付 out/<version>/
```

回滚：`rollback <txId>`；历史：`changelog`。

---

## 目录结构

```
kine/
├─ packages/
│  ├─ dsl/        时间映射 / schema / lint / 依赖图 / patch / 相机公式（单一真源）
│  ├─ runtime/    jump / probe / stateHash / 合成器 / 转场库 / 后处理
│  ├─ widgets/    33 个官方 widget
│  ├─ render/     CDP 抓帧 / ffmpeg 编码 / 分片 / 缓存 / 拼接 / mux
│  ├─ audio/      音频计划 / 合成 / 混音 / env
│  ├─ metrics/    像素指标 / 断言引擎 / 相机解析复算
│  ├─ store/      工程布局 / 事务 / 缓存索引 / 版本 / 基线 / 日志 / 锁 / kine-py 桥
│  └─ agent/      CLI（bin/kine.mjs）+ MCP server + 22 工具
├─ py/kine-py/    Python 侧车（stdio JSON）：synth/mix/env/像素指标
├─ examples/mv-mini/   演示工程（含 demo 曲 assets/song.wav）
├─ fixtures/      6 个回归工程（accel-cut / ambiguous / double-pace / env-flash / hud-clip / pump-tw）
├─ tests/         vitest 单元测试（时间映射/分片/patch/lint/impact/find/edit/expect）
└─ tools/         构建与冒烟脚本（build-web / smoke-* / repro-check / check-fixtures …）
```

工程目录（如 `demo/`）：

```
demo/
├─ timeline.yaml            单一真源
├─ assets/                  音乐与素材
└─ .kine/
   ├─ ir/project.ir.json    编译产物（含时间表与依赖图）
   ├─ work/<hash8>/         分片与调试帧（缓存）
   ├─ cache/                音频 / env / 指标缓存（索引 + LRU）
   ├─ out/<version>/        video.mp4 + <version>.mp4 + report.md（交付物）
   ├─ baseline/<v>.json     基线
   ├─ reports/              check / diff 报告
   ├─ changelog.jsonl       事务史（用户原话逐字）
   └─ backup/               事务前 YAML 备份
```

---

## 测试与验收状态

| 项目 | 状态 |
| --- | --- |
| `npx vitest run` | 11 文件 / 45 用例全绿（含 dir 自动定位、kine-py 协议行净化与静音窗回归） |
| 6 个回归 fixture | 编译验证全绿（3 个预期命中 lint 错误码） |
| M0 五命令验收（mv-mini） | `init`（绝对/相对路径 × blank/mv-mini 模板）· `audit`（语法 0/0、purity 0、运行时全轴扫描 0 错误）· `render`（v0.4，1440 帧全缓存命中，6.8s）· `verify`（帧数/时长/音频/抽检全过，tail-clean 为已解释 WARN）· `preview --at 12 --dur 4`（含音轨成品形态）——全 PASS |
| MCP 冒烟 | initialize / tools(22) / map / probe / resources 全通过 |
| 字节级复现 | `tools/repro-check.ts` 双跑 120 帧 sha256 逐字节一致（534f795a…） |
| 工程身份确定性 | specHash 位置无关（拷贝工程/换目录哈希一致）；音频-only 改动不失效帧缓存（visualHash 解耦实证） |

已知限制：`verify` 的 tail-clean 对“SFX 延至片尾/收尾偏响”的工程会给 WARN（属设计内、按 L-AUD-002 解释；可用 `audio.tail_fade` 调整——mv-mini 模板已用 `1.0` 使 fresh verify 0 WARN）；
`render --range` 默认帧语义（秒用 `0:5s` 后缀）；M7 只读预览 UI 未实现（非目标优先）。

## 音频：SFX 参数表与 tail_fade

每个 SFX 事件可带 `params`；**未识别的参数键会在 audit 报 `W-SYNTH-001`**（不再静默忽略）。

| sfx | 可用 params |
| --- | --- |
| `heartbreak` | （无） |
| `rain` | `drops_per_sec` · `bed_gain` · `dur` |
| `piano_motif` | `notes` · `spacing` · `gain` · `chord` · `chord_at` · `dur` |
| `keyboard` | `period` · `count` · `dur` |
| `tape` | `dur` |
| `drone` | `freq` · `dur` |
| `glitch` | `rate` · `blue_freq` · `dur` |

- `audio.tail_fade`（0.1–3s，默认 0.4）：SFX 总线末段余弦淡出时长；改动只重建音频缓存，帧缓存不受影响。mv-mini 模板用 `1.0`，末 0.2s 峰值实测 -35.9 dB。
- 合成器版本 `kine-synth/2`（piano_motif 的 `gain` 旋钮已生效；`keyboard` 用 `count` 控制点击数——写 `clicks` 会在 audit 报 `W-SYNTH-001`）。

**MCP 常驻提示**：MCP 服务器进程常驻，修改 Kine 源码后需重启服务器（OpenCode 中重启服务或重开会话）才会加载新代码。

## 规格文档

开发依据：`（内部设计规格书，不随仓库分发）`（01 产品定位 → 10 路线图），
以及源项目《world.execute(me) MV 制作全案》的全部经验固化（每个历史坑均已落成 lint / 指标 / 流程）。

# kine-py — Kine 的 Python sidecar（音效离线合成 / 混音 / 像素度量 / 能量包络）
# 协议：stdin 每行一个 JSON 请求 → stdout 每行一个 JSON 响应。纯函数化，产物进 .kine/cache/。
__version__ = "kine-py/1"

# 与 TypeScript 侧对齐的版本号（缓存键的一部分；任何影响字节输出的改动都必须升版本）
SYNTH_VERSION = "kine-synth/2"
METRICS_VERSION = "kine-metrics/1"
ENV_VERSION = "kine-env/1"
MIX_VERSION = "kine-mix/1"

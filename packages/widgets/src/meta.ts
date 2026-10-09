// Widget 元数据（v4）：中文视觉描述 + props 规格（名称/类型/默认值/说明）
// 用途：① kine widgets list/info 展示（不再需要读源码）② audit W-WIDGET-001 未知 props 检查
// 数值组件的默认与范围即源码 P(c.props, key, default) 的事实镜像；调整默认值必须同步这里。

export interface WidgetPropMeta {
  name: string;
  type: 'number' | 'string';
  default: number | string;
  desc: string;
}

export interface WidgetMeta {
  /** 一句话视觉描述：画的是什么、怎么动 */
  desc: string;
  /** 使用注意（可选） */
  note?: string;
  props: WidgetPropMeta[];
}

const P = (name: string, type: 'number' | 'string', def: number | string, desc: string): WidgetPropMeta => ({ name, type, default: def, desc });

export const WIDGET_META: Record<string, WidgetMeta> = {
  // ---- bd 族（16）
  bdBG: {
    desc: '背景网格：细网格上一条扫描带周期性扫过，带内格子短暂变亮（大面积活背景，防静态）',
    props: [P('cell', 'number', 26, '网格格子边长（设计像素）'), P('sweep', 'number', 7, '扫描带扫过周期（秒）')],
  },
  bdTitle: {
    desc: '大标题：逐字打出 + 强调色下划线从左扫过 + 打字光标闪烁；打字结束保持全标题',
    note: '默认左对齐（内容从锚点向右延伸）；需要居中请设 align: center',
    props: [
      P('text', 'string', 'WORLD.EXECUTE', '主标题文本'),
      P('sub', 'string', '', '副标题（小字号、弱色）'),
      P('size', 'number', 44, '主标题字号（设计像素）'),
      P('type_period', 'number', 0.05, '逐字打字间隔（秒）；0=立即全显'),
      P('underline_period', 'number', 2.6, '下划线扫掠周期（秒）'),
      P('align', 'string', 'left', '横向对齐：left（默认）/ center / right'),
    ],
  },
  bdKey: {
    desc: '键位行：按字符列出键帽，周期性高亮"按下"',
    props: [P('keys', 'string', 'W A S D', '键位字符（空格分隔）'), P('period', 'number', 0.62, '按键高亮周期（秒）')],
  },
  bdLive: {
    desc: 'LIVE 指示：红点呼吸闪烁 + 运行计时（mm:ss.cc）',
    props: [P('label', 'string', 'LIVE', '前缀标签文本')],
  },
  bdScan: {
    desc: '扫描器：顶部条形码柱状码 + 一条强调色扫描线上下移动（带余辉）',
    props: [P('period', 'number', 2.4, '扫描周期（秒）')],
  },
  bdPulse: {
    desc: '心电脉冲：全宽滚动的心电 QRS 波形（尖峰 + 平线）',
    props: [P('period', 'number', 1.05, '脉冲周期（秒）'), P('amp', 'number', 0.36, '振幅（0-1）')],
  },
  bdBars: {
    desc: '频谱柱：多根柱体周期性起伏 + 峰值高亮',
    props: [P('bars', 'number', 24, '柱数量'), P('period', 'number', 1.6, '起伏周期（秒）')],
  },
  bdRing: {
    desc: '同心环仪表：多层圆弧旋转 + 百分比读数摆动',
    props: [P('rings', 'number', 3, '环数量'), P('period', 'number', 3.2, '旋转周期（秒）')],
  },
  bdCells: {
    desc: '网格亮灭：cols×rows 格子按确定性图案周期性明灭',
    props: [P('cols', 'number', 14, '列数'), P('rows', 'number', 8, '行数'), P('period', 'number', 0.85, '亮灭周期（秒）')],
  },
  bdWave: {
    desc: '多道正弦波：多条相位移动的波形线（可作地平线/信号波形）',
    props: [P('waves', 'number', 3, '波数量'), P('speed', 'number', 0.9, '相位移动速度')],
  },
  bdHex: {
    desc: '十六进制转储：字符流逐行滚动 + 高亮列（像 hex dump）',
    props: [P('lines', 'number', 12, '可见行数'), P('speed', 'number', 1.4, '滚动速度')],
  },
  bdCursor: {
    desc: '打字机：text 逐字打出并循环 + 光标闪烁',
    props: [P('text', 'string', 'kine render --range 0:5', '打字文本'), P('period', 'number', 3.4, '循环周期（秒）'), P('size', 'number', 20, '字号（设计像素）')],
  },
  bdRainDrops: {
    desc: '数字雨：多列字符带尾迹下落',
    props: [P('drops', 'number', 26, '雨滴（列）数量'), P('speed', 'number', 1, '下落速度'), P('size', 'number', 13, '字号（设计像素）')],
  },
  bdFlow: {
    desc: '流水线：节点用箭头相连，数据包沿路径移动',
    props: [P('nodes', 'number', 5, '节点数量'), P('period', 'number', 2.8, '数据包周期（秒）')],
  },
  bdDial: {
    desc: '仪表盘：刻度弧 + 指针周期性摆动 + 读数',
    props: [P('period', 'number', 3.6, '摆动周期（秒）'), P('segments', 'number', 14, '刻度段数')],
  },
  bdTerminal: {
    desc: '终端窗口：标题栏红点 + 滚动日志行 + 底部进度条（窗口 chrome 造型）',
    props: [
      P('size', 'number', 15, '字号（设计像素）'),
      P('title', 'string', 'kine — render', '标题栏文本'),
      P('lines', 'number', 11, '可见日志行数'),
      P('speed', 'number', 1, '日志滚动速度倍率（v4 起生效，1=原速）'),
    ],
  },

  // ---- draw1 族（9）
  motes: {
    desc: '浮尘：缓慢漂浮的小光点（远/近层视差用）',
    props: [P('count', 'number', 48, '粒子数量'), P('size', 'number', 2.4, '尺寸（设计像素）')],
  },
  globe: {
    desc: '线框地球：经纬线球体持续旋转 + 城市亮点闪烁',
    props: [],
  },
  tesseract: {
    desc: '四维超立方：8 个立方体顶点旋转投影（科幻感几何体）',
    props: [],
  },
  heart: {
    desc: '心形粒子：粒子组成的心形，周期性双跳脉冲',
    props: [P('period', 'number', 1.15, '双跳周期（秒）'), P('points', 'number', 220, '粒子数（≥150 保证可辨识）')],
  },
  pcb: {
    desc: '电路板：曼哈顿走线 + 沿走线流动的脉冲光点',
    props: [P('traces', 'number', 10, '走线数量')],
  },
  grid: {
    desc: '透视地面：横纵线向地平线滚动（复古网格地平线）',
    props: [P('speed', 'number', 0.55, '滚动速度'), P('horizon', 'number', 0.42, '地平线位置（0-1，相对高度）')],
  },
  membank: {
    desc: '内存字节矩阵：字符网格按确定性节奏闪变（像内存监视器）',
    props: [P('cols', 'number', 12, '列数'), P('rows', 'number', 6, '行数'), P('rate', 'number', 3.2, '闪变速率')],
  },
  disk: {
    desc: '磁盘盘面：扇区环 + 磁臂周期扫描（像磁盘活动指示）',
    props: [],
  },
  life: {
    desc: '生命游戏：康威规则确定性演化（细胞自动机图案流动）',
    props: [P('cols', 'number', 48, '列数'), P('rows', 'number', 27, '行数'), P('period', 'number', 0.16, '演化步间隔（秒）')],
  },

  // ---- draw2 族（8）
  classGraph: {
    desc: '类图：节点连线 + 数据点沿边移动',
    props: [P('nodes', 'number', 5, '节点数量')],
  },
  symbols: {
    desc: '符号瀑布：数字/符号矩阵下落（数字雨风格）',
    props: [P('rate', 'number', 8, '下落速率'), P('size', 'number', 15, '字号（设计像素）')],
  },
  pipeline: {
    desc: '构建流水线：阶段节点逐个点亮 + 连接线推进',
    props: [P('stages', 'number', 5, '阶段数量'), P('period', 'number', 3.2, '推进周期（秒）')],
  },
  stars: {
    desc: '星空：星点闪烁 + 十字星芒（深空背景）',
    props: [P('count', 'number', 130, '星点数量'), P('period', 'number', 2.6, '闪烁周期（秒）')],
  },
  constellations: {
    desc: '星座：星点近邻连线缓慢漂移（星座图风格）',
    props: [P('stars', 'number', 18, '星点数量')],
  },
  ash: {
    desc: '灰烬：颗粒缓慢上升 + 明暗闪烁（余烬气氛）',
    props: [P('count', 'number', 60, '颗粒数量')],
  },
  telemetry: {
    desc: '遥测表：多行读数 + 迷你曲线滚动（监控台风格）',
    props: [P('rows', 'number', 5, '读数行数')],
  },
  points: {
    desc: '点云形态：粒子群在圆/方/三角/十字形态间周期变换',
    props: [P('count', 'number', 180, '点数'), P('period', 'number', 5.2, '形态变换周期（秒）')],
  },
};

export function widgetMeta(name: string): WidgetMeta | undefined {
  return WIDGET_META[name];
}

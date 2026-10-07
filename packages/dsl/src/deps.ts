// @kine/dsl — 依赖图与影响分析（P4 影响分析显式化，08-数据模型 §8.2/§8.4）
export interface DepNode {
  id: string;
  type: string;
  inputs: string[];
  label?: string;
}

export type DepEdge = [from: string, to: string];

export interface DepGraph {
  nodes: DepNode[];
  edges: DepEdge[];
}

export function buildDeps(p: {
  specHash: string;
  themeHash: string;
  paceHash: string;
  timePlanHash: string;
  sfxPlanHash: string;
  musicHash: string;
  scenes: string[];
  duration: number;
  sceneDurs: { id: string; dur: number; t0: number; t1: number }[];
}): DepGraph {
  const nodes: DepNode[] = [];
  const edges: DepEdge[] = [];
  const add = (n: DepNode) => { nodes.push(n); };
  const link = (from: string, to: string) => { edges.push([from, to]); };

  add({ id: 'map', type: 'map', inputs: [p.paceHash, `output.duration=${p.duration}`], label: '时间对照表 t↔T' });
  for (const s of p.scenes) {
    add({ id: `frames:${s}`, type: 'frames', inputs: [`scene:${s}`, p.themeHash], label: `幕 ${s} 逐帧画面` });
    link('map', `frames:${s}`);
  }
  add({ id: 'audio:music', type: 'music', inputs: [p.musicHash], label: '音乐轨' });
  add({ id: 'audio:env', type: 'env', inputs: [p.musicHash, 'fps', 'frames'], label: '帧对齐能量包络' });
  add({ id: 'audio:sfx', type: 'audio_sfx', inputs: [p.sfxPlanHash, 'synthVersion'], label: '音效合成' });
  add({ id: 'audio:mix', type: 'audio_mix', inputs: [p.musicHash, 'audio:sfx', p.timePlanHash], label: '混音' });
  add({ id: 'video:concat', type: 'video_concat', inputs: p.scenes.map((s) => `frames:${s}`), label: '分片拼接' });
  add({ id: 'deliver:mux', type: 'mux', inputs: ['video:concat', 'audio:mix'], label: '合流成品' });
  add({ id: 'verify:video', type: 'verify', inputs: ['deliver:mux'], label: '成片视频终检' });
  add({ id: 'verify:audio', type: 'verify', inputs: ['audio:mix', p.musicHash], label: '成片音频终检' });
  add({ id: 'metrics:visual', type: 'metrics', inputs: p.scenes.map((s) => `frames:${s}`), label: '视觉指标' });
  add({ id: 'report', type: 'report', inputs: ['verify:video', 'verify:audio', 'metrics:visual'], label: '交付报告' });

  link('audio:music', 'audio:env');
  link('audio:music', 'audio:mix');
  link('audio:sfx', 'audio:mix');
  link('audio:mix', 'deliver:mux');
  link('audio:mix', 'verify:audio');
  link('video:concat', 'deliver:mux');
  link('deliver:mux', 'verify:video');
  for (const s of p.scenes) link(`frames:${s}`, 'metrics:visual');
  link('verify:video', 'report');
  link('verify:audio', 'report');
  link('metrics:visual', 'report');
  return { nodes, edges };
}

// ---------------------------------------------------------------- 影响分析
export interface ImpactReport {
  invalidates: string[];
  reruns: string[];
  keeps: string[];
  warnings: string[];
  approx: { rerender: string; remix: string; frames: number };
}

/** 把 patch 路径（如 scenes[title].layers[x].props.flash_period）归类 */
export interface ParsedTarget {
  kind: 'output' | 'scene' | 'layer' | 'theme' | 'pace' | 'audio' | 'render' | 'project' | 'asserts' | 'unknown';
  sceneId?: string;
  layerId?: string;
  field?: string;
}

export function parseTargetPath(path: string): ParsedTarget {
  const m = path.match(/^([A-Za-z_]+)(?:\[([^\]]+)\])?(?:\.(.*))?$/);
  if (!m) return { kind: 'unknown' };
  const [, root, sel, rest] = m;
  switch (root) {
    case 'output': return { kind: 'output', field: rest };
    case 'theme': return { kind: 'theme', field: rest };
    case 'pace': return { kind: 'pace', field: rest };
    case 'render': return { kind: 'render', field: rest };
    case 'audio': return { kind: 'audio', field: rest };
    case 'project': return { kind: 'project', field: rest };
    case 'asserts': return { kind: 'asserts', field: rest };
    case 'scenes': {
      if (!sel) return { kind: 'scene' };
      if (/^\d+$/.test(sel)) return { kind: 'scene', sceneId: `#${sel}` };
      const lm = rest?.match(/^layers\[([^\]]+)\](?:\.(.*))?$/);
      if (lm) return { kind: 'layer', sceneId: sel, layerId: lm[1], field: lm[2] };
      return { kind: 'scene', sceneId: sel, field: rest };
    }
    default: return { kind: 'unknown' };
  }
}

export function computeImpact(opts: {
  targets: ParsedTarget[];
  sceneIds: string[];
  framesPerScene: Record<string, number>;
  totalFrames: number;
  nScenes: number;
}): ImpactReport {
  const { targets, sceneIds, framesPerScene, totalFrames } = opts;
  const inv = new Set<string>();
  const reruns = new Set<string>();
  const keeps = new Set<string>();
  const warnings: string[] = [];
  let rerenderFrames = 0;
  let rerenderAll = false;

  const allFrames = () => {
    rerenderAll = true;
    for (const s of sceneIds) inv.add(`frames:${s}`);
    inv.add('map'); inv.add('video:concat'); inv.add('deliver:mux');
    inv.add('verify:video'); inv.add('metrics:visual'); inv.add('report');
  };
  const sceneFrames = (ids: string[] | null) => {
    const list = ids ?? sceneIds;
    for (const s of list) {
      inv.add(`frames:${s}`);
      rerenderFrames += framesPerScene[s] ?? 0;
    }
    inv.add('video:concat'); inv.add('deliver:mux'); inv.add('verify:video'); inv.add('metrics:visual'); inv.add('report');
  };
  const audioChain = (opts2: { sfxToo?: boolean; musicToo?: boolean; envToo?: boolean }) => {
    if (opts2.sfxToo) { inv.add('audio:sfx'); }
    inv.add('audio:mix'); inv.add('verify:audio'); inv.add('report');
    if (opts2.envToo) inv.add('audio:env');
  };

  for (const t of targets) {
    switch (t.kind) {
      case 'output':
        if (t.field === 'duration' || t.field === 'fps' || t.field === 'width' || t.field === 'height') {
          allFrames();
          inv.add('map'); inv.add('audio:mix'); inv.add('verify:audio'); inv.add('audio:env');
          warnings.push('output.' + t.field + ' 变更影响几乎全部时间派生物与所有帧，属于方向性决策，请先与用户确认');
          keeps.add('audio:sfx（clock:output 事件不重合成）');
        } else if (t.field?.startsWith('video') || t.field?.startsWith('audio')) {
          inv.add('deliver:mux'); inv.add('verify:video'); inv.add('report');
          reruns.add('编码参数变更：重编码，不重抓帧');
          keeps.add('frames:*');
        }
        break;
      case 'scene':
        if (!t.field || ['dur', 'rate', 'accel', 'camera', 'shots', 'effects', 'post', 'layers', 'audio', 'asserts', 'id', 'name', 'act'].includes(t.field.split('.')[0])) {
          const id = t.sceneId?.startsWith('#') ? sceneIds[parseInt(t.sceneId.slice(1), 10)] : t.sceneId;
          sceneFrames(t.sceneId && !t.sceneId.startsWith('#') ? [t.sceneId as string] : (id ? [id] : null));
          if (t.field === 'dur') {
            inv.add('map'); inv.add('audio:mix'); inv.add('verify:audio'); inv.add('audio:env');
            warnings.push(`幕 "${id}" 的 dur 变更会改变总时长与全部下游时间派生物`);
          }
          if (t.field === 'accel' || t.field === 'shots') {
            warnings.push('accel/shots 变更会改变该幕动画时钟 lt 映射，阈值类断言需重校（L-ACC-001）');
          }
        }
        break;
      case 'layer':
        sceneFrames(t.sceneId ? [t.sceneId] : null);
        break;
      case 'theme':
        allFrames();
        keeps.add('audio:*（音频不受影响）');
        break;
      case 'pace': {
        inv.add('map'); inv.add('audio:mix'); inv.add('verify:audio'); inv.add('audio:env');
        const all = sceneIds;
        sceneFrames(all);
        keeps.add('audio:sfx（clock:output 事件无需重合成）');
        keeps.add('audio:music');
        warnings.push('pace 变更会重映射全部 t↔T，所有帧内容随之改变（sfx 不必重做，见 07-音频流水线）');
        break;
      }
      case 'audio':
        if (t.field?.startsWith('music')) {
          audioChain({ musicToo: true, envToo: true });
          inv.add('audio:env');
          keeps.add('frames:*（音频不影响画面）');
          warnings.push('music 文件变更：缓存中 env/mix 全部失效');
        } else {
          audioChain({ sfxToo: true });
          keeps.add('frames:*（音频不影响画面）');
          keeps.add('audio:env');
        }
        break;
      case 'render':
        if (t.field?.includes('surface')) { allFrames(); }
        else { keeps.add('产物不变，仅执行参数') }
        break;
      case 'project':
        if (t.field === 'seed') {
          allFrames();
          warnings.push('project.seed 变更会改变一切画面（确定性随机根）');
        } else { keeps.add('title/id/version 为元数据') }
        break;
      case 'asserts':
        keeps.add('frames:*（仅断言集改变）');
        reruns.add('check');
        break;
      default:
        warnings.push('未知改动路径：无法给出精确影响面，建议 audit 全量');
    }
  }

  // 反向：未被 invalidate 的节点进 keeps
  const known = ['map', 'audio:music', 'audio:env', 'audio:sfx', 'audio:mix', 'video:concat', 'deliver:mux', 'verify:video', 'verify:audio', 'metrics:visual', 'report', ...sceneIds.map((s) => `frames:${s}`)];
  for (const k of known) {
    if (!inv.has(k) && ![...keeps].some((x) => x.startsWith(k))) keeps.add(k === 'map' ? 'map' : k);
  }

  const frames = rerenderAll ? totalFrames : Math.min(rerenderFrames, totalFrames);
  const minPerFrame = 0.25; // 秒/帧（4 worker 保守估计）
  const renderMin = (frames * minPerFrame) / 60;
  return {
    invalidates: [...inv].sort(),
    reruns: [...reruns],
    keeps: [...keeps].sort(),
    warnings,
    approx: {
      rerender: frames === 0 ? '无需重渲染' : `${frames} 帧 ≈ ${renderMin < 0.6 ? '<1' : Math.round(renderMin)} 分钟（4 worker）`,
      remix: inv.has('audio:mix') ? '混音重跑 ≈ 10–30s' : '无需重混',
      frames,
    },
  };
}

// cam_jitter —— 解析复算（禁相位相关）：从 IR 逐帧复算 (dx,dy,roll)，统计帧间差分分位数
import { cameraAt } from '@kine/dsl/camera';
import { pointAtFrame, sceneLt, sceneAtT } from '@kine/dsl/time';
import type { KineIR, CompiledScene, CompiledShot } from '@kine/dsl';

export interface CamJitterData {
  /** 水平位移帧间差（px） */
  hP50: number; hP90: number; hP99: number; hMax: number;
  /** 滚转帧间差（度） */
  rollP50: number; rollP90: number; rollP99: number; rollMax: number;
  over4: number;
  frames: number;
  /** frame → 该帧的 |Δ(dx,dy)| px */
  samples: { frame: number; d: number; droll: number; scene: string }[];
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

function shotAtLt(scene: CompiledScene, lt: number): CompiledShot | null {
  if (!scene.shots || scene.shots.length === 0) return null;
  for (const sh of scene.shots) {
    if (lt >= sh.lt0 && lt < sh.lt1 + 1e-9) return sh;
  }
  return scene.shots[scene.shots.length - 1] ?? null;
}

function activeCamera(scene: CompiledScene, lt: number) {
  const sh = shotAtLt(scene, lt);
  return sh ? sh.camera : scene.camera;
}

/** 计算指定幕（或全片）的摄影机抖动。排除跨镜头/跨幕的帧对（那是有意跳变，非抖动）。 */
export function computeCamJitter(ir: KineIR, opts: { sceneId?: string } = {}): CamJitterData {
  const { map } = ir.time;
  const seed = ir.project.seed;
  const S = Math.min(ir.output.width, ir.output.height);
  const scenes = opts.sceneId ? ir.scenes.filter((s) => s.id === opts.sceneId) : ir.scenes;

  const samples: CamJitterData['samples'] = [];
  for (const scene of scenes) {
    let prev: { x: number; y: number; roll: number; shotIdx: number } | null = null;
    for (let f = scene.frame0; f < scene.frame1; f++) {
      const T = pointAtFrame(map, f).T;
      const active = sceneAtT(map, T);
      const lt = active?.id === scene.id ? sceneLt(active, T) : 0;
      const cam = cameraAt(activeCamera(scene, lt), { T, lt, seed, S });
      const shotIdx = shotAtLt(scene, lt)?.index ?? -1;
      if (prev && prev.shotIdx === shotIdx) {
        samples.push({
          frame: f,
          d: Math.hypot(cam.dx - prev.x, cam.dy - prev.y),
          droll: Math.abs(cam.roll - prev.roll),
          scene: scene.id,
        });
      }
      prev = { x: cam.dx, y: cam.dy, roll: cam.roll, shotIdx };
    }
  }
  const hs = samples.map((s) => s.d).sort((a, b) => a - b);
  const rs = samples.map((s) => s.droll).sort((a, b) => a - b);
  return {
    hP50: pct(hs, 50), hP90: pct(hs, 90), hP99: pct(hs, 99), hMax: hs.length ? hs[hs.length - 1] : 0,
    rollP50: pct(rs, 50), rollP90: pct(rs, 90), rollP99: pct(rs, 99), rollMax: rs.length ? rs[rs.length - 1] : 0,
    over4: samples.filter((s) => s.d > 4).length,
    frames: samples.length,
    samples,
  };
}

/** 全片每帧的 post.flash 值（发灰根因联查用） */
export function computePostSeries(ir: KineIR): { maxFlash: number; meanFlash: number } {
  const { map } = ir.time;
  const seed = ir.project.seed;
  const S = Math.min(ir.output.width, ir.output.height);
  let maxFlash = 0;
  let sum = 0;
  let n = 0;
  for (const scene of ir.scenes) {
    for (let f = scene.frame0; f < scene.frame1; f++) {
      const T = pointAtFrame(map, f).T;
      const active = sceneAtT(map, T);
      const lt = active?.id === scene.id ? sceneLt(active, T) : 0;
      const cam = cameraAt(activeCamera(scene, lt), { T, lt, seed, S });
      const beat = cam.tw * cam.flash2;
      const flash = Math.min(ir.theme.post.flash.max_alpha, ir.theme.post.flash.max_alpha * cam.flash2 * (0.35 + 0.65 * cam.tw));
      void beat;
      maxFlash = Math.max(maxFlash, flash);
      sum += flash;
      n++;
    }
  }
  return { maxFlash, meanFlash: n ? sum / n : 0 };
}

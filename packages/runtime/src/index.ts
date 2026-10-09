// @kine/runtime — 公共入口
export { createRuntime, type KineRuntime } from './runtime';
export { drawFrame, layerOpacity, type DrawFrameOptions, type FrameReport } from './compositor';
export { resolveTheme, rgba, hexRgb, mixHex, type ResolvedTheme } from './theme';
export { registerWidget, getWidget, listWidgets, P, num, str, type WidgetDef, type WidgetDrawCtx, type WidgetEnv, type WidgetProbe } from './widgets-api';
export { drawParticles, type ParticleCtx } from './particles';
export { drawTextLayer, interpolateText, type TextDrawResult, type TextInterpEnv } from './text';
export { drawFx, type FxArgs } from './effects';
export { drawTransition, type TransitionView } from './transitions';
export { drawPost } from './post';
export type { ProbeElement, ProbeResult, FrameAssets, KineIR, CompiledScene, CompiledShot } from './types';
// 时间/随机/相机单一真源（来自 @kine/dsl）
export { TtoT, tToT, pointAt, sceneAtT, sceneLt, headImpact, type TimeMap, type TimePoint } from '@kine/dsl/time';
export { cameraAt, postAt, type CameraState, type PostState } from '@kine/dsl/camera';
export { makeRng, makeRngSeq, hash64, fnv1a32, mulberry32, frac, type Rng } from '@kine/dsl/rand';

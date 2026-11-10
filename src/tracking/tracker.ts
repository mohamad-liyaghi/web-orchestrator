import {
  FaceLandmarker,
  FilesetResolver,
  HandLandmarker,
  type FaceLandmarkerResult,
  type HandLandmarkerResult,
} from '@mediapipe/tasks-vision';
import { ASSETS } from '../config';
import { AppError, type LoadProgress, type Tracker, type TrackingFrame } from '../types';
import { fetchWithProgress } from './download';
import { FaceTracker } from './face';
import { HandTracker } from './hands';
import { muteRuntimeLogs } from './logs';
import { QualityMonitor } from './quality';

type Delegate = 'GPU' | 'CPU';
type WasmFileset = Awaited<ReturnType<typeof FilesetResolver.forVisionTasks>>;

/** Low-power cap: ~18 processed frames per second. */
const LOW_POWER_INTERVAL_MS = 1000 / 18;
/** Processing cost (EMA, ms) above which the face model is skipped on alternate frames. */
const SLOW_MS = 26;
/** ...and above which it only runs every third frame. */
const VERY_SLOW_MS = 40;
/** Cost below which full rate is restored. */
const FAST_MS = 16;
/** Never use more than ~2/3 of the main thread for tracking: min interval = cost * this. */
const DUTY_FACTOR = 1.5;
/** Consecutive failed frames before the GPU delegate is replaced by the CPU one. */
const GPU_FAILURES_BEFORE_FALLBACK = 8;
/** First GPU frames compile shaders and are slow everywhere: not counted when judging the GPU. */
const GPU_SKIP_FRAMES = 3;
/** A GPU averaging more than this per frame over 10 frames (software WebGL) is worse than the CPU. */
const GPU_TOO_SLOW_MS = 120;
/** ...or frames arriving further apart than this over 2 frames (GPU work also stalls outside
 *  detectForVideo, so the wall-clock gap is measured too; no camera is slower than 2 fps). */
const GPU_HOPELESS_MS = 500;
/** rVFC does not fire for some hidden/offscreen video elements: switch to rAF if it stalls. */
const RVFC_STALL_MS = 1000;

const HAND_OPTIONS = {
  runningMode: 'VIDEO',
  numHands: 2,
  minHandDetectionConfidence: 0.6,
  minHandPresenceConfidence: 0.5,
  minTrackingConfidence: 0.5,
} as const;

const FACE_OPTIONS = {
  runningMode: 'VIDEO',
  numFaces: 1,
  minFaceDetectionConfidence: 0.5,
  minFacePresenceConfidence: 0.5,
  minTrackingConfidence: 0.5,
  outputFaceBlendshapes: true,
  outputFacialTransformationMatrixes: false,
} as const;

interface ModelSources {
  fileset: WasmFileset;
  hand: Uint8Array | string;
  face: Uint8Array | string;
}

const ema = (prev: number, sample: number): number => (prev ? prev + (sample - prev) * 0.1 : sample);

/**
 * True when WebGL2 runs on a software rasterizer (SwiftShader, llvmpipe, Microsoft Basic Render).
 * MediaPipe's GPU delegate "works" there but is many times slower than its CPU path.
 */
function softwareWebGl(): boolean {
  try {
    const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(1, 1) : document.createElement('canvas');
    const gl = canvas.getContext('webgl2') as WebGL2RenderingContext | null;
    if (!gl) return true; // no WebGL2: the GPU delegate cannot run anyway
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : '';
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer);
  } catch {
    return false;
  }
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * MediaPipe hand + face tracking on the camera <video>.
 * One processed frame = hands (every frame) + face (every frame, or every 2nd/3rd when slow).
 */
export interface TrackerOptions {
  /** Force a delegate instead of GPU-first (debugging, tests). */
  delegate?: Delegate;
}

export class MediaPipeTracker implements Tracker {
  delegate: Delegate | null = null;

  constructor(private readonly options: TrackerOptions = {}) {}

  private hands: HandLandmarker | null = null;
  private face: FaceLandmarker | null = null;
  private fileset: WasmFileset | null = null;
  private initPromise: Promise<void> | null = null;
  private disposed = false;
  private recreating = false;
  private unmuteLogs: (() => void) | null = null;
  private gpuFrames = 0;
  private gpuJudgeMs = 0;
  private gpuJudgeGapMs = 0;

  private video: HTMLVideoElement | null = null;
  private onFrame: ((frame: TrackingFrame) => void) | null = null;
  private running = false;
  private rafId = 0;
  private rvfcId = 0;
  private useRvfc = false;
  private watchdog = 0;
  private lastTick = 0;

  private lowPower = false;
  /** Smoothed cost (ms) of one hand / face detection. */
  private handCost = 0;
  private faceCost = 0;
  /** Run the face model on every Nth processed frame (1..3). */
  private faceEvery = 1;
  private frameNo = 0;
  private lastProcessed = 0;
  private lastVideoTime = -1;
  private lastHandTs = 0;
  private lastFaceTs = 0;
  private fps = 0;
  private failures = 0;
  private loggedError = false;
  private loggedCallbackError = false;

  private readonly handTracker = new HandTracker();
  private readonly faceTracker = new FaceTracker();
  private readonly quality = new QualityMonitor();
  private buf: 0 | 1 = 0;
  private readonly frames: [TrackingFrame, TrackingFrame] = [
    { t: 0, hands: [], face: null, fps: 0, quality: { score: 0, verdict: 'no-hands', ideal: false, brightness: 0, handScale: 0 }, video: { width: 0, height: 0 } },
    { t: 0, hands: [], face: null, fps: 0, quality: { score: 0, verdict: 'no-hands', ideal: false, brightness: 0, handScale: 0 }, video: { width: 0, height: 0 } },
  ];

  // -------------------------------------------------------------------------------------------
  // Loading
  // -------------------------------------------------------------------------------------------

  init(onProgress?: (p: LoadProgress) => void): Promise<void> {
    if (this.disposed) return Promise.reject(new AppError('model-load-failed', 'The tracker was already closed.'));
    // MediaPipe's native runtime prints its internal logs through console.*; keep the console clean.
    this.unmuteLogs ??= muteRuntimeLogs();
    this.initPromise ??= this.load(onProgress);
    return this.initPromise;
  }

  private async load(onProgress?: (p: LoadProgress) => void): Promise<void> {
    const report = (p: LoadProgress) => {
      try {
        onProgress?.(p);
      } catch {
        // A UI callback failure must not abort model loading.
      }
    };
    const progress = (stage: LoadProgress['stage'], label: string) => (loaded: number, total: number) =>
      report({ stage, label, loaded, total, done: false });

    let wasmUrl: string | null = null;
    try {
      report({ stage: 'runtime', label: 'Loading the vision runtime', loaded: 0, total: 0, done: false });
      const fileset = await FilesetResolver.forVisionTasks(ASSETS.mediapipeWasm);
      this.fileset = fileset;

      // Download the runtime and both models in parallel with real byte progress. The runtime is
      // handed to MediaPipe as a blob URL so it is not downloaded a second time.
      const [wasm, hand, face] = await Promise.all([
        fetchWithProgress(fileset.wasmBinaryPath, progress('runtime', 'Loading the vision runtime')),
        fetchWithProgress(ASSETS.handModel, progress('hands', 'Loading the hand model')),
        fetchWithProgress(ASSETS.faceModel, progress('face', 'Loading the face model')),
      ]);
      if (this.disposed) return;
      wasmUrl = URL.createObjectURL(new Blob([wasm], { type: 'application/wasm' }));
      report({ stage: 'runtime', label: 'Vision runtime ready', loaded: wasm.byteLength, total: wasm.byteLength, done: true });

      const sources: ModelSources = { fileset: { ...fileset, wasmBinaryPath: wasmUrl }, hand, face };
      const first: Delegate = this.options.delegate ?? (softwareWebGl() ? 'CPU' : 'GPU');
      const created = await this.create(sources, first, report).catch(async (gpuError: unknown) => {
        if (this.disposed || first === 'CPU') throw gpuError;
        console.info('[tracking] GPU delegate unavailable, using CPU:', describe(gpuError));
        return this.create(sources, 'CPU', report);
      });
      if (this.disposed) {
        created.hands.close();
        created.face.close();
        return;
      }
      this.hands = created.hands;
      this.face = created.face;
      this.delegate = created.delegate;
    } catch (e) {
      this.initPromise = null; // allow a retry
      if (e instanceof AppError) throw e;
      throw new AppError('model-load-failed', `The tracking models could not be loaded (${describe(e)}). Check your connection and try again.`, {
        cause: e,
      });
    } finally {
      if (wasmUrl) URL.revokeObjectURL(wasmUrl);
    }
  }

  private async create(
    src: ModelSources,
    delegate: Delegate,
    report?: (p: LoadProgress) => void,
  ): Promise<{ hands: HandLandmarker; face: FaceLandmarker; delegate: Delegate }> {
    const base = (asset: Uint8Array | string) =>
      typeof asset === 'string' ? { modelAssetPath: asset, delegate } : { modelAssetBuffer: asset, delegate };
    let hands: HandLandmarker | null = null;
    try {
      hands = await HandLandmarker.createFromOptions(src.fileset, { ...HAND_OPTIONS, baseOptions: base(src.hand) });
      report?.({ stage: 'hands', label: `Hand tracking ready (${delegate})`, loaded: 1, total: 1, done: true });
      const face = await FaceLandmarker.createFromOptions(src.fileset, { ...FACE_OPTIONS, baseOptions: base(src.face) });
      report?.({ stage: 'face', label: `Face tracking ready (${delegate})`, loaded: 1, total: 1, done: true });
      return { hands, face, delegate };
    } catch (e) {
      hands?.close();
      throw e;
    }
  }

  /** GPU failing (lost context, driver bug) or far too slow: rebuild both landmarkers on the CPU, once. */
  private async fallBackToCpu(reason: string): Promise<void> {
    if (this.recreating || this.delegate !== 'GPU' || !this.fileset) return;
    this.recreating = true;
    console.info(`[tracking] switching to the CPU delegate: ${reason}`);
    const old = [this.hands, this.face];
    this.hands = null;
    this.face = null;
    for (const lm of old) {
      try {
        lm?.close();
      } catch {
        // already broken
      }
    }
    try {
      const created = await this.create({ fileset: this.fileset, hand: ASSETS.handModel, face: ASSETS.faceModel }, 'CPU');
      if (this.disposed) {
        created.hands.close();
        created.face.close();
        return;
      }
      this.hands = created.hands;
      this.face = created.face;
      this.delegate = 'CPU';
      this.failures = 0;
      this.lastHandTs = 0;
      this.lastFaceTs = 0;
      this.handCost = 0;
      this.faceCost = 0;
      this.faceEvery = 1;
    } catch (e) {
      console.error('[tracking] CPU fallback failed:', describe(e));
    } finally {
      this.recreating = false;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Loop
  // -------------------------------------------------------------------------------------------

  start(video: HTMLVideoElement, onFrame: (frame: TrackingFrame) => void): void {
    if (this.disposed) return;
    this.stop();
    this.video = video;
    this.onFrame = onFrame;
    this.running = true;
    this.lastVideoTime = -1;
    this.lastProcessed = 0;
    this.fps = 0;
    this.handTracker.reset();
    this.faceTracker.reset();
    this.quality.reset();
    this.useRvfc = typeof video.requestVideoFrameCallback === 'function';
    document.addEventListener('visibilitychange', this.onVisibility);
    if (!document.hidden) this.schedule();
  }

  setLowPower(on: boolean): void {
    this.lowPower = on;
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.unschedule();
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.video = null;
    this.onFrame = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
    for (const lm of [this.hands, this.face]) {
      try {
        lm?.close();
      } catch {
        // closing a broken GPU graph can throw; nothing left to free
      }
    }
    this.hands = null;
    this.face = null;
    this.fileset = null;
    this.delegate = null;
    this.quality.release();
    const unmute = this.unmuteLogs;
    this.unmuteLogs = null;
    // A load still in flight keeps creating landmarkers (and logging); unmute once it settles.
    if (this.initPromise) this.initPromise.then(unmute, unmute);
    else unmute?.();
  }

  private schedule(): void {
    const video = this.video;
    if (!this.running || !video) return;
    this.lastTick = performance.now();
    if (this.useRvfc) {
      this.rvfcId = video.requestVideoFrameCallback(this.tick);
      if (!this.watchdog) this.watchdog = window.setInterval(this.checkStall, RVFC_STALL_MS);
    } else {
      this.rafId = requestAnimationFrame(this.tick);
    }
  }

  private unschedule(): void {
    if (this.rvfcId && this.video) this.video.cancelVideoFrameCallback(this.rvfcId);
    this.rvfcId = 0;
    cancelAnimationFrame(this.rafId);
    this.rafId = 0;
    window.clearInterval(this.watchdog);
    this.watchdog = 0;
  }

  private readonly checkStall = (): void => {
    const video = this.video;
    if (!this.running || !video || document.hidden || video.paused) return;
    if (performance.now() - this.lastTick > RVFC_STALL_MS) {
      // The element is playing but no video frame callback arrived: drive the loop with rAF.
      this.unschedule();
      this.useRvfc = false;
      this.schedule();
    }
  };

  private readonly onVisibility = (): void => {
    if (!this.running) return;
    if (document.hidden) {
      this.unschedule();
    } else {
      // Hands and face from before the pause are stale; start clean.
      this.handTracker.reset();
      this.faceTracker.reset();
      this.lastProcessed = 0;
      this.fps = 0;
      this.unschedule();
      this.schedule();
    }
  };

  private readonly tick = (): void => {
    this.rvfcId = 0;
    this.rafId = 0;
    if (!this.running) return;
    // Schedule first: whatever happens below, the loop keeps going.
    this.schedule();
    try {
      this.process();
    } catch (e) {
      this.noteFailure(e);
    }
  };

  private process(): void {
    const video = this.video;
    const hands = this.hands;
    const face = this.face;
    if (!video || !hands || !face || this.recreating) return;
    if (video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) return;
    const videoTime = video.currentTime;
    if (videoTime === this.lastVideoTime) return; // no new camera frame

    const now = performance.now();
    const faceEvery = Math.max(this.faceEvery, this.lowPower ? 2 : 1);
    const avgCost = this.handCost + this.faceCost / faceEvery;
    const interval = Math.max(this.lowPower ? LOW_POWER_INTERVAL_MS : 0, avgCost * DUTY_FACTOR);
    // 2 ms of slack so a 30 fps camera is not dropped to 15 by timer jitter.
    if (this.lastProcessed && now - this.lastProcessed < interval - 2) return;
    this.lastVideoTime = videoTime;

    const runFace = this.frameNo++ % faceEvery === 0;

    let handResult: HandLandmarkerResult | null = null;
    let faceResult: FaceLandmarkerResult | null = null;
    let failed = false;
    const t0 = performance.now();
    try {
      this.lastHandTs = Math.max(t0, this.lastHandTs + 1);
      handResult = hands.detectForVideo(video, this.lastHandTs);
    } catch (e) {
      failed = true;
      this.noteFailure(e);
    }
    const t1 = performance.now();
    this.handCost = ema(this.handCost, t1 - t0);
    if (runFace) {
      try {
        this.lastFaceTs = Math.max(t1, this.lastFaceTs + 1);
        faceResult = face.detectForVideo(video, this.lastFaceTs);
      } catch (e) {
        failed = true;
        this.noteFailure(e);
      }
      this.faceCost = ema(this.faceCost, performance.now() - t1);
    }
    if (!failed) this.failures = 0;
    this.adapt();
    if (this.delegate === 'GPU' && !failed) this.judgeGpu(performance.now() - t0, this.lastProcessed ? now - this.lastProcessed : 0);

    const w = video.videoWidth;
    const h = video.videoHeight;
    const aspect = w / h;
    const buf = this.buf;
    this.buf = buf === 0 ? 1 : 0;

    if (this.lastProcessed) {
      const inst = 1000 / Math.max(1, now - this.lastProcessed);
      this.fps = this.fps ? this.fps + (inst - this.fps) * 0.1 : inst;
    }
    this.lastProcessed = now;

    const frame = this.frames[buf];
    frame.t = now;
    frame.hands = this.handTracker.update(handResult, now, aspect, buf);
    frame.face = this.faceTracker.update(faceResult, now, aspect, buf);
    frame.fps = this.fps;
    this.quality.sample(video, now, frame.hands, frame.face);
    frame.quality = this.quality.update(frame.hands, this.fps, this.handTracker.jitter, now, buf);
    frame.video.width = w;
    frame.video.height = h;

    const cb = this.onFrame;
    if (!cb) return;
    try {
      cb(frame);
    } catch (e) {
      if (!this.loggedCallbackError) {
        this.loggedCallbackError = true;
        console.error('[tracking] frame consumer threw:', e);
      }
    }
  }

  /** Software-rendered WebGL slipped past the renderer check: measure, and drop to the CPU if hopeless. */
  private judgeGpu(frameMs: number, gapMs: number): void {
    const n = ++this.gpuFrames - GPU_SKIP_FRAMES;
    if (n <= 0 || n > 10) return;
    this.gpuJudgeMs += frameMs;
    this.gpuJudgeGapMs += gapMs;
    const mean = this.gpuJudgeMs / n;
    const gap = this.gpuJudgeGapMs / n;
    if (n >= 2 && Math.max(mean, gap) > GPU_HOPELESS_MS) {
      void this.fallBackToCpu(`GPU frames take ${Math.max(mean, gap).toFixed(0)} ms`);
    } else if (n === 10 && mean > GPU_TOO_SLOW_MS) {
      void this.fallBackToCpu(`GPU frames take ${mean.toFixed(0)} ms`);
    }
  }

  /** Pick how often the face model runs from what a full (hands + face) frame costs. */
  private adapt(): void {
    const full = this.handCost + this.faceCost;
    if (full > VERY_SLOW_MS) this.faceEvery = 3;
    else if (full > SLOW_MS) this.faceEvery = Math.max(this.faceEvery, 2);
    else if (full < FAST_MS) this.faceEvery = 1;
  }

  /** Current adaptive state, for the debug harness. */
  get stats(): { handMs: number; faceMs: number; faceEvery: number; lowPower: boolean } {
    return { handMs: this.handCost, faceMs: this.faceCost, faceEvery: Math.max(this.faceEvery, this.lowPower ? 2 : 1), lowPower: this.lowPower };
  }

  private noteFailure(e: unknown): void {
    this.failures++;
    if (!this.loggedError) {
      this.loggedError = true;
      console.warn('[tracking] frame failed:', describe(e));
    }
    if (this.failures >= GPU_FAILURES_BEFORE_FALLBACK && this.delegate === 'GPU') {
      void this.fallBackToCpu(`${this.failures} frames failed in a row`);
    }
  }
}

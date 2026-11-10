/**
 * Standalone tracking harness: camera + tracker + a debug overlay. Dev only (served by vite at
 * /dev/tracking.html, not part of the production build).
 *
 *   ?auto      start immediately (headless tests)
 *   ?lowpower  start in low-power mode
 *   ?cpu / ?gpu force a MediaPipe delegate (default: GPU first, CPU fallback)
 *
 * window.__tracking exposes a JSON summary for automated checks.
 */
import { HandLandmarker } from '@mediapipe/tasks-vision';
import { coverMap, toScreen, type CoverMap } from '../src/geometry';
import { closeCamera, createTracker, openCamera } from '../src/tracking';
import { measureFingers, thumbAngle } from '../src/tracking/hands';
import { MediaPipeTracker } from '../src/tracking/tracker';
import { AppError, type FrameQuality, type LoadProgress, type Tracker, type TrackingFrame, type Vec2 } from '../src/types';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing`);
  return el as T;
};

const video = $<HTMLVideoElement>('video');
const canvas = $<HTMLCanvasElement>('overlay');
const panel = $<HTMLDivElement>('panel');
const lowPowerBox = $<HTMLInputElement>('lowpower');
const ctx = canvas.getContext('2d')!;
const params = new URLSearchParams(location.search);

interface Summary {
  state: 'idle' | 'loading' | 'running' | 'error';
  error: { code: string; message: string } | null;
  delegate: Tracker['delegate'];
  cameraMs: number;
  modelsMs: number;
  progress: LoadProgress[];
  frames: number;
  fps: number;
  stats: MediaPipeTracker['stats'] | null;
  video: { width: number; height: number };
  hands: Array<{
    id: number;
    side: string;
    score: number;
    indexTip: Vec2;
    pinch: number;
    pinching: boolean;
    fingersUp: number;
    gesture: string;
    /** Debounced extended fingers as a string, e.g. "T I . . P". */
    fingers: string;
    rollDeg: number;
    thumbOut: boolean;
    thumbAngleDeg: number;
    /** thumb, index, middle, ring, pinky extension ratios (see measureFingers). */
    ratios: number[];
    centerX: number;
    boxH: number;
    age: number;
  }>;
  face: null | {
    mouthOpen: number;
    mouthIsOpen: boolean;
    pucker: number;
    smile: number;
    browUp: number;
    box: { x: number; y: number; w: number; h: number };
    mouthCenter: Vec2;
  };
  quality: FrameQuality | null;
  /** Verdicts seen so far, with counts of frames. */
  verdicts: Record<string, number>;
  gestures: Record<string, number>;
  /** Max / min mouthOpen seen since the last reset, for scripted checks. */
  mouthMax: number;
  mouthMin: number;
  consoleErrors: string[];
}

const summary: Summary = {
  state: 'idle',
  error: null,
  delegate: null,
  cameraMs: 0,
  modelsMs: 0,
  progress: [],
  frames: 0,
  fps: 0,
  stats: null,
  video: { width: 0, height: 0 },
  hands: [],
  face: null,
  quality: null,
  verdicts: {},
  gestures: {},
  mouthMax: 0,
  mouthMin: 1,
  consoleErrors: [],
};

declare global {
  interface Window {
    __tracking: { summary: Summary; resetMouth(): void; tracker: Tracker | null; frame: TrackingFrame | null };
  }
}
window.__tracking = {
  summary,
  tracker: null,
  frame: null,
  resetMouth() {
    summary.mouthMax = 0;
    summary.mouthMin = 1;
  },
};

for (const level of ['error', 'warn'] as const) {
  const orig = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    summary.consoleErrors.push(`${level}: ${args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ')}`.slice(0, 300));
    if (summary.consoleErrors.length > 50) summary.consoleErrors.shift();
    orig(...args);
  };
}
window.addEventListener('error', (e) => summary.consoleErrors.push(`uncaught: ${e.message}`));
window.addEventListener('unhandledrejection', (e) => summary.consoleErrors.push(`unhandled: ${String(e.reason)}`));

let tracker: Tracker | null = null;
let stream: MediaStream | null = null;
let latest: TrackingFrame | null = null;
let raf = 0;

async function start(): Promise<void> {
  if (summary.state === 'loading' || summary.state === 'running') return;
  summary.state = 'loading';
  summary.error = null;
  summary.progress = [];
  panel.textContent = 'Starting…';
  const forced = params.has('cpu') ? 'CPU' : params.has('gpu') ? 'GPU' : undefined;
  const t = forced ? new MediaPipeTracker({ delegate: forced }) : createTracker();
  tracker = t;
  window.__tracking.tracker = t;
  try {
    const t0 = performance.now();
    const models = t.init((p) => {
      summary.progress.push(p);
      panel.textContent = `${p.stage}: ${p.label} ${p.total ? `${((p.loaded / p.total) * 100).toFixed(0)}%` : ''}`;
    });
    models.catch(() => undefined);
    stream = await openCamera(video);
    summary.cameraMs = performance.now() - t0;
    await models;
    summary.modelsMs = performance.now() - t0;
    summary.delegate = t.delegate;
    t.setLowPower(lowPowerBox.checked);
    t.start(video, (f) => {
      latest = f;
      window.__tracking.frame = f;
      summary.frames++;
      summary.verdicts[f.quality.verdict] = (summary.verdicts[f.quality.verdict] ?? 0) + 1;
      for (const h of f.hands) summary.gestures[h.gesture] = (summary.gestures[h.gesture] ?? 0) + 1;
    });
    summary.state = 'running';
    raf = requestAnimationFrame(draw);
  } catch (e) {
    const err = e instanceof AppError ? e : new AppError('unknown', String(e));
    summary.state = 'error';
    summary.error = { code: err.code, message: err.message };
    const p = document.createElement('div');
    p.id = 'error';
    p.textContent = `${err.code}: ${err.message}`;
    panel.replaceChildren(p);
    stop(false);
  }
}

function stop(resetState = true): void {
  cancelAnimationFrame(raf);
  tracker?.dispose();
  tracker = null;
  closeCamera(stream, video);
  stream = null;
  latest = null;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (resetState) {
    summary.state = 'idle';
    panel.textContent = 'Stopped.';
  }
}

// -------------------------------------------------------------------------------------------
// Overlay
// -------------------------------------------------------------------------------------------

const HAND_COLORS = ['#38e1ff', '#ff5cc8'];

function sizeCanvas(): CoverMap | null {
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (!video.videoWidth) return null;
  return coverMap(video.videoWidth, video.videoHeight, w, h);
}

function poly(m: CoverMap, pts: readonly Vec2[], color: string): void {
  ctx.beginPath();
  pts.forEach((p, i) => {
    const s = toScreen(m, p);
    if (i === 0) ctx.moveTo(s.x, s.y);
    else ctx.lineTo(s.x, s.y);
  });
  ctx.closePath();
  ctx.strokeStyle = color;
  ctx.stroke();
}

function rect(m: CoverMap, b: { x: number; y: number; w: number; h: number }, color: string): void {
  const a = toScreen(m, b);
  const c = toScreen(m, { x: b.x + b.w, y: b.y + b.h });
  ctx.strokeStyle = color;
  ctx.strokeRect(a.x, a.y, c.x - a.x, c.y - a.y);
}

function label(text: string, p: Vec2, color: string): void {
  ctx.font = '600 13px ui-monospace, monospace';
  ctx.fillStyle = 'rgba(5,6,10,0.7)';
  const w = ctx.measureText(text).width;
  ctx.fillRect(p.x - 2, p.y - 13, w + 4, 17);
  ctx.fillStyle = color;
  ctx.fillText(text, p.x, p.y);
}

const f2 = (v: number) => v.toFixed(2);
const fingerString = (f: readonly boolean[]): string => f.map((on, i) => (on ? 'TIMRP'[i] : '.')).join('');

function draw(): void {
  raf = requestAnimationFrame(draw);
  const m = sizeCanvas();
  ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
  const f = latest;
  if (!m || !f) return;
  ctx.lineWidth = 2;

  for (const hand of f.hands) {
    const color = HAND_COLORS[hand.id] ?? '#fff';
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.85;
    ctx.beginPath();
    for (const c of HandLandmarker.HAND_CONNECTIONS) {
      const a = toScreen(m, hand.landmarks[c.start]!);
      const b = toScreen(m, hand.landmarks[c.end]!);
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
    ctx.fillStyle = color;
    for (const p of hand.landmarks) {
      const s = toScreen(m, p);
      ctx.fillRect(s.x - 2, s.y - 2, 4, 4);
    }
    ctx.globalAlpha = 1;
    rect(m, hand.box, color);
    const tip = toScreen(m, hand.indexTip);
    ctx.beginPath();
    ctx.arc(tip.x, tip.y, hand.pinching ? 12 : 8, 0, Math.PI * 2);
    ctx.stroke();
    const corner = toScreen(m, hand.box);
    label(
      `#${hand.id} ${hand.side} ${hand.gesture} ${fingerString(hand.fingers)} roll ${Math.round((hand.roll * 180) / Math.PI)}°${hand.thumbOut ? ' thumb-out' : ''} pinch ${f2(hand.pinch)}${hand.pinching ? ' ●' : ''}`,
      { x: corner.x, y: corner.y - 6 },
      color,
    );
  }

  const face = f.face;
  if (face) {
    rect(m, face.box, '#7dff9a');
    poly(m, face.outerLips, face.mouthIsOpen ? '#ffd45c' : '#7dff9a');
    poly(m, face.innerLips, face.mouthIsOpen ? '#ffd45c' : '#7dff9a');
    const c = toScreen(m, face.mouthCenter);
    ctx.fillStyle = '#ffd45c';
    ctx.fillRect(c.x - 3, c.y - 3, 6, 6);
    // mouthOpen meter beside the face box
    const a = toScreen(m, { x: face.box.x + face.box.w, y: face.box.y });
    const b = toScreen(m, { x: face.box.x + face.box.w, y: face.box.y + face.box.h });
    const h = b.y - a.y;
    ctx.fillStyle = 'rgba(255,212,92,0.25)';
    ctx.fillRect(a.x + 8, a.y, 10, h);
    ctx.fillStyle = '#ffd45c';
    ctx.fillRect(a.x + 8, a.y + h * (1 - face.mouthOpen), 10, h * face.mouthOpen);
    label(`mouth ${f2(face.mouthOpen)}${face.mouthIsOpen ? ' OPEN' : ''}`, { x: a.x + 24, y: a.y + 12 }, '#ffd45c');
  }
}

function refreshSummary(): void {
  const f = latest;
  const t = tracker as MediaPipeTracker | null;
  summary.delegate = t?.delegate ?? summary.delegate;
  summary.stats = t?.stats ?? null;
  if (f) {
    summary.fps = f.fps;
    summary.video = { ...f.video };
    const aspect = f.video.width / Math.max(1, f.video.height);
    const packed = new Float32Array(63);
    const ratios = new Float32Array(5);
    summary.quality = { ...f.quality };
    summary.hands = f.hands.map((h) => {
      h.landmarks.forEach((p, i) => packed.set([p.x, p.y, p.z], i * 3));
      measureFingers(packed, aspect, ratios);
      return {
        id: h.id,
        side: h.side,
        score: h.score,
        indexTip: { ...h.indexTip },
        pinch: h.pinch,
        pinching: h.pinching,
        fingersUp: h.fingersUp,
        gesture: h.gesture,
        fingers: fingerString(h.fingers),
        rollDeg: Math.round((h.roll * 180) / Math.PI),
        thumbOut: h.thumbOut,
        thumbAngleDeg: Math.round((thumbAngle(packed, aspect) * 180) / Math.PI),
        ratios: Array.from(ratios, (r) => Number(r.toFixed(2))),
        centerX: h.box.x + h.box.w / 2,
        boxH: h.box.h,
        age: h.age,
      };
    });
    summary.face = f.face
      ? {
          mouthOpen: f.face.mouthOpen,
          mouthIsOpen: f.face.mouthIsOpen,
          pucker: f.face.pucker,
          smile: f.face.smile,
          browUp: f.face.browUp,
          box: { ...f.face.box },
          mouthCenter: { ...f.face.mouthCenter },
        }
      : null;
    if (f.face) {
      summary.mouthMax = Math.max(summary.mouthMax, f.face.mouthOpen);
      summary.mouthMin = Math.min(summary.mouthMin, f.face.mouthOpen);
    }
  }
  if (summary.state !== 'running') return;
  const s = summary.stats;
  const lines = [
    `delegate ${summary.delegate}   fps ${summary.fps.toFixed(1)}   video ${summary.video.width}x${summary.video.height}`,
    s
      ? `hand ${s.handMs.toFixed(1)} ms   face ${s.faceMs.toFixed(1)} ms   face every ${s.faceEvery}${s.lowPower ? '   LOW POWER' : ''}`
      : '',
    `camera ${summary.cameraMs.toFixed(0)} ms   ready ${summary.modelsMs.toFixed(0)} ms`,
    summary.quality
      ? `quality ${summary.quality.verdict}${summary.quality.ideal ? ' (ideal)' : ''} score ${f2(summary.quality.score)} light ${f2(summary.quality.brightness)} scale ${f2(summary.quality.handScale)}`
      : '',
    ...summary.hands.map(
      (h) =>
        `hand #${h.id} ${h.side.padEnd(5)} ${h.gesture.padEnd(9)} ${h.fingers} roll ${h.rollDeg}° thumb ${h.thumbAngleDeg}°${h.thumbOut ? ' out' : ''} x ${f2(h.centerX)} tip ${f2(h.indexTip.x)},${f2(h.indexTip.y)} pinch ${f2(h.pinch)}${h.pinching ? '*' : ' '} fingers ${h.fingersUp} score ${f2(h.score)} age ${(h.age / 1000).toFixed(1)}s`,
    ),
    summary.face
      ? `face mouth ${f2(summary.face.mouthOpen)}${summary.face.mouthIsOpen ? ' OPEN' : '     '} pucker ${f2(summary.face.pucker)} smile ${f2(summary.face.smile)} brow ${f2(summary.face.browUp)}`
      : 'face -',
  ];
  panel.textContent = lines.filter(Boolean).join('\n');
}

// Text and the summary refresh at 10 Hz; the overlay draws every animation frame.
window.setInterval(refreshSummary, 100);

$<HTMLButtonElement>('start').addEventListener('click', () => void start());
$<HTMLButtonElement>('stop').addEventListener('click', () => stop());
lowPowerBox.checked = params.has('lowpower');
lowPowerBox.addEventListener('change', () => tracker?.setLowPower(lowPowerBox.checked));
if (params.has('auto')) void start();

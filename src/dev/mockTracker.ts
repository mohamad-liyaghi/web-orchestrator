import type { Box, FaceState, HandState, LoadProgress, Tracker, TrackingFrame, Vec2, Vec3 } from '../types';

/**
 * Synthetic tracker for development and automated tests (`?mock` in the URL).
 * Two hands sweep up and down, the mouth opens and closes, pinches come and go.
 * No camera, no MediaPipe: lets the UI and the music engine run anywhere.
 */

// Open right hand, palm to camera, mirrored view. Units: hand height, origin at the wrist.
const RIGHT_HAND: ReadonlyArray<[number, number]> = [
  [0, 0],
  [-0.12, -0.08], [-0.22, -0.18], [-0.3, -0.28], [-0.36, -0.38],
  [-0.08, -0.42], [-0.09, -0.58], [-0.1, -0.7], [-0.1, -0.8],
  [0.02, -0.44], [0.02, -0.62], [0.02, -0.75], [0.02, -0.86],
  [0.11, -0.41], [0.12, -0.57], [0.13, -0.68], [0.13, -0.77],
  [0.19, -0.35], [0.21, -0.47], [0.22, -0.56], [0.23, -0.64],
];

const HAND_SIZE = 0.32; // fraction of frame height
const VIDEO = { width: 1280, height: 720 };
const ASPECT = VIDEO.height / VIDEO.width;

function bbox(points: Vec2[]): Box {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of points) {
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function makeHand(id: number, side: 'left' | 'right', tip: Vec2, pinch: number, age: number): HandState {
  const flip = side === 'left' ? -1 : 1;
  // Put the wrist so landmark 8 (index tip) lands on `tip`.
  const [tx, ty] = RIGHT_HAND[8]!;
  const wrist = { x: tip.x - tx * flip * HAND_SIZE * ASPECT, y: tip.y - ty * HAND_SIZE };
  const landmarks: Vec3[] = RIGHT_HAND.map(([x, y], i) => {
    let px = x, py = y;
    // Pinch: pull the thumb tip toward the index tip.
    if (i === 4 || i === 3) {
      const k = pinch * (i === 4 ? 1 : 0.5);
      px = x + (tx - x) * k;
      py = y + (ty - y) * k;
    }
    return { x: wrist.x + px * flip * HAND_SIZE * ASPECT, y: wrist.y + py * HAND_SIZE, z: 0 };
  });
  const thumb = landmarks[4]!;
  const index = landmarks[8]!;
  return {
    id,
    side,
    landmarks,
    box: bbox(landmarks),
    indexTip: { x: index.x, y: index.y },
    thumbTip: { x: thumb.x, y: thumb.y },
    pinch,
    pinching: pinch > 0.7,
    fingersUp: pinch > 0.7 ? 3 : 5,
    score: 0.97,
    age,
  };
}

function ellipse(c: Vec2, rx: number, ry: number, n = 20): Vec2[] {
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    return { x: c.x + Math.cos(a) * rx, y: c.y + Math.sin(a) * ry };
  });
}

export class MockTracker implements Tracker {
  delegate: 'GPU' | 'CPU' | null = null;
  private timer: number | undefined;
  private t0 = 0;
  private lastT = 0;
  private fps = 30;

  async init(onProgress?: (p: LoadProgress) => void): Promise<void> {
    const stages: LoadProgress['stage'][] = ['runtime', 'hands', 'face'];
    for (const stage of stages) {
      onProgress?.({ stage, label: `mock ${stage}`, loaded: 1, total: 1, done: true });
      await new Promise((r) => setTimeout(r, 120));
    }
    this.delegate = 'CPU';
  }

  start(_video: HTMLVideoElement, onFrame: (frame: TrackingFrame) => void): void {
    this.stop();
    this.t0 = performance.now();
    this.lastT = this.t0;
    this.timer = window.setInterval(() => onFrame(this.frame(performance.now())), 1000 / 30);
  }

  stop(): void {
    if (this.timer !== undefined) window.clearInterval(this.timer);
    this.timer = undefined;
  }

  dispose(): void {
    this.stop();
  }

  private frame(now: number): TrackingFrame {
    const s = (now - this.t0) / 1000;
    const dt = Math.max(1, now - this.lastT);
    this.lastT = now;
    this.fps += (1000 / dt - this.fps) * 0.1;

    // Lead: stepped melody-ish sweep. Bass: slow sweep, leaves the frame now and then.
    const leadY = 0.5 + 0.32 * Math.sin(s * 0.9) * Math.cos(s * 0.23);
    const bassY = 0.55 + 0.25 * Math.sin(s * 0.4 + 1);
    const pinchWave = Math.max(0, Math.sin(s * 1.7));
    const hands: HandState[] = [];
    const bassVisible = Math.sin(s * 0.15) > -0.6;
    if (bassVisible) hands.push(makeHand(1, 'left', { x: 0.24 + 0.03 * Math.sin(s), y: bassY }, pinchWave * 0.5, s * 1000));
    hands.push(makeHand(0, 'right', { x: 0.74 + 0.04 * Math.sin(s * 1.3), y: leadY }, pinchWave, s * 1000));

    const cycle = s % 2.4;
    const target = cycle < 1.7 ? 0.35 + 0.55 * Math.abs(Math.sin(s * 2.1)) : 0;
    const mouthOpen = Math.max(0, Math.min(1, target));
    const mouthCenter = { x: 0.5, y: 0.47 };
    const face: FaceState = {
      box: { x: 0.4, y: 0.18, w: 0.2, h: 0.38 },
      mouthOpen,
      mouthIsOpen: mouthOpen > 0.22,
      pucker: Math.max(0, Math.sin(s * 0.5)) * 0.6,
      smile: 0.2,
      browUp: Math.max(0, Math.sin(s * 0.33)),
      outerLips: ellipse(mouthCenter, 0.05, 0.018 + 0.03 * mouthOpen),
      innerLips: ellipse(mouthCenter, 0.035, 0.002 + 0.026 * mouthOpen),
      mouthCenter,
    };

    return { t: now, hands, face, fps: this.fps, video: { ...VIDEO } };
  }
}

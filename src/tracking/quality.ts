import type { Box, FaceState, FrameQuality, FrameVerdict, HandState } from '../types';

/**
 * Live framing / tracking quality: brightness from a tiny downscaled copy of the video a few
 * times per second, distance from the hand size, plus cut-off hands, fps and landmark jitter.
 * The verdict is held so the HUD badge does not flicker.
 *
 * Brightness is about the player, not the room: when a face or hands are tracked it is the mean
 * luma inside their boxes (70%) blended with the whole picture (30%), so a lit player in front of
 * a dark wall is not "too dark"; with nobody tracked it is the whole picture's mean luma.
 */

const SAMPLE_W = 48;
const SAMPLE_H = 27;
const SUBJECT_WEIGHT = 0.7;
/** Brightness sampling period (~3.3 Hz). */
const SAMPLE_MS = 300;

const DARK = 0.18;
const BRIGHT = 0.92;
/** Comfortable brightness band (full score inside). */
const LIGHT_LO = 0.3;
const LIGHT_HI = 0.8;
/** Landmark this close to a frame edge = the hand is (about to be) cut off. */
const EDGE = 0.02;
const TOO_FAR = 0.16;
const TOO_CLOSE = 0.6;
/** Hand size band for a 'great' verdict. */
const SCALE_LO = 0.22;
const SCALE_HI = 0.45;
const LOW_FPS = 15;
const GREAT_FPS = 24;
/** Mean landmark jitter (fraction of hand height) above which tracking is called unstable. */
const UNSTABLE = 0.05;
const STEADY = 0.025;

/** A shown verdict stays at least this long... */
const VERDICT_HOLD_MS = 600;
/** ...and a new one must persist this long before it replaces it. */
const VERDICT_CONFIRM_MS = 250;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** 1 inside [lo, hi], falling linearly to 0 at [lo - fall, hi + fall]. */
function band(v: number, lo: number, hi: number, fallLo: number, fallHi: number): number {
  if (v < lo) return clamp01(1 - (lo - v) / fallLo);
  if (v > hi) return clamp01(1 - (v - hi) / fallHi);
  return 1;
}

function inside(b: Box | undefined, x: number, y: number): boolean {
  return !!b && x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;
}

function makeQuality(): FrameQuality {
  return { score: 0, verdict: 'no-hands', ideal: false, brightness: 0.5, handScale: 0 };
}

export class QualityMonitor {
  private canvas: HTMLCanvasElement | OffscreenCanvas | null = null;
  private ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
  private lastSample = -Infinity;
  private brightness = 0.5;
  private haveBrightness = false;
  private shown: FrameVerdict | null = null;
  private shownSince = 0;
  private candidate: FrameVerdict | null = null;
  private candidateSince = 0;
  private readonly views: [FrameQuality, FrameQuality] = [makeQuality(), makeQuality()];

  reset(): void {
    this.shown = null;
    this.candidate = null;
    this.lastSample = -Infinity;
  }

  release(): void {
    this.ctx = null;
    if (this.canvas) {
      this.canvas.width = 0;
      this.canvas.height = 0;
    }
    this.canvas = null;
  }

  /** Brightness of the current video frame (see the header); sampled at most every SAMPLE_MS. */
  sample(video: HTMLVideoElement, now: number, hands: readonly HandState[], face: FaceState | null): void {
    if (now - this.lastSample < SAMPLE_MS) return;
    this.lastSample = now;
    try {
      if (!this.ctx) {
        this.canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(SAMPLE_W, SAMPLE_H) : document.createElement('canvas');
        this.canvas.width = SAMPLE_W;
        this.canvas.height = SAMPLE_H;
        this.ctx = this.canvas.getContext('2d', { willReadFrequently: true, alpha: false }) as
          | CanvasRenderingContext2D
          | OffscreenCanvasRenderingContext2D
          | null;
        if (!this.ctx) return;
      }
      const ctx = this.ctx;
      ctx.drawImage(video, 0, 0, SAMPLE_W, SAMPLE_H);
      const px = ctx.getImageData(0, 0, SAMPLE_W, SAMPLE_H).data;
      let sum = 0;
      let subjectSum = 0;
      let subjectN = 0;
      for (let y = 0; y < SAMPLE_H; y++) {
        // Cell centers in the mirrored, normalized frame (boxes are mirrored; the canvas is not).
        const ny = (y + 0.5) / SAMPLE_H;
        for (let x = 0; x < SAMPLE_W; x++) {
          const i = (y * SAMPLE_W + x) * 4;
          const l = 0.2126 * px[i]! + 0.7152 * px[i + 1]! + 0.0722 * px[i + 2]!;
          sum += l;
          const nx = 1 - (x + 0.5) / SAMPLE_W;
          if (inside(face?.box, nx, ny) || inside(hands[0]?.box, nx, ny) || inside(hands[1]?.box, nx, ny)) {
            subjectSum += l;
            subjectN++;
          }
        }
      }
      const frameLuma = sum / (SAMPLE_W * SAMPLE_H) / 255;
      const luma = subjectN >= 4 ? SUBJECT_WEIGHT * (subjectSum / subjectN / 255) + (1 - SUBJECT_WEIGHT) * frameLuma : frameLuma;
      this.brightness = this.haveBrightness ? this.brightness + (luma - this.brightness) * 0.5 : luma;
      this.haveBrightness = true;
    } catch {
      // A tainted or not-yet-decodable frame: keep the previous value.
    }
  }

  update(hands: readonly HandState[], fps: number, jitter: number, now: number, buf: 0 | 1): FrameQuality {
    const q = this.views[buf];
    const brightness = this.brightness;

    let scale = 0;
    let cutOff = false;
    for (const h of hands) {
      scale += h.box.h;
      if (!cutOff) {
        for (const p of h.landmarks) {
          if (p.x < EDGE || p.x > 1 - EDGE || p.y < EDGE || p.y > 1 - EDGE) {
            cutOff = true;
            break;
          }
        }
      }
    }
    const handScale = hands.length ? scale / hands.length : 0;
    const measuredFps = fps > 0;

    let verdict: FrameVerdict;
    if (brightness < DARK) verdict = 'too-dark';
    else if (brightness > BRIGHT) verdict = 'too-bright';
    else if (hands.length === 0) verdict = 'no-hands';
    else if (cutOff) verdict = 'hand-cut-off';
    else if (handScale < TOO_FAR) verdict = 'too-far';
    else if (handScale > TOO_CLOSE) verdict = 'too-close';
    else if (measuredFps && fps < LOW_FPS) verdict = 'low-fps';
    else if (jitter > UNSTABLE) verdict = 'unstable';
    else {
      const great =
        brightness >= LIGHT_LO &&
        brightness <= LIGHT_HI &&
        handScale >= SCALE_LO &&
        handScale <= SCALE_HI &&
        (!measuredFps || fps >= GREAT_FPS) &&
        jitter < STEADY;
      verdict = great ? 'great' : 'good';
    }

    const light = band(brightness, LIGHT_LO, LIGHT_HI, LIGHT_LO - DARK + 0.12, BRIGHT - LIGHT_HI + 0.08);
    let score: number;
    if (hands.length === 0) {
      score = 0.25 * light;
    } else {
      const size = band(handScale, SCALE_LO, SCALE_HI, SCALE_LO - TOO_FAR + 0.1, TOO_CLOSE - SCALE_HI + 0.15);
      const speed = measuredFps ? band(fps, GREAT_FPS, 1000, GREAT_FPS - LOW_FPS + 6, 1) : 1;
      const steady = band(jitter, 0, STEADY, 1, UNSTABLE - STEADY + 0.04);
      score = light * (0.4 + 0.6 * size) * (0.5 + 0.5 * speed) * (0.5 + 0.5 * steady) * (cutOff ? 0.6 : 1);
    }

    q.verdict = this.hold(verdict, now);
    q.ideal = q.verdict === 'great';
    q.score = clamp01(score);
    q.brightness = brightness;
    q.handScale = handScale;
    return q;
  }

  private hold(verdict: FrameVerdict, now: number): FrameVerdict {
    if (this.shown === null) {
      this.shown = verdict;
      this.shownSince = now;
      this.candidate = verdict;
      this.candidateSince = now;
      return verdict;
    }
    if (verdict !== this.candidate) {
      this.candidate = verdict;
      this.candidateSince = now;
    }
    if (
      this.candidate !== this.shown &&
      now - this.candidateSince >= VERDICT_CONFIRM_MS &&
      now - this.shownSince >= VERDICT_HOLD_MS
    ) {
      this.shown = this.candidate;
      this.shownSince = now;
    }
    return this.shown;
  }
}

import type { Category, FaceLandmarkerResult, NormalizedLandmark } from '@mediapipe/tasks-vision';
import type { FaceState, Vec2 } from '../types';
import { OneEuroBank } from './oneEuro';

/**
 * FaceLandmarker result -> FaceState: mirrored lips polygons, box, and calibrated expression
 * values (mouthOpen with fast attack / slower release and a hysteresis gate).
 */

const OUTER_LIPS = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146] as const;
const INNER_LIPS = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95] as const;
const LIP_UPPER_INNER = 13;
const LIP_LOWER_INNER = 14;
const MOUTH_LEFT = 61;
const MOUTH_RIGHT = 291;

/** After this long without a face, report null. */
const FACE_HOLD_MS = 200;

/**
 * mouthOpen calibration. jawOpen reads ~0.0-0.05 for a relaxed closed mouth and ~0.5-0.7 wide
 * open; the inner-lip gap over mouth width reads ~0-0.03 closed and ~0.5+ wide open. Each is
 * remapped to 0..1 and the two are averaged (either alone when the other is unavailable).
 */
const JAW_LO = 0.06;
const JAW_HI = 0.5;
const GAP_LO = 0.04;
const GAP_HI = 0.5;
/** Time constants (ms) of the mouthOpen envelope. */
const ATTACK_MS = 22;
const RELEASE_MS = 70;
const OPEN_ON = 0.22;
const OPEN_OFF = 0.12;

const POINTS = OUTER_LIPS.length + INNER_LIPS.length;
/** Lip points (x, y) followed by the box (x0, y0, x1, y1). */
const CHANNELS = POINTS * 2 + 4;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
const remap = (v: number, lo: number, hi: number): number => clamp01((v - lo) / (hi - lo));

const BLENDSHAPES = [
  'jawOpen',
  'mouthPucker',
  'mouthFunnel',
  'mouthSmileLeft',
  'mouthSmileRight',
  'browInnerUp',
] as const;
type Blendshape = (typeof BLENDSHAPES)[number];

function makeView(): FaceState {
  const poly = (n: number): Vec2[] => Array.from({ length: n }, () => ({ x: 0, y: 0 }));
  return {
    box: { x: 0, y: 0, w: 0, h: 0 },
    mouthOpen: 0,
    mouthIsOpen: false,
    pucker: 0,
    smile: 0,
    browUp: 0,
    outerLips: poly(OUTER_LIPS.length),
    innerLips: poly(INNER_LIPS.length),
    mouthCenter: { x: 0, y: 0 },
  };
}

export class FaceTracker {
  private readonly views: [FaceState, FaceState] = [makeView(), makeView()];
  private readonly raw = new Float32Array(CHANNELS);
  private readonly smooth = new Float32Array(CHANNELS);
  private readonly filter = new OneEuroBank(CHANNELS, { minCutoff: 1.6, beta: 10, dCutoff: 1.0 });
  /** Blendshape name -> index in the categories array, learned from the first result. */
  private readonly shapeIndex = new Map<Blendshape, number>();
  private readonly shape: Record<Blendshape, number> = {
    jawOpen: 0,
    mouthPucker: 0,
    mouthFunnel: 0,
    mouthSmileLeft: 0,
    mouthSmileRight: 0,
    browInnerUp: 0,
  };
  private present = false;
  /** The latest face-model run found no face. */
  private missed = false;
  private lastSeen = -Infinity;
  private lastT = 0;
  private mouthOpen = 0;
  private mouthIsOpen = false;
  private pucker = 0;
  private smile = 0;
  private browUp = 0;

  reset(): void {
    this.present = false;
    this.missed = false;
    this.lastSeen = -Infinity;
  }

  /**
   * @param result the face model output, or null when it did not run this frame (the last face is
   *   reused until FACE_HOLD_MS passes)
   */
  update(result: FaceLandmarkerResult | null, now: number, aspect: number, buf: 0 | 1): FaceState | null {
    if (result) {
      const lms = result.faceLandmarks[0];
      if (lms && lms.length > MOUTH_RIGHT) {
        this.ingest(lms, result.faceBlendshapes[0]?.categories, now, aspect);
        this.missed = false;
      } else {
        this.missed = true;
      }
    }
    if (!this.present) return null;
    // Only a run that found nothing can expire the face, so a slow or skipped face model never
    // blinks it out on its own.
    if (this.missed && now - this.lastSeen > FACE_HOLD_MS) {
      this.present = false;
      this.mouthOpen = 0;
      this.mouthIsOpen = false;
      return null;
    }
    return this.write(this.views[buf]);
  }

  private ingest(lms: NormalizedLandmark[], categories: Category[] | undefined, now: number, aspect: number): void {
    if (!this.present) {
      this.filter.reset();
      this.mouthOpen = 0;
      this.mouthIsOpen = false;
    }
    const dtMs = this.present ? Math.min(250, Math.max(1, now - this.lastT)) : 0;
    this.present = true;
    this.lastSeen = now;
    this.lastT = now;

    const raw = this.raw;
    let k = 0;
    for (const idx of OUTER_LIPS) {
      const p = lms[idx]!;
      raw[k++] = 1 - p.x;
      raw[k++] = p.y;
    }
    for (const idx of INNER_LIPS) {
      const p = lms[idx]!;
      raw[k++] = 1 - p.x;
      raw[k++] = p.y;
    }
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (let i = 0; i < lms.length; i++) {
      const p = lms[i]!;
      if (p.x < x0) x0 = p.x;
      if (p.x > x1) x1 = p.x;
      if (p.y < y0) y0 = p.y;
      if (p.y > y1) y1 = p.y;
    }
    raw[k++] = 1 - x1; // mirrored: the right edge becomes the left
    raw[k++] = y0;
    raw[k++] = 1 - x0;
    raw[k++] = y1;
    this.filter.filter(raw, this.smooth, now);

    // --- expression -------------------------------------------------------------------------
    const shape = this.shape;
    let haveShapes = false;
    if (categories && categories.length > 0) {
      if (this.shapeIndex.size === 0) {
        categories.forEach((c, i) => {
          if ((BLENDSHAPES as readonly string[]).includes(c.categoryName)) this.shapeIndex.set(c.categoryName as Blendshape, i);
        });
      }
      for (const name of BLENDSHAPES) {
        const i = this.shapeIndex.get(name);
        const c = i === undefined ? undefined : categories[i];
        // Guard against a model whose category order differs from the first result.
        shape[name] = c && c.categoryName === name ? c.score : 0;
      }
      haveShapes = true;
    }

    const up = lms[LIP_UPPER_INNER]!;
    const lo = lms[LIP_LOWER_INNER]!;
    const ml = lms[MOUTH_LEFT]!;
    const mr = lms[MOUTH_RIGHT]!;
    const gap = Math.hypot((up.x - lo.x) * aspect, up.y - lo.y);
    const width = Math.max(1e-4, Math.hypot((ml.x - mr.x) * aspect, ml.y - mr.y));
    const gapN = remap(gap / width, GAP_LO, GAP_HI);
    const target = haveShapes ? (remap(shape.jawOpen, JAW_LO, JAW_HI) + gapN) / 2 : gapN;

    if (dtMs === 0) {
      this.mouthOpen = target;
    } else {
      const tau = target > this.mouthOpen ? ATTACK_MS : RELEASE_MS;
      this.mouthOpen += (target - this.mouthOpen) * (1 - Math.exp(-dtMs / tau));
    }
    this.mouthIsOpen = this.mouthIsOpen ? this.mouthOpen > OPEN_OFF : this.mouthOpen > OPEN_ON;

    if (haveShapes) {
      const a = dtMs === 0 ? 1 : 1 - Math.exp(-dtMs / 60);
      this.pucker += (remap(Math.max(shape.mouthPucker, shape.mouthFunnel), 0.15, 0.75) - this.pucker) * a;
      this.smile += (remap((shape.mouthSmileLeft + shape.mouthSmileRight) / 2, 0.1, 0.7) - this.smile) * a;
      this.browUp += (remap(shape.browInnerUp, 0.1, 0.7) - this.browUp) * a;
    }
  }

  private write(v: FaceState): FaceState {
    const s = this.smooth;
    let k = 0;
    for (const p of v.outerLips) {
      p.x = s[k++]!;
      p.y = s[k++]!;
    }
    for (const p of v.innerLips) {
      p.x = s[k++]!;
      p.y = s[k++]!;
    }
    const bx0 = s[k++]!;
    const by0 = s[k++]!;
    const bx1 = s[k++]!;
    const by1 = s[k++]!;
    v.box.x = bx0;
    v.box.y = by0;
    v.box.w = bx1 - bx0;
    v.box.h = by1 - by0;
    // Center between the mouth corners, and between the inner upper and lower lip.
    const outer = v.outerLips;
    const inner = v.innerLips;
    v.mouthCenter.x = (outer[0]!.x + outer[10]!.x) / 2;
    v.mouthCenter.y = (inner[5]!.y + inner[15]!.y) / 2;
    v.mouthOpen = this.mouthOpen;
    v.mouthIsOpen = this.mouthIsOpen;
    v.pucker = this.pucker;
    v.smile = this.smile;
    v.browUp = this.browUp;
    return v;
  }
}

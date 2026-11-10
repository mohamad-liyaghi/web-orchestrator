import type { HandLandmarkerResult } from '@mediapipe/tasks-vision';
import type { HandGesture, HandSide, HandState, Vec3 } from '../types';
import { OneEuroBank, type OneEuroParams } from './oneEuro';

/**
 * Turns raw HandLandmarker results into stable, smoothed HandStates:
 *  - two slots (ids 0 and 1) matched frame to frame by wrist distance
 *  - a hand missing for less than HOLD_MS keeps being reported (no note chatter on a dropped frame)
 *  - One Euro smoothing per landmark coordinate, reset whenever a slot (re)acquires a hand
 *  - pinch / fingers / side / gesture / thumbOut with hysteresis or debouncing so they are safe
 *    as gates (chords are picked from finger patterns, so a flicker would change the chord)
 */

const LANDMARKS = 21;
const CHANNELS = LANDMARKS * 3;
const HOLD_MS = 150;
/** Max wrist travel (in frame heights) between frames for a detection to keep its slot. */
const MATCH_GATE = 0.35;
/** A finger pattern / pose must be seen this long, and in at least this many frames, before
 *  `fingers`, `fingersUp` and `gesture` change. */
const GESTURE_DEBOUNCE_MS = 120;
const GESTURE_DEBOUNCE_FRAMES = 2;

/** Tuned on normalized coordinates at 30 fps: steady at rest, no visible lag on quick moves. */
const SMOOTHING: OneEuroParams = { minCutoff: 1.4, beta: 14, dCutoff: 1.0 };

/** Thumb-index distance (in palm lengths) that maps to pinch = 1 and pinch = 0. */
const PINCH_CLOSED = 0.2;
const PINCH_OPEN = 0.9;
const PINCH_ON = 0.75;
const PINCH_OFF = 0.55;

/**
 * Finger extended when |wrist->tip| / |wrist->pip| crosses these (hysteresis). Real photos: every
 * extended finger read 1.24..1.41, every curled one 0.54..0.82, half-bent fingers ~1.05.
 */
const FINGER_UP = 1.15;
const FINGER_DOWN = 1.0;
/**
 * Thumb extended when |thumb tip -> middle MCP| / palm crosses these. Measured on real photos:
 * tucked thumbs (fist, pointing, peace, counting with the thumb holding the other fingers,
 * rock) read 0.32..0.48, extended thumbs (thumbs-up, open hands, ILY, counting from the thumb)
 * 0.84..1.35. A thumb crossing the palm stays close to the middle MCP, unlike |tip -> index MCP|.
 */
const THUMB_UP = 0.7;
const THUMB_DOWN = 0.6;

/**
 * Thumb out: extended, on the index side of the palm (a tucked thumb crosses toward the pinky and
 * also makes a wide angle), and the angle between the thumb (2->4) and the wrist -> index MCP line
 * crosses these. Real photos: relaxed open hands 9 deg, counting / ILY thumbs 21..35 deg, an
 * L-shaped "finger gun" 42 deg.
 */
const THUMB_OUT_ON = (34 * Math.PI) / 180;
const THUMB_OUT_OFF = (26 * Math.PI) / 180;
/** Minimum share of the thumb direction pointing away from the palm (pinky MCP -> index MCP). */
const THUMB_OUT_LATERAL = 0.2;
/** Time constant of the extra roll smoothing, ms. */
const ROLL_TAU_MS = 50;

/** [tip, pip] for index, middle, ring, pinky. */
const FINGERS: ReadonlyArray<readonly [number, number]> = [
  [8, 6],
  [12, 10],
  [16, 14],
  [20, 18],
];

/**
 * HANDEDNESS
 * MediaPipe documents its handedness label as assuming a mirrored (selfie) input. We feed the raw,
 * unmirrored camera frame. Verified with real photos through a fake webcam (people facing the
 * camera, see scripts/test/tracking-fakecam.mjs): with raw frames the label already names the
 * person's anatomical hand. A singer with both hands raised: her right hand (left side of the raw
 * photo) came back "Right"; two people raising their right hand for an oath came back "Right".
 * So the label is used as is, and after mirroring the right hand sits on the right of the view.
 */
const LABEL_OF_RIGHT_HAND = 'Right';

/** Distance between two landmarks in frame-height units; z is on x's scale (MediaPipe convention). */
function landmarkDist(s: ArrayLike<number>, a: number, b: number, aspect: number): number {
  const dx = (s[a * 3]! - s[b * 3]!) * aspect;
  const dy = s[a * 3 + 1]! - s[b * 3 + 1]!;
  const dz = (s[a * 3 + 2]! - s[b * 3 + 2]!) * aspect;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Rotation-independent finger extension measures from 21 landmarks packed as x,y,z triples:
 * out[0] = thumb tip to middle MCP / palm length, out[1..4] = |wrist->tip| / |wrist->pip| for
 * index..pinky. Returns the palm length (wrist to middle MCP) in frame heights.
 */
export function measureFingers(s: ArrayLike<number>, aspect: number, out: Float32Array): number {
  const palm = Math.max(1e-4, landmarkDist(s, 0, 9, aspect));
  out[0] = landmarkDist(s, 4, 9, aspect) / palm;
  for (let f = 0; f < 4; f++) {
    const [tip, pip] = FINGERS[f]!;
    out[f + 1] = landmarkDist(s, 0, tip, aspect) / Math.max(1e-4, landmarkDist(s, 0, pip, aspect));
  }
  return palm;
}

/** Angle (radians, 0..PI) between vectors a0->a1 and b0->b1 in 3D, x and z scaled by aspect. */
function landmarkAngle(s: ArrayLike<number>, a0: number, a1: number, b0: number, b1: number, aspect: number): number {
  const ax = (s[a1 * 3]! - s[a0 * 3]!) * aspect;
  const ay = s[a1 * 3 + 1]! - s[a0 * 3 + 1]!;
  const az = (s[a1 * 3 + 2]! - s[a0 * 3 + 2]!) * aspect;
  const bx = (s[b1 * 3]! - s[b0 * 3]!) * aspect;
  const by = s[b1 * 3 + 1]! - s[b0 * 3 + 1]!;
  const bz = (s[b1 * 3 + 2]! - s[b0 * 3 + 2]!) * aspect;
  const la = Math.sqrt(ax * ax + ay * ay + az * az);
  const lb = Math.sqrt(bx * bx + by * by + bz * bz);
  if (la < 1e-6 || lb < 1e-6) return 0;
  const c = (ax * bx + ay * by + az * bz) / (la * lb);
  return Math.acos(c < -1 ? -1 : c > 1 ? 1 : c);
}

/**
 * How much the thumb (2->4) points away from the palm, -1..1: its component along the pinky MCP ->
 * index MCP axis, taken perpendicular to the wrist -> middle MCP axis.
 */
export function thumbLateral(s: ArrayLike<number>, aspect: number): number {
  const ux = (s[27]! - s[0]!) * aspect;
  const uy = s[28]! - s[1]!;
  const uz = (s[29]! - s[2]!) * aspect;
  const ul = Math.sqrt(ux * ux + uy * uy + uz * uz) || 1;
  let lx = (s[15]! - s[51]!) * aspect;
  let ly = s[16]! - s[52]!;
  let lz = (s[17]! - s[53]!) * aspect;
  const along = (lx * ux + ly * uy + lz * uz) / (ul * ul);
  lx -= along * ux;
  ly -= along * uy;
  lz -= along * uz;
  const ll = Math.sqrt(lx * lx + ly * ly + lz * lz) || 1;
  const tx = (s[12]! - s[6]!) * aspect;
  const ty = s[13]! - s[7]!;
  const tz = (s[14]! - s[8]!) * aspect;
  const tl = Math.sqrt(tx * tx + ty * ty + tz * tz) || 1;
  return (tx * lx + ty * ly + tz * lz) / (tl * ll);
}

/** Thumb angle used for thumbOut (exported for the debug harness). */
export function thumbAngle(s: ArrayLike<number>, aspect: number): number {
  return landmarkAngle(s, 2, 4, 0, 5, aspect);
}

const GESTURES: readonly HandGesture[] = ['none', 'open', 'fist', 'point', 'peace', 'thumbs-up', 'rock'];

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

function makeView(id: number): HandState {
  const landmarks: Vec3[] = [];
  for (let i = 0; i < LANDMARKS; i++) landmarks.push({ x: 0, y: 0, z: 0 });
  return {
    id,
    side: 'right',
    landmarks,
    box: { x: 0, y: 0, w: 0, h: 0 },
    indexTip: { x: 0, y: 0 },
    thumbTip: { x: 0, y: 0 },
    pinch: 0,
    pinching: false,
    fingersUp: 0,
    fingers: [false, false, false, false, false],
    roll: 0,
    thumbOut: false,
    gesture: 'none',
    score: 0,
    age: 0,
  };
}

class Slot {
  active = false;
  firstSeen = 0;
  lastSeen = 0;
  /** Hand-model runs in a row that did not find this hand. */
  missed = 0;
  readonly raw = new Float32Array(CHANNELS);
  readonly smooth = new Float32Array(CHANNELS);
  readonly filter = new OneEuroBank(CHANNELS, SMOOTHING);
  /** -1 (left) .. +1 (right), smoothed handedness votes. */
  sideVote = 0;
  side: HandSide = 'right';
  score = 0;
  pinch = 0;
  pinching = false;
  readonly ratios = new Float32Array(5);
  /** Per-frame extended state with hysteresis (not debounced). */
  readonly fingerUp = new Uint8Array(5);
  /** Debounced finger bitmask (bit 0 = thumb ... bit 4 = pinky) and pose. */
  fingerMask = 0;
  fingersUp = 0;
  gesture: HandGesture = 'none';
  /** Candidate pattern: finger mask | pose index << 5. */
  candidate = 0;
  candidateSince = 0;
  candidateFrames = 0;
  thumbOut = false;
  roll = 0;
  rollPrimed = false;
  lastFeatureT = 0;
  /** Smoothed landmark jitter (mean raw-vs-smoothed distance / hand height). */
  jitter = 0;
  x0 = 0;
  y0 = 0;
  x1 = 0;
  y1 = 0;
  /** Double-buffered output objects (see HandTracker.update). */
  readonly views: [HandState, HandState];

  constructor(readonly id: number) {
    this.views = [makeView(id), makeView(id)];
  }

  acquire(now: number): void {
    this.active = true;
    this.firstSeen = now;
    this.missed = 0;
    this.filter.reset();
    this.pinching = false;
    this.fingerUp.fill(0);
    this.fingerMask = 0;
    this.fingersUp = 0;
    this.gesture = 'none';
    this.candidate = 0;
    this.thumbOut = false;
    this.rollPrimed = false;
    this.candidateSince = now;
    this.candidateFrames = 0;
    this.jitter = 0;
  }

  /** Lost = not found by the latest hand-model run and not seen for HOLD_MS. Frame-rate safe. */
  expired(now: number): boolean {
    return this.missed > 0 && now - this.lastSeen > HOLD_MS;
  }
}

export class HandTracker {
  private readonly slots: [Slot, Slot] = [new Slot(0), new Slot(1)];
  private readonly lists: [HandState[], HandState[]] = [[], []];
  /** Detection index -> slot index for the current frame (-1 = none). */
  private readonly assign = new Int8Array(2);
  private readonly wx = new Float64Array(2);
  private readonly wy = new Float64Array(2);

  /** Forget every hand (camera restarted, tab came back after a long pause). */
  reset(): void {
    for (const s of this.slots) s.active = false;
  }

  /** Highest landmark jitter among the tracked hands (0 = rock steady), for the quality flag. */
  get jitter(): number {
    let j = 0;
    for (const s of this.slots) if (s.active && s.jitter > j) j = s.jitter;
    return j;
  }

  /**
   * Consumes one detection result (or null when the hand model did not run or failed) and returns
   * the hands to report, sorted by box center x. Output objects are double-buffered: `buf`
   * alternates 0/1, so the previous frame's HandStates stay intact while the new ones are written.
   * @param aspect frame width / height, to measure distances in real proportions
   */
  update(result: HandLandmarkerResult | null, now: number, aspect: number, buf: 0 | 1): HandState[] {
    const slots = this.slots;
    if (result) this.match(result, now, aspect);

    const list = this.lists[buf];
    list.length = 0;
    for (const slot of slots) {
      if (!slot.active) continue;
      if (slot.expired(now)) {
        slot.active = false;
        continue;
      }
      list.push(this.write(slot, now, buf));
    }
    if (list.length === 2) {
      const a = list[0]!;
      const b = list[1]!;
      if (a.box.x + a.box.w / 2 > b.box.x + b.box.w / 2) {
        list[0] = b;
        list[1] = a;
      }
    }
    return list;
  }

  private match(result: HandLandmarkerResult, now: number, aspect: number): void {
    const dets = result.landmarks;
    const n = Math.min(2, dets.length);
    const slots = this.slots;
    const assign = this.assign;
    assign[0] = -1;
    assign[1] = -1;
    for (let i = 0; i < n; i++) {
      const w = dets[i]![0]!;
      this.wx[i] = (1 - w.x) * aspect;
      this.wy[i] = w.y;
    }
    const live0 = slots[0].active && !slots[0].expired(now);
    const live1 = slots[1].active && !slots[1].expired(now);
    const dist = (d: number, s: Slot): number => this.wristDist(d, s, aspect);

    if (n === 1) {
      const d0 = live0 ? dist(0, slots[0]) : Infinity;
      const d1 = live1 ? dist(0, slots[1]) : Infinity;
      if (Math.min(d0, d1) < MATCH_GATE) assign[0] = d0 <= d1 ? 0 : 1;
      else if (!live0) assign[0] = 0;
      else if (!live1) assign[0] = 1;
      else assign[0] = slots[0].lastSeen <= slots[1].lastSeen ? 0 : 1; // replace the stalest
    } else if (n === 2) {
      if (live0 && live1) {
        const straight = dist(0, slots[0]) + dist(1, slots[1]);
        const crossed = dist(0, slots[1]) + dist(1, slots[0]);
        assign[0] = straight <= crossed ? 0 : 1;
        assign[1] = straight <= crossed ? 1 : 0;
      } else if (live0 || live1) {
        const keep = live0 ? 0 : 1;
        const closer = dist(0, slots[keep]) <= dist(1, slots[keep]) ? 0 : 1;
        assign[closer] = keep;
        assign[1 - closer] = 1 - keep;
      } else {
        assign[0] = 0;
        assign[1] = 1;
      }
    }

    const hit0 = assign[0] === 0 || assign[1] === 0;
    const hit1 = assign[0] === 1 || assign[1] === 1;
    if (!hit0) slots[0].missed++;
    if (!hit1) slots[1].missed++;

    for (let d = 0; d < n; d++) {
      const si = assign[d]!;
      if (si < 0) continue;
      const slot = slots[si]!;
      const live = si === 0 ? live0 : live1;
      // Too far from where this slot's hand was: it is a different hand, start fresh.
      if (!live || dist(d, slot) >= MATCH_GATE) slot.acquire(now);
      this.ingest(slot, d, result, now, aspect);
    }
  }

  /** Distance between detection `d`'s wrist and the slot's last raw wrist, in frame heights. */
  private wristDist(d: number, s: Slot, aspect: number): number {
    // raw[] is already mirrored, like wx/wy.
    const dx = this.wx[d]! - s.raw[0]! * aspect;
    const dy = this.wy[d]! - s.raw[1]!;
    return Math.sqrt(dx * dx + dy * dy);
  }

  private ingest(slot: Slot, d: number, result: HandLandmarkerResult, now: number, aspect: number): void {
    const lms = result.landmarks[d]!;
    const raw = slot.raw;
    for (let i = 0; i < LANDMARKS; i++) {
      const p = lms[i];
      if (!p) continue;
      raw[i * 3] = 1 - p.x; // mirror for the selfie view
      raw[i * 3 + 1] = p.y;
      raw[i * 3 + 2] = p.z;
    }
    slot.filter.filter(raw, slot.smooth, now);
    slot.lastSeen = now;
    slot.missed = 0;

    const cat = result.handedness[d]?.[0];
    slot.score = cat?.score ?? 0;
    if (cat) {
      const vote = cat.categoryName === LABEL_OF_RIGHT_HAND ? 1 : -1;
      if (now === slot.firstSeen) {
        slot.sideVote = vote;
        slot.side = vote > 0 ? 'right' : 'left';
      } else {
        // A single misclassified frame must not swap the instrument a hand plays.
        slot.sideVote += (vote - slot.sideVote) * 0.25;
        if (slot.sideVote > 0.3) slot.side = 'right';
        else if (slot.sideVote < -0.3) slot.side = 'left';
      }
    }
    this.features(slot, now, aspect);
  }

  private features(slot: Slot, now: number, aspect: number): void {
    const s = slot.smooth;
    const ratios = slot.ratios;
    const palm = measureFingers(s, aspect, ratios);

    const pinchRatio = landmarkDist(s, 4, 8, aspect) / palm;
    slot.pinch = clamp01((PINCH_OPEN - pinchRatio) / (PINCH_OPEN - PINCH_CLOSED));
    if (slot.pinching) slot.pinching = slot.pinch > PINCH_OFF;
    else slot.pinching = slot.pinch > PINCH_ON;

    // Fingers: tip farther from the wrist than the PIP joint = extended. Works at any hand angle.
    const up = slot.fingerUp;
    const thumb = ratios[0]!;
    up[0] = up[0] ? (thumb > THUMB_DOWN ? 1 : 0) : thumb > THUMB_UP ? 1 : 0;
    for (let i = 1; i < 5; i++) {
      const r = ratios[i]!;
      up[i] = up[i] ? (r > FINGER_DOWN ? 1 : 0) : r > FINGER_UP ? 1 : 0;
    }

    // Thumb out (3D, so it works with the palm or the back of the hand toward the camera).
    const angle = landmarkAngle(s, 2, 4, 0, 5, aspect);
    const outward = up[0] === 1 && thumbLateral(s, aspect) > THUMB_OUT_LATERAL;
    slot.thumbOut = outward && (slot.thumbOut ? angle > THUMB_OUT_OFF : angle > THUMB_OUT_ON);

    // Roll: wrist -> middle MCP on screen (mirrored, aspect-corrected). 0 = up, + = clockwise.
    const rx = (s[9 * 3]! - s[0]!) * aspect;
    const ry = s[9 * 3 + 1]! - s[1]!;
    const roll = Math.atan2(rx, -ry);
    if (!slot.rollPrimed) {
      slot.roll = roll;
      slot.rollPrimed = true;
    } else {
      let d = roll - slot.roll;
      if (d > Math.PI) d -= 2 * Math.PI;
      else if (d < -Math.PI) d += 2 * Math.PI;
      const dt = Math.max(0, now - slot.lastFeatureT);
      slot.roll += d * (1 - Math.exp(-dt / ROLL_TAU_MS));
      if (slot.roll > Math.PI) slot.roll -= 2 * Math.PI;
      else if (slot.roll < -Math.PI) slot.roll += 2 * Math.PI;
    }
    slot.lastFeatureT = now;

    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let residual = 0;
    const raw = slot.raw;
    for (let i = 0; i < LANDMARKS; i++) {
      const x = s[i * 3]!;
      const y = s[i * 3 + 1]!;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      residual += Math.hypot((raw[i * 3]! - x) * aspect, raw[i * 3 + 1]! - y);
    }
    slot.x0 = x0;
    slot.y0 = y0;
    slot.x1 = x1;
    slot.y1 = y1;
    const jitter = residual / LANDMARKS / Math.max(0.02, y1 - y0);
    slot.jitter += (jitter - slot.jitter) * 0.15;

    // Gesture: classify this frame, commit once the same pose held GESTURE_DEBOUNCE_MS.
    // Fingers + gesture: commit the pattern once it held GESTURE_DEBOUNCE_MS and 2 frames.
    const pose = classify(up, s, palm, aspect);
    const mask = up[0]! | (up[1]! << 1) | (up[2]! << 2) | (up[3]! << 3) | (up[4]! << 4);
    const key = mask | (GESTURES.indexOf(pose) << 5);
    if (key !== slot.candidate) {
      slot.candidate = key;
      slot.candidateSince = now;
      slot.candidateFrames = 0;
    }
    slot.candidateFrames++;
    const committed = slot.fingerMask | (GESTURES.indexOf(slot.gesture) << 5);
    if (key !== committed && now - slot.candidateSince >= GESTURE_DEBOUNCE_MS && slot.candidateFrames >= GESTURE_DEBOUNCE_FRAMES) {
      slot.fingerMask = mask;
      slot.gesture = pose;
      slot.fingersUp = up[0]! + up[1]! + up[2]! + up[3]! + up[4]!;
    }
  }

  private write(slot: Slot, now: number, buf: 0 | 1): HandState {
    const v = slot.views[buf];
    const s = slot.smooth;
    const lms = v.landmarks;
    for (let i = 0; i < LANDMARKS; i++) {
      const p = lms[i]!;
      p.x = s[i * 3]!;
      p.y = s[i * 3 + 1]!;
      p.z = s[i * 3 + 2]!;
    }
    v.side = slot.side;
    v.box.x = slot.x0;
    v.box.y = slot.y0;
    v.box.w = slot.x1 - slot.x0;
    v.box.h = slot.y1 - slot.y0;
    v.indexTip.x = s[8 * 3]!;
    v.indexTip.y = s[8 * 3 + 1]!;
    v.thumbTip.x = s[4 * 3]!;
    v.thumbTip.y = s[4 * 3 + 1]!;
    v.pinch = slot.pinch;
    v.pinching = slot.pinching;
    v.fingersUp = slot.fingersUp;
    const f = v.fingers;
    for (let i = 0; i < 5; i++) f[i] = (slot.fingerMask & (1 << i)) !== 0;
    v.roll = slot.roll;
    v.thumbOut = slot.thumbOut;
    v.gesture = slot.gesture;
    v.score = slot.score;
    v.age = now - slot.firstSeen;
    return v;
  }
}

/** MCP and PIP joints of the four fingers: the thumbs-up tip must be above all of them. */
const KNUCKLES = [5, 9, 13, 17, 6, 10, 14, 18] as const;

/**
 * One frame's pose from the extended-finger bits [thumb, index, middle, ring, pinky].
 * The thumb is ignored for point / peace / rock (people hold it either way); thumbs-up needs the
 * thumb alone AND pointing up: its tip clearly above every other knuckle and its last segment
 * pointing upward in the image.
 */
function classify(up: Uint8Array, s: Float32Array, palm: number, aspect: number): HandGesture {
  const t = up[0]!;
  const i = up[1]!;
  const m = up[2]!;
  const r = up[3]!;
  const p = up[4]!;
  if (t && i && m && r && p) return 'open';
  if (i && !m && !r && !p) return 'point';
  if (i && m && !r && !p) return 'peace';
  if (i && !m && !r && p) return 'rock';
  if (!i && !m && !r && !p) {
    if (!t) return 'fist';
    const tipY = s[4 * 3 + 1]!;
    let knuckles = Infinity;
    for (const k of KNUCKLES) knuckles = Math.min(knuckles, s[k * 3 + 1]!);
    const dx = (s[4 * 3]! - s[2 * 3]!) * aspect;
    const dy = tipY - s[2 * 3 + 1]!; // < 0 = upward in the image
    const pointsUp = dy < 0 && -dy > Math.abs(dx);
    return pointsUp && tipY < knuckles - 0.25 * palm ? 'thumbs-up' : 'none';
  }
  return 'none';
}

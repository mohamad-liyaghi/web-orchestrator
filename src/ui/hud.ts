import type { HandState, InstrumentDef, Lane, LearnState, Settings, StageRenderData, VoiceState } from '../types';
import { GESTURE_GLYPH } from '../gestures';
import { mouthThresholds } from '../settings';
import { HAND_CONNECTIONS } from './illustrations';
import { prefersReducedMotion } from './dom';

/**
 * Canvas 2D overlay: hand brackets + label chips, fingertip reticles, skeleton, face box, lips,
 * mouth meter, note lanes and a pooled particle trail.
 *
 * Budget: < 4 ms per frame on a laptop. No per-frame allocations in the draw path: per-hand
 * state lives in two fixed slots, labels are rebuilt and measured only when their text changes,
 * glow sprites and lane layers are cached, particles live in typed arrays.
 */

const NEUTRAL = '#3cf2ff';
const IDLE = '#9aa6c8';
const WHITE = '#eef1ff';
const FONT_CHIP = '600 11px "JetBrains Mono Variable", "JetBrains Mono", ui-monospace, monospace';
const FONT_LANE = '500 10.5px "JetBrains Mono Variable", "JetBrains Mono", ui-monospace, monospace';
const FONT_LANE_ON = '700 12px "JetBrains Mono Variable", "JetBrains Mono", ui-monospace, monospace';
const FONT_GLYPH = '13px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
const FONT_GLYPH_BIG = '16px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
const FONT_TAG = '700 10px "JetBrains Mono Variable", "JetBrains Mono", ui-monospace, monospace';
/** Learn mode target colour: not used by the hand roles, so the lane to hit never reads as "playing". */
const TARGET = '#b6ff5c';
const TARGET_DASH: number[] = [10, 8];
const MAX_PARTICLES = 160;
const MAX_SPRITES = 48;

type Role = 'lead' | 'bass' | 'chords' | 'volume' | 'degree' | 'style' | 'idle';

interface Slot {
  seen: boolean;
  alpha: number;
  x: number;
  y: number;
  w: number;
  h: number;
  tipX: number;
  tipY: number;
  init: boolean;
  role: Role;
  color: string;
  gate: boolean;
  velocity: number;
  /** ms since the last onset, large = no pulse */
  pulse: number;
  gauge: number;
  // label cache: the parts the label was last built from
  lk: { role: Role | ''; inst: string; note: string; pct: number; glyph: string; left: string };
  dirty: boolean;
  roleText: string;
  restText: string;
  roleW: number;
  restW: number;
  glyph: string;
  glyphW: number;
  /** Gesture hold progress 0..1 (smoothed), for the ring. */
  hold: number;
  holdGlyph: string;
  /** Smoothed wrist roll (radians) for the tilt arc. */
  roll: number;
  borrowed: boolean;
}

const makeSlot = (): Slot => ({
  seen: false,
  alpha: 0,
  x: 0,
  y: 0,
  w: 0,
  h: 0,
  tipX: 0,
  tipY: 0,
  init: false,
  role: 'idle',
  color: NEUTRAL,
  gate: false,
  velocity: 0,
  pulse: 1e9,
  gauge: 0,
  lk: { role: '', inst: '', note: '', pct: -1, glyph: '', left: '' },
  dirty: true,
  roleText: '',
  restText: '',
  roleW: 0,
  restW: 0,
  glyph: '',
  glyphW: 0,
  hold: 0,
  holdGlyph: '',
  roll: 0,
  borrowed: false,
});

/** Frame-rate independent exponential smoothing factor. */
const ease = (dt: number, tau: number): number => 1 - Math.exp(-dt / tau);

function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return [60, 242, 255];
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export interface HudStats {
  drawMs: number;
  frameMs: number;
  degraded: boolean;
}

export class HudRenderer {
  private readonly ctx: CanvasRenderingContext2D;
  private w = 0;
  private h = 0;
  private dpr = 1;
  private lowPower = false;
  private degraded = false;
  private slowFor = 0;
  private warmup = 0;
  private fastFor = 0;
  private lastNow = 0;
  private readonly slots: [Slot, Slot] = [makeSlot(), makeSlot()];
  private readonly face = { seen: false, alpha: 0, x: 0, y: 0, w: 0, h: 0, init: false, noFaceMs: 0 };
  private lanesAlpha = 0;
  private tilt = false;
  /** Learn mode: screen y / height of the target lane (NaN = none) and the last hit time. */
  private targetY = Number.NaN;
  private targetH = 0;
  private targetHitT = 0;
  private learnNow = 0;
  private targetNote = '';
  private targetNoteW = 0;
  /** prefers-reduced-motion: no particle trail, no expanding pulse rings. */
  private readonly reduced = prefersReducedMotion();
  private sprites = new Map<string, HTMLCanvasElement>();
  private bandGrads = new Map<string, CanvasGradient>();
  private laneLayer: HTMLCanvasElement | null = null;
  private laneKey = '';
  // particles
  private readonly px = new Float32Array(MAX_PARTICLES);
  private readonly py = new Float32Array(MAX_PARTICLES);
  private readonly pvx = new Float32Array(MAX_PARTICLES);
  private readonly pvy = new Float32Array(MAX_PARTICLES);
  private readonly plife = new Float32Array(MAX_PARTICLES);
  private readonly psize = new Float32Array(MAX_PARTICLES);
  private pNext = 0;
  private emitAcc = 0;
  private particleColor = NEUTRAL;
  readonly stats: HudStats = { drawMs: 0, frameMs: 16.7, degraded: false };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly instruments: Map<string, InstrumentDef>,
  ) {
    const ctx = canvas.getContext('2d', { alpha: true, desynchronized: true });
    if (!ctx) throw new Error('2D canvas is not available');
    this.ctx = ctx;
  }

  /** CSS pixel size of the viewport. */
  resize(w: number, h: number): void {
    this.w = Math.max(1, Math.round(w));
    this.h = Math.max(1, Math.round(h));
    this.applyDpr();
  }

  setLowPower(on: boolean): void {
    if (on === this.lowPower) return;
    this.lowPower = on;
    this.applyDpr();
  }

  /** Fonts finished loading: label widths must be measured again. */
  invalidateText(): void {
    for (const s of this.slots) s.dirty = true;
    this.targetNote = '';
    this.laneKey = '';
  }

  get noFaceMs(): number {
    return this.face.noFaceMs;
  }

  destroy(): void {
    this.sprites.clear();
    this.bandGrads.clear();
    this.laneLayer = null;
    this.canvas.width = 1;
    this.canvas.height = 1;
  }

  private applyDpr(): void {
    const cap = this.lowPower || this.degraded ? 1 : 2;
    this.dpr = Math.min(cap, window.devicePixelRatio || 1);
    const cw = Math.round(this.w * this.dpr);
    const ch = Math.round(this.h * this.dpr);
    if (this.canvas.width !== cw) this.canvas.width = cw;
    if (this.canvas.height !== ch) this.canvas.height = ch;
    this.laneKey = '';
    this.bandGrads.clear();
  }

  // -------------------------------------------------------------------------------------------

  draw(data: StageRenderData, settings: Settings, now: number): void {
    const t0 = performance.now();
    const dt = this.lastNow ? Math.min(100, Math.max(1, now - this.lastNow)) : 16.7;
    this.lastNow = now;
    this.trackPerf(dt);

    const ctx = this.ctx;
    const { w, h } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    const frame = data.frame;
    const vw = frame?.video.width || 1280;
    const vh = frame?.video.height || 720;
    const scale = Math.max(w / vw, h / vh);
    const sx = vw * scale;
    const sy = vh * scale;
    const ox = (w - sx) / 2;
    const oy = (h - sy) / 2;

    const fancy = !this.lowPower && !this.degraded && !this.reduced;
    let lead: VoiceState | null = null;
    let bass: VoiceState | null = null;
    for (const v of data.voices) {
      if (v.voice === 'lead') lead = v;
      else if (v.voice === 'bass') bass = v;
    }
    const leadColor = this.instColor(lead?.instrument ?? settings.lead);
    const bassColor = this.instColor(bass?.instrument ?? settings.bass);
    const hands = frame?.hands ?? EMPTY_HANDS;

    // ---- lanes --------------------------------------------------------------------------
    this.lanesAlpha += ((hands.length ? 1 : 0.28) - this.lanesAlpha) * ease(dt, 220);
    const chordsMode = settings.mode === 'chords';
    this.tilt = chordsMode && settings.tiltControls;
    if (settings.lanes && !chordsMode && this.lanesAlpha > 0.01) {
      this.drawLanes(data.lanes.lead, data.lanes.bass, settings, sy, oy, lead, bass, leadColor, bassColor);
    }
    this.drawLearnTarget(data.learn ?? null, data.lanes.lead, chordsMode, sy, oy, now);

    // ---- hands --------------------------------------------------------------------------
    for (const s of this.slots) s.seen = false;
    for (let i = 0; i < hands.length; i++) {
      const hand = hands[i]!;
      const slot = this.slots[hand.id & 1]!;
      slot.seen = true;
      // Chords mode: the engine says which hand picks the degree and which shapes the chord;
      // before it has, assume the left (or only) hand picks and the right hand shapes.
      const m = data.metrics;
      const chordRole: Role | null = !chordsMode
        ? null
        : m.styleHandId === hand.id
          ? 'style'
          : m.degreeHandId === hand.id
            ? 'degree'
            : hands.length === 2 && i === 1
              ? 'style'
              : 'degree';
      this.updateSlot(slot, hand, dt, sx, sy, ox, oy, data, settings, lead, bass, leadColor, bassColor, chordRole);
      const pend = data.pendingGesture;
      const target = pend && pend.handId === hand.id ? pend.progress : 0;
      if (pend && pend.handId === hand.id) slot.holdGlyph = GESTURE_GLYPH[pend.gesture];
      // Rise quickly with the hold, drop fast when it fires or is released.
      slot.hold = target >= slot.hold ? target : Math.max(target, slot.hold - dt / 120);
      if (settings.skeleton) this.drawSkeleton(hand, slot, sx, sy, ox, oy);
    }
    for (const slot of this.slots) {
      if (!slot.seen) {
        slot.alpha -= dt / 180;
        if (slot.alpha <= 0) {
          slot.alpha = 0;
          slot.init = false;
        }
      }
      if (slot.alpha > 0.01) this.drawHandHud(slot, dt, fancy);
    }
    // Pinch mode: a link between thumb and index of the lead hand.
    if (settings.trigger === 'pinch' && lead?.handId !== null && lead?.handId !== undefined) {
      for (const hand of hands) if (hand.id === lead.handId) this.drawPinch(hand, sx, sy, ox, oy, leadColor);
    }

    // ---- particles ----------------------------------------------------------------------
    if (fancy) {
      const leadSlot = chordsMode ? this.degreeSlot() : lead && lead.handId !== null ? this.slots[lead.handId & 1]! : null;
      if (lead && lead.gate && leadSlot && leadSlot.seen) {
        this.emitAcc += (dt / 1000) * (24 + 70 * lead.velocity);
        this.particleColor = leadColor;
        while (this.emitAcc >= 1) {
          this.emitAcc -= 1;
          this.emit(leadSlot.tipX, leadSlot.tipY);
        }
      } else {
        this.emitAcc = 0;
      }
      this.drawParticles(dt);
    }

    // ---- face ---------------------------------------------------------------------------
    this.drawFace(data, settings, dt, sx, sy, ox, oy, lead, leadColor);

    this.stats.drawMs += (performance.now() - t0 - this.stats.drawMs) * 0.05;
  }

  // -------------------------------------------------------------------------------------------

  private trackPerf(dt: number): void {
    const st = this.stats;
    // Ignore the first seconds: page load, font loading and model warm-up make frames slow.
    if (this.warmup < 3000) {
      this.warmup += dt;
      return;
    }
    st.frameMs += (dt - st.frameMs) * 0.05;
    // Degrade when frames stay slow (< ~36 fps for 2.5 s) or our own drawing gets heavy; recover slowly.
    if (st.frameMs > 28 || st.drawMs > 5) {
      this.slowFor += dt;
      this.fastFor = 0;
    } else if (st.frameMs < 19 && st.drawMs < 2.5) {
      this.fastFor += dt;
      this.slowFor = 0;
    } else {
      this.slowFor = Math.max(0, this.slowFor - dt);
    }
    if (!this.degraded && this.slowFor > 2500) {
      this.degraded = true;
      st.degraded = true;
      this.applyDpr();
    } else if (this.degraded && this.fastFor > 8000) {
      this.degraded = false;
      st.degraded = false;
      this.fastFor = 0;
      this.applyDpr();
    }
  }

  private instColor(id: string): string {
    return this.instruments.get(id)?.color ?? NEUTRAL;
  }

  private sprite(color: string): HTMLCanvasElement {
    let s = this.sprites.get(color);
    if (s) return s;
    if (this.sprites.size >= MAX_SPRITES) this.sprites.clear();
    s = document.createElement('canvas');
    s.width = s.height = 64;
    const c = s.getContext('2d')!;
    const [r, g, b] = hexToRgb(color);
    const grad = c.createRadialGradient(32, 32, 0, 32, 32, 32);
    grad.addColorStop(0, `rgba(${r},${g},${b},0.95)`);
    grad.addColorStop(0.25, `rgba(${r},${g},${b},0.45)`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    c.fillStyle = grad;
    c.fillRect(0, 0, 64, 64);
    this.sprites.set(color, s);
    return s;
  }

  private bandGradient(color: string, fromRight: boolean): CanvasGradient {
    const key = color + (fromRight ? 'r' : 'l');
    let g = this.bandGrads.get(key);
    if (g) return g;
    if (this.bandGrads.size >= MAX_SPRITES) this.bandGrads.clear();
    const [r, gg, b] = hexToRgb(color);
    g = this.ctx.createLinearGradient(fromRight ? 0 : this.w, 0, fromRight ? this.w : 0, 0);
    g.addColorStop(0, `rgba(${r},${gg},${b},0)`);
    g.addColorStop(0.6, `rgba(${r},${gg},${b},0.10)`);
    g.addColorStop(1, `rgba(${r},${gg},${b},0.30)`);
    this.bandGrads.set(key, g);
    return g;
  }

  // ---- lanes ----------------------------------------------------------------------------

  private drawLanes(
    leadLanes: readonly Lane[],
    bassLanes: readonly Lane[],
    settings: Settings,
    sy: number,
    oy: number,
    lead: VoiceState | null,
    bass: VoiceState | null,
    leadColor: string,
    bassColor: string,
  ): void {
    const ctx = this.ctx;
    const showBass = settings.leftHand === 'bass';
    const key = laneSig(leadLanes) + '|' + (showBass ? laneSig(bassLanes) : '') + `|${this.w}x${this.h}@${this.dpr}|${sy.toFixed(1)}|${oy.toFixed(1)}`;
    if (key !== this.laneKey || !this.laneLayer) {
      this.laneKey = key;
      this.renderLaneLayer(leadLanes, showBass ? bassLanes : EMPTY_LANES, sy, oy);
    }
    ctx.globalAlpha = this.lanesAlpha;
    ctx.drawImage(this.laneLayer!, 0, 0, this.w, this.h);

    // Active lanes, lit with the instrument color.
    if (lead && lead.laneIndex >= 0) {
      const lane = leadLanes[lead.laneIndex];
      if (lane) this.drawActiveLane(lane, sy, oy, leadColor, true, lead.gate);
    }
    if (showBass && bass && bass.laneIndex >= 0) {
      const lane = bassLanes[bass.laneIndex];
      if (lane) this.drawActiveLane(lane, sy, oy, bassColor, false, bass.gate);
    }
    ctx.globalAlpha = 1;
  }

  private drawActiveLane(lane: Lane, sy: number, oy: number, color: string, right: boolean, gate: boolean): void {
    const ctx = this.ctx;
    const y = lane.y * sy + oy;
    const hh = Math.max(10, lane.h * sy);
    const a = this.lanesAlpha * (gate ? 1 : 0.5);
    ctx.globalAlpha = a;
    ctx.fillStyle = this.bandGradient(color, right);
    ctx.fillRect(0, y - hh / 2, this.w, hh);
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.globalAlpha = a * 0.8;
    ctx.beginPath();
    if (right) {
      ctx.moveTo(this.w * 0.35, y);
      ctx.lineTo(this.w - 46, y);
    } else {
      ctx.moveTo(46, y);
      ctx.lineTo(this.w * 0.65, y);
    }
    ctx.stroke();
    ctx.globalAlpha = a;
    ctx.font = FONT_LANE_ON;
    ctx.fillStyle = color;
    ctx.textBaseline = 'middle';
    ctx.textAlign = right ? 'right' : 'left';
    ctx.fillText(lane.note, right ? this.w - 12 : 12, y);
  }

  private renderLaneLayer(lead: readonly Lane[], bass: readonly Lane[], sy: number, oy: number): void {
    const layer = this.laneLayer ?? document.createElement('canvas');
    this.laneLayer = layer;
    layer.width = this.canvas.width;
    layer.height = this.canvas.height;
    const c = layer.getContext('2d')!;
    c.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    c.clearRect(0, 0, this.w, this.h);
    c.textBaseline = 'middle';
    c.font = FONT_LANE;
    c.textAlign = 'right';
    for (const lane of lead) {
      const y = Math.round(lane.y * sy + oy) + 0.5;
      c.strokeStyle = lane.isRoot ? 'rgba(220,230,255,0.22)' : 'rgba(200,215,255,0.085)';
      c.lineWidth = 1;
      c.setLineDash(lane.isRoot ? EMPTY_DASH : DASH);
      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(this.w - 44, y);
      c.stroke();
      c.fillStyle = lane.isRoot ? 'rgba(238,241,255,0.85)' : 'rgba(208,216,255,0.42)';
      c.fillText(lane.note, this.w - 12, y);
    }
    c.setLineDash(EMPTY_DASH);
    c.textAlign = 'left';
    for (const lane of bass) {
      const y = Math.round(lane.y * sy + oy) + 0.5;
      c.strokeStyle = lane.isRoot ? 'rgba(255,170,190,0.45)' : 'rgba(255,170,190,0.2)';
      c.beginPath();
      c.moveTo(0, y);
      c.lineTo(lane.isRoot ? 40 : 30, y);
      c.stroke();
      c.fillStyle = lane.isRoot ? 'rgba(255,214,224,0.85)' : 'rgba(255,200,214,0.45)';
      c.fillText(lane.note, 44, y);
    }
  }

  // ---- hands ----------------------------------------------------------------------------

  private updateSlot(
    slot: Slot,
    hand: HandState,
    dt: number,
    sx: number,
    sy: number,
    ox: number,
    oy: number,
    data: StageRenderData,
    settings: Settings,
    lead: VoiceState | null,
    bass: VoiceState | null,
    leadColor: string,
    bassColor: string,
    chordRole: Role | null,
  ): void {
    // Role + color
    let role: Role = 'idle';
    let voice: VoiceState | null = null;
    if (chordRole) {
      role = chordRole;
      voice = chordRole === 'degree' ? lead : null;
    } else if (lead && lead.handId === hand.id) {
      role = 'lead';
      voice = lead;
    } else if (data.metrics.volumeHandId === hand.id) role = 'volume';
    else if (bass && bass.handId === hand.id) {
      role = settings.leftHand === 'chords' ? 'chords' : 'bass';
      voice = bass;
    }
    slot.role = role;
    slot.color =
      role === 'lead' || role === 'degree'
        ? leadColor
        : role === 'bass' || role === 'chords'
          ? bassColor
          : role === 'volume' || role === 'style'
            ? NEUTRAL
            : IDLE;
    slot.roll += (hand.roll - slot.roll) * ease(dt, 80);
    slot.borrowed = role === 'degree' && data.metrics.borrowed;
    slot.gate = !!voice?.gate;
    slot.velocity = voice?.velocity ?? 0;
    if (voice?.onset) slot.pulse = 0;
    else slot.pulse += dt;
    slot.gauge += ((role === 'volume' || role === 'style' ? data.metrics.handVolume : 0) - slot.gauge) * ease(dt, 60);

    // Screen-space box, padded ~12%, smoothed.
    const b = hand.box;
    const bw = b.w * sx;
    const bh = b.h * sy;
    const pad = Math.max(bw, bh) * 0.12 + 6;
    const tx = b.x * sx + ox - pad;
    const ty = b.y * sy + oy - pad;
    const tw = bw + pad * 2;
    const th = bh + pad * 2;
    const tipX = hand.indexTip.x * sx + ox;
    const tipY = hand.indexTip.y * sy + oy;
    if (!slot.init) {
      // Enter slightly enlarged, then settle.
      slot.x = tx - tw * 0.1;
      slot.y = ty - th * 0.1;
      slot.w = tw * 1.2;
      slot.h = th * 1.2;
      slot.tipX = tipX;
      slot.tipY = tipY;
      slot.init = true;
    } else {
      const k = ease(dt, 55);
      slot.x += (tx - slot.x) * k;
      slot.y += (ty - slot.y) * k;
      slot.w += (tw - slot.w) * k;
      slot.h += (th - slot.h) * k;
      const kt = ease(dt, 22);
      slot.tipX += (tipX - slot.tipX) * kt;
      slot.tipY += (tipY - slot.tipY) * kt;
    }
    slot.alpha = Math.min(1, Math.min(slot.alpha + dt / 160, hand.age / 250));

    // Label: compare the parts, rebuild + measure only when one changed (no per-frame strings).
    const g = hand.gesture;
    const glyph = g === 'fist' || g === 'peace' || g === 'thumbs-up' || g === 'rock' ? GESTURE_GLYPH[g] : '';
    const m = data.metrics;
    const inst = voice ? voice.instrument : '';
    const note = role === 'degree' ? m.roman : role === 'style' ? m.chordStyle : voice ? voice.note : '';
    const pct = role === 'volume' || role === 'style' ? Math.round(m.handVolume * 100) : role === 'degree' ? (m.borrowed ? 1 : 0) : -1;
    const lk = slot.lk;
    if (lk.role === role && lk.inst === inst && lk.note === note && lk.pct === pct && lk.glyph === glyph && lk.left === settings.leftHand && !slot.dirty) return;
    lk.role = role;
    lk.inst = inst;
    lk.note = note;
    lk.pct = pct;
    lk.glyph = glyph;
    lk.left = settings.leftHand;
    slot.dirty = false;
    let roleText: string;
    let rest: string;
    if (role === 'lead' || role === 'bass') {
      const name = this.instruments.get(inst)?.name ?? inst;
      roleText = role === 'lead' ? 'LEAD' : 'BASS';
      rest = note ? ` · ${name} · ${note}` : ` · ${name}`;
    } else if (role === 'chords') {
      roleText = 'CHORDS';
      rest = ` · ${note || '—'}`;
    } else if (role === 'volume') {
      roleText = 'VOLUME';
      rest = ` ${pct}%`;
    } else if (role === 'degree') {
      roleText = 'CHORD';
      rest = ` · ${note || '—'}${pct === 1 ? ' · borrowed' : ''}`;
    } else if (role === 'style') {
      roleText = 'STYLE';
      rest = ` · ${note || '—'} · VOL ${pct}%`;
    } else {
      roleText = settings.leftHand === 'off' ? 'LEFT HAND' : 'HAND';
      rest = settings.leftHand === 'off' ? ' · off' : '';
    }
    slot.glyph = glyph;
    slot.roleText = roleText;
    slot.restText = rest;
    this.ctx.font = FONT_CHIP;
    slot.roleW = this.ctx.measureText(roleText).width;
    slot.restW = rest ? this.ctx.measureText(rest).width : 0;
    this.ctx.font = FONT_GLYPH;
    slot.glyphW = glyph ? this.ctx.measureText(glyph).width + 8 : 0;
  }

  private drawSkeleton(hand: HandState, slot: Slot, sx: number, sy: number, ox: number, oy: number): void {
    const ctx = this.ctx;
    const lm = hand.landmarks;
    if (lm.length < 21) return;
    ctx.globalAlpha = slot.alpha * 0.55;
    ctx.strokeStyle = slot.color;
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (const [a, b] of HAND_CONNECTIONS) {
      const p = lm[a]!;
      const q = lm[b]!;
      ctx.moveTo(p.x * sx + ox, p.y * sy + oy);
      ctx.lineTo(q.x * sx + ox, q.y * sy + oy);
    }
    ctx.stroke();
    ctx.globalAlpha = slot.alpha * 0.85;
    ctx.fillStyle = WHITE;
    ctx.beginPath();
    for (let i = 0; i < 21; i++) {
      const p = lm[i]!;
      const x = p.x * sx + ox;
      const y = p.y * sy + oy;
      const r = i === 4 || i === 8 ? 0 : i % 4 === 0 ? 2.6 : 1.9;
      if (!r) continue;
      ctx.moveTo(x + r, y);
      ctx.arc(x, y, r, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  private drawPinch(hand: HandState, sx: number, sy: number, ox: number, oy: number, color: string): void {
    const ctx = this.ctx;
    const ax = hand.thumbTip.x * sx + ox;
    const ay = hand.thumbTip.y * sy + oy;
    const bx = hand.indexTip.x * sx + ox;
    const by = hand.indexTip.y * sy + oy;
    ctx.globalAlpha = 0.35 + 0.65 * hand.pinch;
    ctx.strokeStyle = hand.pinching ? color : WHITE;
    ctx.lineWidth = hand.pinching ? 2.5 : 1.25;
    ctx.setLineDash(hand.pinching ? EMPTY_DASH : DASH);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.lineTo(bx, by);
    ctx.stroke();
    ctx.setLineDash(EMPTY_DASH);
    ctx.beginPath();
    ctx.arc(ax, ay, 4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  private drawHandHud(slot: Slot, dt: number, fancy: boolean): void {
    void dt;
    const ctx = this.ctx;
    const { x, y, w, h, alpha, color } = slot;
    const pulse = !this.reduced && slot.pulse < 420 ? 1 - slot.pulse / 420 : 0;
    const len = Math.max(12, Math.min(40, Math.min(w, h) * 0.22)) * (1 + pulse * 0.25);

    // Faint full frame + bright corner brackets.
    ctx.globalAlpha = alpha * 0.16;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(x) + 0.5, Math.round(y) + 0.5, Math.round(w), Math.round(h));
    ctx.globalAlpha = alpha * (slot.gate ? 1 : 0.85);
    ctx.lineWidth = slot.gate ? 2.75 : 2.25;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(x, y + len);
    ctx.lineTo(x, y);
    ctx.lineTo(x + len, y);
    ctx.moveTo(x + w - len, y);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w, y + len);
    ctx.moveTo(x + w, y + h - len);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x + w - len, y + h);
    ctx.moveTo(x + len, y + h);
    ctx.lineTo(x, y + h);
    ctx.lineTo(x, y + h - len);
    ctx.stroke();

    // Tiny tick marks at the edge centers.
    ctx.lineWidth = 1;
    ctx.globalAlpha = alpha * 0.5;
    ctx.beginPath();
    ctx.moveTo(x + w / 2, y - 4);
    ctx.lineTo(x + w / 2, y + 3);
    ctx.moveTo(x + w / 2, y + h - 3);
    ctx.lineTo(x + w / 2, y + h + 4);
    ctx.stroke();

    // Label chip above the box (below it when the box touches the top).
    const chipH = 22;
    const chipW = slot.roleW + slot.restW + slot.glyphW + 18;
    let cx = x;
    let cy = y - chipH - 8;
    if (cy < 64) cy = y + h + 8;
    if (cx + chipW > this.w - 8) cx = this.w - 8 - chipW;
    if (cx < 8) cx = 8;
    ctx.globalAlpha = alpha * 0.82;
    ctx.fillStyle = 'rgba(5,6,10,0.78)';
    roundRect(ctx, cx, cy, chipW, chipH, 6);
    ctx.fill();
    ctx.globalAlpha = alpha * 0.6;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.globalAlpha = alpha;
    ctx.font = FONT_CHIP;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = color;
    ctx.fillText(slot.roleText, cx + 9, cy + chipH / 2 + 0.5);
    if (slot.restText) {
      ctx.fillStyle = WHITE;
      ctx.fillText(slot.restText, cx + 9 + slot.roleW, cy + chipH / 2 + 0.5);
    }
    if (slot.glyph) {
      ctx.font = FONT_GLYPH;
      ctx.fillText(slot.glyph, cx + 9 + slot.roleW + slot.restW + 8, cy + chipH / 2 + 1);
    }

    // Gesture hold ring at the top-right corner of the square.
    if (slot.hold > 0.01) {
      const rx = x + w;
      const ry = y;
      const rr = 17;
      ctx.globalAlpha = alpha * Math.min(1, slot.hold * 4);
      ctx.fillStyle = 'rgba(5,6,10,0.8)';
      ctx.beginPath();
      ctx.arc(rx, ry, rr, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = 'rgba(200,215,255,0.22)';
      ctx.lineWidth = 3;
      ctx.stroke();
      ctx.strokeStyle = color;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(rx, ry, rr, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, slot.hold));
      ctx.stroke();
      ctx.font = FONT_GLYPH_BIG;
      ctx.textAlign = 'center';
      ctx.fillStyle = WHITE;
      ctx.fillText(slot.holdGlyph, rx, ry + 1);
      ctx.textAlign = 'left';
    }

    // Volume gauge beside the volume hand (on the outer side).
    if (slot.role === 'volume' || slot.role === 'style') {
      const gx = x - 16 < 6 ? x + w + 10 : x - 16;
      const gh = h;
      ctx.globalAlpha = alpha * 0.5;
      ctx.fillStyle = 'rgba(200,215,255,0.16)';
      roundRect(ctx, gx, y, 6, gh, 3);
      ctx.fill();
      ctx.globalAlpha = alpha;
      ctx.fillStyle = NEUTRAL;
      const fh = gh * slot.gauge;
      roundRect(ctx, gx, y + gh - fh, 6, fh, 3);
      ctx.fill();
      // ticks every 10%
      ctx.globalAlpha = alpha * 0.55;
      ctx.fillStyle = '#05060a';
      for (let i = 1; i < 10; i++) ctx.fillRect(gx, y + (gh * i) / 10, 6, 1);
    }

    // Tilt arc (chords mode): right hand = filter, left hand = major/minor swap.
    if ((slot.role === 'style' || slot.role === 'degree') && this.tilt) {
      const rad = Math.max(22, Math.min(40, w * 0.32));
      const cx = x + w / 2;
      const cy = Math.min(this.h - 8, y + h + rad + 10);
      const a0 = -Math.PI / 2 - 1.05;
      const a1 = -Math.PI / 2 + 1.05;
      ctx.globalAlpha = alpha * 0.4;
      ctx.strokeStyle = 'rgba(200,215,255,0.5)';
      ctx.lineWidth = 3;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.arc(cx, cy, rad, a0, a1);
      ctx.stroke();
      const roll = Math.max(-1.05, Math.min(1.05, slot.roll));
      const an = -Math.PI / 2 + roll;
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = slot.borrowed ? '#ff3dcb' : color;
      ctx.beginPath();
      ctx.arc(cx, cy, rad, -Math.PI / 2, an, roll < 0);
      ctx.stroke();
      ctx.fillStyle = WHITE;
      ctx.beginPath();
      ctx.arc(cx + Math.cos(an) * rad, cy + Math.sin(an) * rad, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = FONT_TAG;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.globalAlpha = alpha * 0.75;
      ctx.fillStyle = slot.borrowed ? '#ff3dcb' : WHITE;
      ctx.fillText(slot.role === 'style' ? 'FILTER' : slot.borrowed ? 'MAJ ⇄ MIN' : 'TILT', cx, cy - rad * 0.35);
      ctx.textAlign = 'left';
    }

    // Fingertip reticle: melody voices only (chords mode reads the whole hand).
    if (slot.role === 'degree' || slot.role === 'style') {
      ctx.globalAlpha = 1;
      return;
    }
    const r = 12 + pulse * 3;
    const tx = slot.tipX;
    const ty = slot.tipY;
    if (slot.gate && fancy) {
      const glow = 56 + slot.velocity * 40;
      ctx.globalAlpha = alpha * (0.55 + 0.4 * slot.velocity);
      ctx.globalCompositeOperation = 'lighter';
      ctx.drawImage(this.sprite(color), tx - glow / 2, ty - glow / 2, glow, glow);
      ctx.globalCompositeOperation = 'source-over';
    }
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = slot.gate ? color : WHITE;
    ctx.lineWidth = slot.gate ? 2 : 1.5;
    ctx.beginPath();
    ctx.arc(tx, ty, r, 0, Math.PI * 2);
    ctx.moveTo(tx - r - 7, ty);
    ctx.lineTo(tx - r - 2, ty);
    ctx.moveTo(tx + r + 2, ty);
    ctx.lineTo(tx + r + 7, ty);
    ctx.moveTo(tx, ty - r - 7);
    ctx.lineTo(tx, ty - r - 2);
    ctx.moveTo(tx, ty + r + 2);
    ctx.lineTo(tx, ty + r + 7);
    ctx.stroke();
    ctx.fillStyle = slot.gate ? WHITE : color;
    ctx.beginPath();
    ctx.arc(tx, ty, 2.2, 0, Math.PI * 2);
    ctx.fill();
    if (pulse > 0) {
      ctx.globalAlpha = alpha * pulse * 0.9;
      ctx.strokeStyle = color;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(tx, ty, r + (1 - pulse) * 30, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (slot.role === 'lead' && !Number.isNaN(this.targetY)) this.drawTargetGuide(tx, ty, r, alpha);
    ctx.globalAlpha = 1;
  }

  // ---- learn mode -----------------------------------------------------------------------

  /** The lane to hit: a pulsing band with marching dashes and a NEXT tag, drawn even with lanes off. */
  private drawLearnTarget(learn: LearnState | null, lanes: readonly Lane[], chordsMode: boolean, sy: number, oy: number, now: number): void {
    this.targetY = Number.NaN;
    this.learnNow = now;
    const target = learn && !learn.done && !chordsMode ? learn.target : null;
    const lane = target && target.laneIndex >= 0 ? lanes[target.laneIndex] : undefined;
    if (!lane) return;
    this.targetHitT = learn!.lastHitT;
    const ctx = this.ctx;
    const y = lane.y * sy + oy;
    const hh = Math.max(12, lane.h * sy);
    this.targetY = y;
    this.targetH = hh;
    const pulse = this.reduced ? 0.6 : 0.5 + 0.5 * Math.sin(now / 210);
    ctx.globalAlpha = 0.1 + 0.12 * pulse;
    ctx.fillStyle = TARGET;
    ctx.fillRect(0, y - hh / 2, this.w, hh);
    ctx.globalAlpha = 0.45 + 0.4 * pulse;
    ctx.strokeStyle = TARGET;
    ctx.lineWidth = 1.5;
    ctx.setLineDash(TARGET_DASH);
    ctx.lineDashOffset = this.reduced ? 0 : -((now / 28) % 18);
    ctx.beginPath();
    ctx.moveTo(0, Math.round(y - hh / 2) + 0.5);
    ctx.lineTo(this.w, Math.round(y - hh / 2) + 0.5);
    ctx.moveTo(0, Math.round(y + hh / 2) - 0.5);
    ctx.lineTo(this.w, Math.round(y + hh / 2) - 0.5);
    ctx.stroke();
    ctx.setLineDash(EMPTY_DASH);
    ctx.lineDashOffset = 0;
    // NEXT tag with the note name at the left edge.
    ctx.font = FONT_LANE_ON;
    if (target!.note !== this.targetNote) {
      this.targetNote = target!.note;
      this.targetNoteW = ctx.measureText(target!.note).width;
    }
    const chipW = this.targetNoteW + 46;
    const chipH = Math.min(22, hh + 6);
    const cx = 10;
    ctx.globalAlpha = 0.92;
    ctx.fillStyle = 'rgba(5,6,10,0.82)';
    roundRect(ctx, cx, y - chipH / 2, chipW, chipH, chipH / 2);
    ctx.fill();
    ctx.strokeStyle = TARGET;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = TARGET;
    ctx.font = FONT_TAG;
    ctx.fillText('NEXT', cx + 9, y + 0.5);
    ctx.font = FONT_LANE_ON;
    ctx.fillStyle = WHITE;
    ctx.fillText(target!.note, cx + 40, y + 0.5);
    ctx.globalAlpha = 1;
  }

  /** On the lead reticle: a chevron and a dashed guide toward the target lane, or a lock ring on it. */
  private drawTargetGuide(tx: number, ty: number, r: number, alpha: number): void {
    const ctx = this.ctx;
    const dy = this.targetY - ty;
    ctx.strokeStyle = TARGET;
    ctx.fillStyle = TARGET;
    const sinceHit = this.learnNow - this.targetHitT;
    if (!this.reduced && this.targetHitT > 0 && sinceHit >= 0 && sinceHit < 450) {
      const k = sinceHit / 450;
      ctx.globalAlpha = alpha * (1 - k);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(tx, ty, r + 6 + k * 34, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (Math.abs(dy) <= this.targetH / 2) {
      ctx.globalAlpha = alpha;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(tx, ty, r + 6, 0, Math.PI * 2);
      ctx.stroke();
      return;
    }
    const dir = dy > 0 ? 1 : -1;
    const from = ty + dir * (r + 10);
    ctx.globalAlpha = alpha * 0.45;
    ctx.lineWidth = 1.5;
    ctx.setLineDash(TARGET_DASH);
    ctx.beginPath();
    ctx.moveTo(tx, from);
    ctx.lineTo(tx, this.targetY);
    ctx.stroke();
    ctx.setLineDash(EMPTY_DASH);
    const bob = this.reduced ? 0 : Math.sin(this.learnNow / 160) * 3;
    const ay = ty + dir * (r + 22 + bob);
    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.moveTo(tx - 9, ay - dir * 6);
    ctx.lineTo(tx, ay + dir * 5);
    ctx.lineTo(tx + 9, ay - dir * 6);
    ctx.lineTo(tx, ay - dir * 1);
    ctx.closePath();
    ctx.fill();
  }

  private degreeSlot(): Slot | null {
    for (const s of this.slots) if (s.seen && s.role === 'degree') return s;
    return null;
  }

  // ---- particles ------------------------------------------------------------------------

  private emit(x: number, y: number): void {
    const i = this.pNext;
    this.pNext = (i + 1) % MAX_PARTICLES;
    const a = Math.random() * Math.PI * 2;
    const sp = 20 + Math.random() * 60;
    this.px[i] = x + Math.cos(a) * 4;
    this.py[i] = y + Math.sin(a) * 4;
    this.pvx[i] = Math.cos(a) * sp - 40; // drift away from the hand, toward screen left
    this.pvy[i] = Math.sin(a) * sp - 10;
    this.plife[i] = 1;
    this.psize[i] = 6 + Math.random() * 14;
  }

  private drawParticles(dt: number): void {
    const ctx = this.ctx;
    const s = dt / 1000;
    const spr = this.sprite(this.particleColor);
    ctx.globalCompositeOperation = 'lighter';
    for (let i = 0; i < MAX_PARTICLES; i++) {
      let life = this.plife[i]!;
      if (life <= 0) continue;
      life -= s * 1.1;
      this.plife[i] = life;
      if (life <= 0) continue;
      this.pvx[i]! *= 0.985;
      this.pvy[i]! *= 0.985;
      this.px[i]! += this.pvx[i]! * s;
      this.py[i]! += this.pvy[i]! * s;
      const sz = this.psize[i]! * (0.4 + life * 0.6);
      ctx.globalAlpha = life * 0.55;
      ctx.drawImage(spr, this.px[i]! - sz / 2, this.py[i]! - sz / 2, sz, sz);
    }
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  // ---- face -----------------------------------------------------------------------------

  private drawFace(
    data: StageRenderData,
    settings: Settings,
    dt: number,
    sx: number,
    sy: number,
    ox: number,
    oy: number,
    lead: VoiceState | null,
    leadColor: string,
  ): void {
    const f = data.frame?.face ?? null;
    const st = this.face;
    if (!f) {
      st.noFaceMs += dt;
      st.alpha = Math.max(0, st.alpha - dt / 200);
      if (st.alpha <= 0) st.init = false;
      if (st.alpha <= 0.01) return;
    } else {
      st.noFaceMs = 0;
      st.alpha = Math.min(1, st.alpha + dt / 250);
      const pad = f.box.w * sx * 0.06;
      const tx = f.box.x * sx + ox - pad;
      const ty = f.box.y * sy + oy - pad;
      const tw = f.box.w * sx + pad * 2;
      const th = f.box.h * sy + pad * 2;
      if (!st.init) {
        st.x = tx;
        st.y = ty;
        st.w = tw;
        st.h = th;
        st.init = true;
      } else {
        const k = ease(dt, 70);
        st.x += (tx - st.x) * k;
        st.y += (ty - st.y) * k;
        st.w += (tw - st.w) * k;
        st.h += (th - st.h) * k;
      }
    }
    const ctx = this.ctx;
    const a = st.alpha;
    const mouthMode = settings.trigger === 'mouth';
    const playing = mouthMode && !!lead?.gate;
    const { x, y, w, h } = st;
    const len = Math.max(10, Math.min(26, w * 0.14));

    ctx.globalAlpha = a * (mouthMode ? 0.55 : 0.3);
    ctx.strokeStyle = playing ? leadColor : WHITE;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, y + len);
    ctx.lineTo(x, y);
    ctx.lineTo(x + len, y);
    ctx.moveTo(x + w - len, y);
    ctx.lineTo(x + w, y);
    ctx.lineTo(x + w, y + len);
    ctx.moveTo(x + w, y + h - len);
    ctx.lineTo(x + w, y + h);
    ctx.lineTo(x + w - len, y + h);
    ctx.moveTo(x + len, y + h);
    ctx.lineTo(x, y + h);
    ctx.lineTo(x, y + h - len);
    ctx.stroke();

    if (!f) {
      ctx.globalAlpha = 1;
      return;
    }

    // Lips: brighter and thicker as the mouth opens.
    const open = f.mouthOpen;
    const lipColor = playing ? leadColor : mouthMode ? '#ff3dcb' : WHITE;
    if (f.outerLips.length > 2) {
      if (open > 0.05 && !this.lowPower && !this.degraded) {
        ctx.globalAlpha = a * open * 0.35;
        ctx.strokeStyle = lipColor;
        ctx.lineWidth = 7;
        this.polygon(f.outerLips, sx, sy, ox, oy);
        ctx.stroke();
      }
      ctx.globalAlpha = a * (0.35 + 0.6 * open);
      ctx.strokeStyle = lipColor;
      ctx.lineWidth = 1.5 + open * 1.2;
      this.polygon(f.outerLips, sx, sy, ox, oy);
      ctx.stroke();
    }
    if (f.innerLips.length > 2 && open > 0.08) {
      ctx.globalAlpha = a * open * 0.22;
      ctx.fillStyle = lipColor;
      this.polygon(f.innerLips, sx, sy, ox, oy);
      ctx.fill();
    }

    // Mouth meter beside the face box with the gate threshold tick.
    if (mouthMode) {
      const mh = Math.max(40, h * 0.42);
      const mx = x + w + 10 + 60 > this.w ? x - 15 : x + w + 10;
      const my = y + h - mh;
      ctx.globalAlpha = a * 0.6;
      ctx.fillStyle = 'rgba(200,215,255,0.16)';
      roundRect(ctx, mx, my, 5, mh, 2.5);
      ctx.fill();
      ctx.globalAlpha = a;
      ctx.fillStyle = playing ? leadColor : '#ff3dcb';
      const fh = mh * Math.min(1, open);
      roundRect(ctx, mx, my + mh - fh, 5, fh, 2.5);
      ctx.fill();
      const thr = mouthThresholds(settings.sensitivity)[0];
      ctx.fillStyle = WHITE;
      ctx.fillRect(mx - 3, my + mh - mh * thr, 11, 1.5);
      ctx.font = FONT_TAG;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.globalAlpha = a * 0.7;
      const left = mx < x;
      ctx.textAlign = left ? 'right' : 'left';
      ctx.fillText('MOUTH', left ? mx - 6 : mx + 11, my + mh - 4);
    }
    if (playing) {
      const label = 'PLAYING';
      ctx.font = FONT_TAG;
      const tw = 64;
      const cx = x + w / 2 - tw / 2;
      const cy = Math.max(64, y - 26); // stay clear of the top bar
      ctx.globalAlpha = a;
      ctx.fillStyle = leadColor;
      roundRect(ctx, cx, cy, tw, 18, 9);
      ctx.fill();
      ctx.fillStyle = '#05060a';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, cx + tw / 2, cy + 9.5);
    }
    ctx.globalAlpha = 1;
  }

  private polygon(pts: readonly { x: number; y: number }[], sx: number, sy: number, ox: number, oy: number): void {
    const ctx = this.ctx;
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i]!;
      if (i === 0) ctx.moveTo(p.x * sx + ox, p.y * sy + oy);
      else ctx.lineTo(p.x * sx + ox, p.y * sy + oy);
    }
    ctx.closePath();
  }
}

const EMPTY_HANDS: readonly HandState[] = [];
const EMPTY_LANES: readonly Lane[] = [];
const EMPTY_DASH: number[] = [];
const DASH: number[] = [2, 6];

function laneSig(l: readonly Lane[]): string {
  if (!l.length) return '0';
  const a = l[0]!;
  const b = l[l.length - 1]!;
  return `${l.length}:${a.midi}:${a.y.toFixed(4)}:${b.midi}:${b.y.toFixed(4)}:${a.note}`;
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

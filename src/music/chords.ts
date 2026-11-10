/**
 * Chord playing: finger pattern -> scale degree, chord styles, voicings, and ChordPart, which
 * performs a chord on a player (block, roll, strum patterns, arpeggios, bass lines) locked to the
 * Transport grid.
 */
import type { ArpPattern, ChordPlay, HandState, ScaleId, Settings } from '../types';
import type { Player } from './players';
import type { Technique } from './technique/profile';
import {
  RATE_UNITS,
  UNITS_PER_BEAT,
  UNITS_PER_STEP,
  beatAt,
  beatsPerBar,
  hash01,
  mod,
  stepsPerBar,
  strokeAt,
  swingDelay,
  timingJitter,
  velocityJitter,
} from './technique/rhythm';
import {
  CHORD_TYPES,
  chordTypeOf,
  diatonicSeventh,
  diatonicTriad,
  mod12,
  parentScale,
  voiceChord,
  type Chord,
  type ChordType,
} from './theory';

/**
 * Scale degree 1..7 from the extended fingers, 0 for a fist:
 * index = I, index+middle = ii, +ring = iii, four fingers = IV, all five = V,
 * index+pinky = vi, thumb+index+pinky = vii. The thumb is ignored where it does not
 * distinguish patterns (it is the least reliable finger); any other shape falls back to the
 * number of extended fingers.
 */
export function degreeFromFingers(hand: HandState): number {
  const f = hand.fingers;
  const [thumb, index, middle, ring, pinky] = f;
  if (index && !middle && !ring && !pinky) return 1;
  if (index && middle && !ring && !pinky) return 2;
  if (index && middle && ring && !pinky) return 3;
  if (index && middle && ring && pinky) return thumb ? 5 : 4;
  if (index && !middle && !ring && pinky) return thumb ? 7 : 6;
  let n = 0;
  for (const x of f) if (x) n++;
  return Math.min(5, n);
}

export type ChordStyle = 'triad' | 'seventh' | 'add9' | 'sus4' | 'open';
export const STYLE_BY_FINGERS: readonly ChordStyle[] = ['triad', 'triad', 'seventh', 'add9', 'sus4', 'open'];
export const STYLE_LABEL: Record<ChordStyle, string> = {
  triad: 'Triad',
  seventh: '7th',
  add9: 'add9',
  sus4: 'sus4',
  open: 'Open',
};

const MAJOR = CHORD_TYPES.find((t) => t.suffix === '')!;
const MINOR = CHORD_TYPES.find((t) => t.suffix === 'm')!;

/** The chord for a degree (0-based), optionally with its major/minor quality swapped. */
export function degreeChord(key: number, scale: ScaleId, degree: number, style: ChordStyle, borrowed: boolean): Chord {
  const base = diatonicTriad(key, scale, degree);
  let triad: ChordType = base.type;
  if (borrowed) triad = triad.minor ? MAJOR : MINOR;
  const third = triad.intervals[1]!;
  const fifth = triad.intervals[2]!;
  let type: ChordType | undefined = triad;
  switch (style) {
    case 'seventh': {
      const sev = borrowed ? (third === 3 ? 10 : diatonicSeventh(scale, degree)) : diatonicSeventh(scale, degree);
      type = chordTypeOf([0, third, fifth, sev]) ?? chordTypeOf([0, third, fifth, third === 3 ? 10 : 11]);
      break;
    }
    case 'add9':
      type = fifth === 7 ? chordTypeOf([0, 2, third, 7]) : triad;
      break;
    case 'sus4':
      type = chordTypeOf([0, 5, 7]);
      break;
    default:
      break;
  }
  return { root: base.root, type: type ?? triad };
}

/**
 * Voicing for a chord: smooth voice leading from `prev` around `center`, or for the 'open' style
 * a wide shape spread over two octaves (root, fifth, tenth, fifth, octave).
 */
export function chordVoicing(c: Chord, style: ChordStyle, prev: readonly number[], center: number, lo: number, hi: number): number[] {
  if (style !== 'open') return voiceChord(c, prev, center, lo, hi);
  const third = c.type.intervals[1] ?? 4;
  const fifth = c.type.intervals[2] ?? 7;
  let root = center - 7 - mod12(center - 7 - c.root);
  if (prev.length) {
    // Keep the bass of the shape close to where the last chord's bass was.
    const low = Math.min(...prev);
    if (root - low > 6) root -= 12;
    else if (low - root > 6) root += 12;
  }
  while (root + 24 > hi && root - 12 >= lo) root -= 12;
  while (root < lo) root += 12;
  return [root, root + fifth, root + 12 + third, root + 12 + fifth, root + 24].filter((n) => n >= lo && n <= hi);
}

// ---------------------------------------------------------------------------------------------
// Performer
// ---------------------------------------------------------------------------------------------

/** What the part needs from the Transport. */
export interface PartClock {
  /** Audio-context time now. */
  now(): number;
  /** Transport position in sixteenths at an audio time, NaN while the clock is stopped. */
  stepAt(time: number): number;
  /** The rhythm is locked to the bar (beat or loops running); otherwise patterns start with the chord. */
  locked(): boolean;
}

/** How the part plays, refreshed by the engine on every update. */
export interface PartContext {
  play: ChordPlay;
  tech: Technique;
  settings: Settings;
  /** The part plays a bass line on the chord root (bass voice in chords mode). */
  bass: boolean;
  /** The chord being played (walking bass reads its third and fifth). */
  chord: Chord | null;
}

interface PartNote {
  midi: number;
  handle: number;
  /** Start time (may be slightly ahead: strums and grid notes are scheduled). */
  t0: number;
  /** Audio time after which the note is no longer heard. */
  until: number;
}

/** Pedal-held notes of earlier chords kept at most. */
const MAX_RINGING = 24;
/** A struck / plucked sample has faded out by then. */
const DECAY_S = 3;

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
/** Velocity variation applies to struck / plucked notes; sustained ones follow the expression. */
const velocityHumanize = (tech: Technique): number => (tech.sustained || tech.fixedVelocity ? 0 : tech.humanize);

/**
 * Sounds one chord at a time on a player, the way the instrument is played: a block, a strum
 * string by string, a roll, an arpeggio or a strum pattern in time, with the sustain pedal and
 * human feel; or, as a bass part, a bass line on the chord root. The engine calls update() every
 * frame with the chord it wants (or null to stop) and onGrid() one sixteenth ahead of every
 * Transport sixteenth. Notes are scheduled at most a sixteenth (plus a strum) ahead, and any that
 * have not started when the chord changes are withdrawn, so nothing stale ever sounds.
 */
export class ChordPart {
  /** midi -> the note this part holds on that pitch. */
  private readonly sounding = new Map<number, PartNote>();
  /** Notes of earlier chords still held by the pedal ('hold'). */
  private readonly ringing: PartNote[] = [];
  private notes: number[] = [];
  /** Arpeggio note pool (the voicing over arpOctaves). */
  private arpPool: number[] = [];
  private id = '';
  private velocity = 0.8;
  private ctx: PartContext | null = null;
  /** Time of the last attack started from update() (the grid skips a hit that close). */
  private lastStrike = -Infinity;
  /** Transport step where the pattern's bar starts (0 when locked to the beat). */
  private origin = 0;
  private arpStep = 0;
  private arpLast: PartNote | null = null;
  private lastArpAt = -Infinity;
  /** Bass line: the note sounding and the root the line is built on. */
  private bassNote: PartNote | null = null;
  private bassRoot = 0;
  private seq = 0;
  /** Notes started from the grid since the last update (for VoiceState.onset). */
  private gridOnsets = 0;

  constructor(
    private readonly player: () => Player | null,
    private readonly onNote: (midi: number) => void,
    private readonly clock: PartClock,
  ) {}

  /** The chord voicing currently held (empty when stopped). */
  get voicing(): readonly number[] {
    return this.notes;
  }

  get active(): boolean {
    return this.id !== '';
  }

  /** The bass line's current note (bass parts), null when none sounds. */
  get bassMidi(): number | null {
    const n = this.bassNote;
    return n && this.clock.now() < n.until ? n.midi : null;
  }

  /** Notes sounding right now (held or pedalled, started and not faded), unsorted. */
  forEachSounding(fn: (midi: number) => void): void {
    const now = this.clock.now();
    // Notes scheduled a moment ahead count already: they replace a string that just stopped.
    for (const n of this.sounding.values()) if (now < n.until) fn(n.midi);
    for (const n of this.ringing) if (now < n.until && !this.sounding.has(n.midi)) fn(n.midi);
  }

  /** Returns true when a new chord (or note) started. */
  update(id: string | null, notes: readonly number[], velocity: number, t: number, force: boolean, ctx: PartContext): boolean {
    const player = this.player();
    const onset = this.gridOnsets > 0;
    this.gridOnsets = 0;
    this.ctx = ctx;
    if (!id || !player || !notes.length) {
      this.stop(t);
      return onset;
    }
    this.velocity = velocity;
    if (id === this.id && !force) return onset;
    const fresh = this.id === '';
    this.id = id;
    this.notes = notes.slice();
    if (fresh) this.origin = this.originAt(t);
    const tech = ctx.tech;
    const seed = ++this.seq * 977;
    if (ctx.bass) {
      this.bassRoot = notes[0]!;
      this.changeRelease(t, player.spec.sustained ? 0.1 : ctx.settings.bassPattern === 'root' ? 0.25 : 0.12);
      this.bassNote = this.startNote(this.bassRoot, t, 1);
    } else if (ctx.play === 'arp') {
      this.changeRelease(t, player.spec.sustained ? 0.06 : 0.35);
      this.arpPool = this.buildArpPool(player);
      this.arpStep = 0;
      this.playArp(t, seed); // the first note right away, the rest on the grid
      this.lastArpAt = t;
    } else if (ctx.play === 'block' && tech.strike === 'block' && player.spec.sustained && !force) {
      // Keep common tones ringing, move only the voices that change.
      this.cancelPending(t);
      for (const [m, n] of this.sounding) {
        if (!notes.includes(m)) {
          player.stop(n.handle, t, 0.12);
          this.sounding.delete(m);
        }
      }
      for (const m of notes) if (!this.sounding.has(m)) this.startNote(m, t, 1);
    } else {
      this.changeRelease(t, player.spec.sustained ? 0.1 : 0.25);
      // A strummed chord change: a downstroke (the reggae skank stays a short chop).
      if (ctx.play === 'strum') this.strum(t, ctx.settings.strumPattern === 'reggae' && tech.repeatStrum ? 'x' : 'D', seed);
      else if (tech.strike === 'strum') this.strum(t, 'D', seed);
      else if (tech.strike === 'roll') this.roll(t, seed);
      else this.block(t, seed);
    }
    this.lastStrike = t;
    return true;
  }

  /** Grid tick (one sixteenth ahead): arpeggio notes, strum patterns, bass lines. */
  onGrid(step: number, time: number, sixteenth: number): void {
    const player = this.player();
    const ctx = this.ctx;
    if (!this.id || !player || !ctx) return;
    const s = ctx.settings;
    const rel = step - this.origin;
    const beat = sixteenth * 4;
    const seed = step * 31 + (ctx.bass ? 17 : 5);
    const now = this.clock.now();
    if (ctx.bass) {
      this.bassGrid(rel, time, sixteenth, seed, now);
      return;
    }
    if (ctx.play === 'arp') {
      const r = RATE_UNITS[s.arpRate] ?? 6;
      const unit = beat / UNITS_PER_BEAT;
      const u0 = rel * UNITS_PER_STEP;
      for (let u = u0; u < u0 + UNITS_PER_STEP; u++) {
        if (mod(u, r) !== 0) continue;
        const at = Math.max(now, time + (u - u0) * unit + swingDelay(u, s.swing, beat) + timingJitter(seed + u, ctx.tech.humanize));
        if (at - this.lastArpAt < r * unit * 0.6) continue;
        this.lastArpAt = at;
        this.playArp(at, seed + u);
        this.gridOnsets++;
      }
    } else if (ctx.play === 'strum' && ctx.tech.repeatStrum) {
      if (mod(rel, 2) !== 0) return;
      const slot = mod(rel, stepsPerBar(s.timeSignature)) / 2;
      const stroke = strokeAt(s.strumPattern, slot);
      if (stroke === '.' || time - this.lastStrike < sixteenth * 1.5) return;
      const at = Math.max(now, time + swingDelay(rel * UNITS_PER_STEP, s.swing, beat) + timingJitter(seed, ctx.tech.humanize));
      this.strum(at, stroke, seed);
      this.gridOnsets++;
    }
  }

  /** Gate closed: everything stops (the pedal lifts). */
  stop(t: number, release?: number): void {
    const player = this.player();
    if (player) {
      const r = release ?? player.spec.release;
      for (const n of this.sounding.values()) this.end(player, n, t, r);
      for (const n of this.ringing) if (t < n.until) player.stop(n.handle, t, r);
    }
    this.sounding.clear();
    this.ringing.length = 0;
    this.arpLast = null;
    this.bassNote = null;
    this.notes = [];
    this.id = '';
  }

  /** Forget handles (the player was replaced and already released them). */
  reset(): void {
    this.sounding.clear();
    this.ringing.length = 0;
    this.arpLast = null;
    this.bassNote = null;
    this.notes = [];
    this.id = '';
  }

  // -------------------------------------------------------------------------------------------

  private originAt(t: number): number {
    if (this.clock.locked()) return 0;
    const step = this.clock.stepAt(t);
    return Number.isFinite(step) ? Math.round(step) : 0;
  }

  /** Releases a note, or withdraws it when it has not started yet. */
  private end(player: Player, n: PartNote, t: number, release: number): void {
    if (n.t0 > t + 0.001) player.cancel(n.handle, t);
    else if (t < n.until) player.stop(n.handle, t, release);
  }

  /** Notes scheduled ahead (a strum or arpeggio of the last chord) never sound. */
  private cancelPending(t: number): void {
    const player = this.player();
    if (!player) return;
    for (const [m, n] of this.sounding) {
      if (n.t0 > t + 0.001) {
        player.cancel(n.handle, t);
        this.sounding.delete(m);
      }
    }
  }

  /** A new chord replaces the old one: pending notes are withdrawn, held ones go per the pedal. */
  private changeRelease(t: number, release: number): void {
    const player = this.player();
    if (!player) return;
    this.cancelPending(t);
    const pedal = this.ctx?.tech.pedal ?? 'off';
    const guitar = this.ctx?.tech.strike === 'strum' && !player.spec.sustained;
    for (const n of this.sounding.values()) {
      if (t >= n.until) continue;
      if (pedal === 'hold') {
        this.ringing.push(n);
        continue;
      }
      // Legato pedalling: the pedal comes up just after the new chord sounds, so the two connect
      // without blurring. Without the pedal the old chord is damped (quickly on a guitar).
      if (pedal === 'auto') player.stop(n.handle, t + 0.04, 0.2);
      else player.stop(n.handle, t, guitar ? 0.12 : release);
    }
    this.sounding.clear();
    this.arpLast = null;
    this.bassNote = null;
    while (this.ringing.length > MAX_RINGING) player.stop(this.ringing.shift()!.handle, t, 0.3);
    for (let i = this.ringing.length - 1; i >= 0; i--) if (t >= this.ringing[i]!.until) this.ringing.splice(i, 1);
  }

  private startNote(midi: number, t: number, scale: number): PartNote | null {
    const player = this.player()!;
    const old = this.sounding.get(midi);
    if (old) this.end(player, old, t, 0.05);
    const h = player.start(midi, clamp01(this.velocity * scale), t);
    if (h < 0) {
      this.sounding.delete(midi);
      return null;
    }
    const n: PartNote = { midi, handle: h, t0: t, until: player.spec.sustained ? Infinity : t + DECAY_S };
    this.sounding.set(midi, n);
    this.onNote(midi);
    return n;
  }

  /** Stops a note at `at` (palm mute, reggae chop, staccato bass). */
  private damp(n: PartNote | null, at: number, release: number): void {
    if (!n) return;
    this.player()!.stop(n.handle, at, release);
    n.until = Math.min(n.until, at + release);
  }

  private block(t: number, seed: number): void {
    const tech = this.ctx!.tech;
    const h = velocityHumanize(tech);
    // One time for the whole chord (no flam), a little velocity life per note.
    this.notes.forEach((m, i) => this.startNote(m, t, velocityJitter(seed, i, h)));
  }

  private roll(t: number, seed: number): void {
    const tech = this.ctx!.tech;
    const gap = tech.rollGap * (1 + (hash01(seed, 3) - 0.5) * 0.3 * tech.humanize);
    this.notes.forEach((m, i) => this.startNote(m, t + i * gap, (1 - i * 0.02) * velocityJitter(seed, i, velocityHumanize(tech))));
  }

  /**
   * One stroke of a strum pattern. Down strums sweep every string low -> high; up strums catch
   * the top strings high -> low, a little faster and softer; louder strums are tighter.
   */
  private strum(t: number, stroke: string, seed: number): void {
    const tech = this.ctx!.tech;
    const notes = this.notes;
    const n = notes.length;
    if (!n) return;
    const h = velocityHumanize(tech);
    const stringy = tech.idiom === 'guitar' || tech.idiom === 'power' || tech.idiom === 'lute' || tech.strike === 'strum';
    let gap = (0.03 - 0.022 * clamp01(this.velocity)) * (stringy ? 1 : 0.45);
    gap *= 1 + (hash01(seed, 9) - 0.5) * 0.3 * h;
    const mute = tech.palmMute;
    const up = stroke === 'U';
    const chop = stroke === 'x';
    let from: number;
    let to: number;
    if (up) {
      to = Math.max(0, n - Math.min(tech.upStrings, n));
      from = n - 1;
    } else if (chop) {
      // Reggae skank: a quick, tight stab on the top strings, damped right away.
      from = Math.max(0, n - Math.min(4, n));
      to = n - 1;
      gap *= 0.5;
    } else {
      from = 0;
      to = mute ? Math.min(n, 4) - 1 : n - 1;
    }
    const dir = up ? -1 : 1;
    const g = up ? gap * 0.8 : gap;
    for (let j = from, i = 0; up ? j >= to : j <= to; j += dir, i++) {
      const at = t + i * g;
      const vel = (up ? 0.78 : chop ? 0.9 : 1) * (1 - i * 0.035) * (mute ? 1.08 : 1) * velocityJitter(seed, j, h);
      const note = this.startNote(notes[j]!, at, vel);
      if (chop) this.damp(note, at + 0.09, 0.05);
      else if (mute) this.damp(note, at + 0.13, 0.07);
    }
  }

  private buildArpPool(player: Player): number[] {
    const octaves = Math.max(1, Math.min(3, Math.round(this.ctx!.settings.arpOctaves)));
    const hi = player.spec.range[1];
    const pool: number[] = [];
    for (let o = 0; o < octaves; o++) {
      for (const m of this.notes) {
        const x = m + 12 * o;
        if (x <= hi && !pool.includes(x)) pool.push(x);
      }
    }
    return pool.sort((a, b) => a - b);
  }

  private playArp(time: number, seed: number): void {
    const player = this.player()!;
    const ctx = this.ctx!;
    const pool = this.arpPool.length ? this.arpPool : this.notes;
    const n = pool.length;
    if (!n) return;
    const k = this.arpStep++;
    const idx = arpIndex(ctx.settings.arpPattern, k, n, this.arpLast ? pool.indexOf(this.arpLast.midi) : -1, seed);
    const midi = pool[idx]!;
    // Plucked / pedalled instruments let the notes ring; others damp the previous one.
    if (this.arpLast && !ctx.tech.ring && this.arpLast.midi !== midi) {
      this.end(player, this.arpLast, time, player.spec.sustained ? 0.05 : 0.45);
      this.sounding.delete(this.arpLast.midi);
    }
    const h = velocityHumanize(ctx.tech);
    // A gentle accent on the first note of each cycle.
    const accent = k % n === 0 ? 1 : 0.9;
    this.arpLast = this.startNote(midi, time, accent * velocityJitter(seed, idx, h));
  }

  /** Bass line on the grid: alternating root-fifth, octave 8ths or a walking line. */
  private bassGrid(rel: number, time: number, sixteenth: number, seed: number, now: number): void {
    const ctx = this.ctx!;
    const s = ctx.settings;
    const pattern = s.bassPattern;
    if (pattern === 'root' || pattern === 'off') return;
    const player = this.player()!;
    const [lo, hi] = player.spec.range;
    const fit = (m: number): number => {
      let x = m;
      while (x < lo) x += 12;
      while (x > hi) x -= 12;
      return x;
    };
    const barSteps = stepsPerBar(s.timeSignature);
    const inBar = mod(rel, barSteps);
    const root = this.bassRoot;
    const third = ctx.chord?.type.intervals[1] ?? 4;
    const fifth = ctx.chord?.type.intervals[2] ?? 7;
    let midi: number;
    let dur = Infinity;
    if (pattern === 'octave') {
      if (mod(rel, 2) !== 0) return;
      const high = root + 12 <= hi ? root + 12 : root;
      const low = high === root ? root - 12 : root;
      midi = (inBar / 2) % 2 ? high : low;
      dur = sixteenth * 1.6;
    } else {
      const b = beatAt(s.timeSignature, inBar);
      if (b < 0) return;
      if (pattern === 'root-fifth') {
        midi = b % 2 ? fit(root + fifth - 12 >= lo ? root + fifth - 12 : root + fifth) : root;
      } else {
        midi = fit(walkingNote(root, third, fifth, b, beatsPerBar(s.timeSignature), Math.floor(rel / barSteps), s.key, s.scale));
      }
    }
    if (time - this.lastStrike < sixteenth * 1.5) return; // the chord change already played it
    const beat = sixteenth * 4;
    const at = Math.max(now, time + swingDelay(rel * UNITS_PER_STEP, s.swing, beat) + timingJitter(seed, ctx.tech.humanize));
    if (this.bassNote) {
      this.end(player, this.bassNote, at, player.spec.sustained ? 0.04 : 0.06);
      this.sounding.delete(this.bassNote.midi);
    }
    const h = velocityHumanize(ctx.tech);
    // Beat one a little stronger, like a bass player leaning on the downbeat.
    const note = this.startNote(midi, at, (inBar === 0 ? 1 : 0.86) * velocityJitter(seed, 0, h));
    if (dur < Infinity) this.damp(note, at + dur, 0.05);
    this.bassNote = note;
    this.gridOnsets++;
  }
}

/** Arpeggio order: the pool index to play at step k. */
export function arpIndex(pattern: ArpPattern, k: number, n: number, last: number, seed: number): number {
  if (n <= 1) return 0;
  switch (pattern) {
    case 'down':
      return n - 1 - (k % n);
    case 'up-down': {
      // Up then down without repeating the ends: 0 1 2 3 2 1 0 1 ...
      const cycle = 2 * n - 2;
      const i = k % cycle;
      return i < n ? i : cycle - i;
    }
    case 'random': {
      // Deterministic, never the same note twice in a row.
      const r = Math.floor(hash01(seed, k) * (n - 1));
      return last >= 0 && r >= last ? r + 1 : r;
    }
    case 'broken':
      // 1-3-2-4-3-5: thirds climbing.
      return (Math.floor(k / 2) + (k % 2) * 2) % n;
    case 'alberti': {
      // Low, high, middle, high (C G E G).
      const mid = n > 3 ? n - 2 : 1;
      return [0, n - 1, mid, n - 1][k % 4]!;
    }
    case 'up':
    default:
      return k % n;
  }
}

/**
 * Walking bass, one note per beat: the root on beat one, chord and scale tones in between, and on
 * the last beat an approach note into the next bar's root, chromatic from below on even bars and
 * a scale step from above on odd bars.
 */
export function walkingNote(root: number, third: number, fifth: number, beat: number, beats: number, bar: number, key: number, scale: ScaleId): number {
  if (beat === 0) return root;
  const parent = parentScale(scale);
  const inScale = (m: number): boolean => parent.includes(mod12(m - key));
  if (beat === beats - 1) {
    if (bar % 2 === 0) return root - 1;
    let above = root + 1;
    while (!inScale(above) && above < root + 3) above++;
    return above;
  }
  let sixth = root + fifth + 1;
  while (!inScale(sixth) && sixth < root + fifth + 3) sixth++;
  const line = bar % 2 === 0 ? [root + third, root + fifth, sixth] : [root + fifth, sixth, root + third + 12];
  return line[(beat - 1) % line.length]!;
}

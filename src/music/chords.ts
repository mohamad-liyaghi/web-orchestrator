/**
 * Chord playing: finger pattern -> scale degree, chord styles, voicings, and ChordPart, which
 * sounds a chord on a player as a block, a strum or an arpeggio locked to the Transport grid.
 */
import type { ChordPlay, HandState, ScaleId } from '../types';
import type { Player } from './players';
import {
  CHORD_TYPES,
  chordTypeOf,
  diatonicSeventh,
  diatonicTriad,
  mod12,
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

const STRUM_GAP = 0.022;

/**
 * Sounds one chord at a time on a player. The engine calls update() every frame with the chord
 * it wants (or null to stop) and onGrid() one sixteenth ahead of every Transport sixteenth.
 */
export class ChordPart {
  /** midi -> handle of every note this part holds. */
  private readonly sounding = new Map<number, number>();
  private notes: number[] = [];
  private id = '';
  private velocity = 0.8;
  private startedAt = -Infinity;
  private arpStep = 0;
  private arpLast: { midi: number; handle: number } | null = null;
  private lastArpAt = -Infinity;
  /** Notes started from the grid since the last update (for VoiceState.onset). */
  private gridOnsets = 0;

  constructor(
    private readonly player: () => Player | null,
    private readonly onNote: (midi: number) => void,
  ) {}

  /** The chord voicing currently held (empty when stopped). */
  get voicing(): readonly number[] {
    return this.notes;
  }

  get active(): boolean {
    return this.id !== '';
  }

  /** Notes sounding right now (held by the part), unsorted. */
  forEachSounding(fn: (midi: number) => void): void {
    for (const m of this.sounding.keys()) fn(m);
  }

  /** Returns true when a new chord (or note) started. */
  update(id: string | null, notes: readonly number[], velocity: number, play: ChordPlay, t: number, force: boolean): boolean {
    const player = this.player();
    let onset = this.gridOnsets > 0;
    this.gridOnsets = 0;
    if (!id || !player || !notes.length) {
      this.stop(t);
      return onset;
    }
    this.velocity = velocity;
    if (id === this.id && !force) return onset;
    this.id = id;
    this.notes = notes.slice();
    this.startedAt = t;
    const sustained = player.spec.sustained;
    if (play === 'arp') {
      this.releaseAll(t, sustained ? 0.06 : 0.35);
      this.arpStep = 0;
      this.playArp(t); // the first note right away, the rest on the grid
      this.lastArpAt = t;
    } else if (sustained && play === 'block' && !force) {
      // Keep common tones ringing, move only the voices that change.
      for (const [m, h] of this.sounding) {
        if (!notes.includes(m)) {
          player.stop(h, t, 0.12);
          this.sounding.delete(m);
        }
      }
      for (const m of notes) if (!this.sounding.has(m)) this.startNote(m, t);
    } else {
      this.strike(t, play === 'strum');
    }
    return true;
  }

  /** Grid tick (one sixteenth ahead): arpeggio notes and on-the-beat strums. */
  onGrid(step: number, time: number, play: ChordPlay, sixteenth: number, beatStrum: boolean): void {
    const player = this.player();
    if (!this.id || !player) return;
    if (play === 'arp') {
      if (step % 2 !== 0 || time - this.lastArpAt < sixteenth * 1.2) return;
      this.lastArpAt = time;
      this.playArp(time);
      this.gridOnsets++;
    } else if (play === 'strum' && beatStrum && step % 4 === 0 && !player.spec.sustained) {
      if (time - this.startedAt < sixteenth * 2) return;
      this.strike(time, true);
      this.gridOnsets++;
    }
  }

  stop(t: number, release?: number): void {
    const player = this.player();
    if (player) for (const h of this.sounding.values()) player.stop(h, t, release ?? player.spec.release);
    this.sounding.clear();
    this.arpLast = null;
    this.notes = [];
    this.id = '';
  }

  /** Forget handles (the player was replaced and already released them). */
  reset(): void {
    this.sounding.clear();
    this.arpLast = null;
    this.notes = [];
    this.id = '';
  }

  private strike(t: number, strum: boolean): void {
    const player = this.player()!;
    this.releaseAll(t, player.spec.sustained ? 0.1 : 0.25);
    this.notes.forEach((m, i) => this.startNote(m, t + (strum ? i * STRUM_GAP : 0), strum ? 1 - i * 0.04 : 1));
  }

  private playArp(time: number): void {
    const player = this.player()!;
    const n = this.notes.length;
    if (!n) return;
    // Up then down without repeating the ends: 0 1 2 3 2 1 0 1 ...
    const cycle = Math.max(1, 2 * n - 2);
    const k = this.arpStep % cycle;
    this.arpStep++;
    const midi = this.notes[k < n ? k : cycle - k]!;
    if (this.arpLast) {
      player.stop(this.arpLast.handle, time, player.spec.sustained ? 0.05 : 0.45);
      this.sounding.delete(this.arpLast.midi);
    }
    const handle = this.startNote(midi, time);
    this.arpLast = handle >= 0 ? { midi, handle } : null;
  }

  private startNote(midi: number, t: number, scale = 1): number {
    const player = this.player()!;
    const old = this.sounding.get(midi);
    if (old !== undefined) player.stop(old, t, 0.05);
    const h = player.start(midi, this.velocity * scale, t);
    if (h >= 0) {
      this.sounding.set(midi, h);
      this.onNote(midi);
    } else {
      this.sounding.delete(midi);
    }
    return h;
  }

  private releaseAll(t: number, release: number): void {
    const player = this.player();
    if (player) for (const h of this.sounding.values()) player.stop(h, t, release);
    this.sounding.clear();
    this.arpLast = null;
  }
}

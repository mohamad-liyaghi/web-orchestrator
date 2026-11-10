/**
 * Pure music theory helpers: scales, note spelling, lane layout, diatonic chords, chord
 * detection and roman numerals. No audio in here, so everything is cheap and testable.
 */
import type { ScaleDef, ScaleId } from '../types';

export const SCALES: readonly ScaleDef[] = [
  { id: 'major', name: 'Major', intervals: [0, 2, 4, 5, 7, 9, 11] },
  { id: 'minor', name: 'Minor', intervals: [0, 2, 3, 5, 7, 8, 10] },
  { id: 'major-pentatonic', name: 'Major pentatonic', intervals: [0, 2, 4, 7, 9] },
  { id: 'minor-pentatonic', name: 'Minor pentatonic', intervals: [0, 3, 5, 7, 10] },
  { id: 'blues', name: 'Blues', intervals: [0, 3, 5, 6, 7, 10] },
  { id: 'dorian', name: 'Dorian', intervals: [0, 2, 3, 5, 7, 9, 10] },
  { id: 'mixolydian', name: 'Mixolydian', intervals: [0, 2, 4, 5, 7, 9, 10] },
  { id: 'harmonic-minor', name: 'Harmonic minor', intervals: [0, 2, 3, 5, 7, 8, 11] },
  { id: 'japanese', name: 'Japanese (hirajoshi)', intervals: [0, 2, 3, 7, 8] },
  { id: 'chromatic', name: 'Chromatic', intervals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  { id: 'continuous', name: 'Continuous', intervals: [] },
];

const MAJOR = [0, 2, 4, 5, 7, 9, 11];
const NATURAL_MINOR = [0, 2, 3, 5, 7, 8, 10];

export function scaleDef(id: ScaleId): ScaleDef {
  return SCALES.find((s) => s.id === id) ?? SCALES[0]!;
}

/** The 7-note scale whose triads and numerals describe harmony in this key. */
export function parentScale(id: ScaleId): readonly number[] {
  switch (id) {
    case 'major':
    case 'minor':
    case 'dorian':
    case 'mixolydian':
    case 'harmonic-minor':
      return scaleDef(id).intervals;
    case 'minor-pentatonic':
    case 'blues':
    case 'japanese':
      return NATURAL_MINOR;
    default:
      return MAJOR;
  }
}

/** Semitones from the key root up to the relative major (decides sharps vs flats). */
function relativeMajorOffset(id: ScaleId): number {
  switch (id) {
    case 'minor':
    case 'minor-pentatonic':
    case 'blues':
    case 'harmonic-minor':
    case 'japanese':
      return 3;
    case 'dorian':
      return 10;
    case 'mixolydian':
      return 5;
    default:
      return 0;
  }
}

const SHARP_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;
const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'] as const;
/** Major keys written with flats: F, Bb, Eb, Ab, Db. (Gb/F# is spelled with sharps.) */
const FLAT_MAJOR_KEYS = new Set([5, 10, 3, 8, 1]);

export const mod12 = (n: number): number => ((n % 12) + 12) % 12;

/** True when notes in this key/scale are spelled with flats. */
export function usesFlats(key: number, scale: ScaleId): boolean {
  return FLAT_MAJOR_KEYS.has(mod12(key + relativeMajorOffset(scale)));
}

export function pcName(pc: number, flats: boolean): string {
  return (flats ? FLAT_NAMES : SHARP_NAMES)[mod12(pc)]!;
}

/** "C#4" style name for an integer MIDI note (C4 = 60). */
export function noteName(midi: number, flats: boolean): string {
  const m = Math.round(midi);
  return `${pcName(m, flats)}${Math.floor(m / 12) - 1}`;
}

/** Sample file names always use flats (Db, Eb, Gb, Ab, Bb), matching the soundfont files. */
export function fileNoteName(midi: number): string {
  return `${FLAT_NAMES[mod12(midi)]}${Math.floor(midi / 12) - 1}`;
}

export function midiToFreq(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

// ---------------------------------------------------------------------------------------------
// Note sets for the voices
// ---------------------------------------------------------------------------------------------

/** Scale intervals used to lay out lanes ('continuous' lays out semitones). */
function laneIntervals(scale: ScaleId): readonly number[] {
  const s = scaleDef(scale);
  return s.intervals.length ? s.intervals : SCALES.find((x) => x.id === 'chromatic')!.intervals;
}

/** `count` ascending scale notes starting at `start` (snapped up to the next scale note). */
function scaleRun(key: number, scale: ScaleId, start: number, count: number): number[] {
  const iv = laneIntervals(scale);
  const inScale = new Set(iv.map((i) => mod12(key + i)));
  const out: number[] = [];
  for (let m = start; out.length < count && m < start + 12 * 12; m++) {
    if (inScale.has(mod12(m))) out.push(m);
  }
  return out;
}

/** Shift a run by octaves to sit inside [lo, hi] as well as possible, then clip it. */
function fitRange(notes: number[], lo: number, hi: number): number[] {
  if (!notes.length) return notes;
  let shift = 0;
  while (notes[notes.length - 1]! + shift > hi && notes[0]! + shift - 12 >= lo) shift -= 12;
  while (notes[0]! + shift < lo && notes[notes.length - 1]! + shift + 12 <= hi) shift += 12;
  const out = notes.map((n) => n + shift).filter((n) => n >= lo && n <= hi);
  return out.length >= 2 ? out : notes.map((n) => Math.min(hi, Math.max(lo, n)));
}

/**
 * Lead notes: `span` scale notes starting on the root in octave 4 + octave (octave 3 when the
 * span covers more than ~two octaves, so the middle of the zone stays in a singable register).
 */
export function leadNotes(key: number, scale: ScaleId, octave: number, span: number, range: [number, number]): number[] {
  const iv = laneIntervals(scale);
  const octavesCovered = (span / iv.length) * 12;
  const baseOctave = octavesCovered > 26 ? 3 : 4;
  const root = 12 * (baseOctave + octave + 1) + mod12(key);
  return fitRange(scaleRun(key, scale, root, span), range[0], range[1]);
}

/** Bass notes: ~10 scale notes from the root around octave 2. */
export function bassNotes(key: number, scale: ScaleId, range: [number, number]): number[] {
  const root = 36 + mod12(key);
  return fitRange(scaleRun(key, scale, root, 10), range[0], range[1]);
}

// ---------------------------------------------------------------------------------------------
// Chords
// ---------------------------------------------------------------------------------------------

export interface ChordType {
  suffix: string;
  intervals: readonly number[];
  /** Minor-ish quality: written with a lowercase numeral. */
  minor: boolean;
  /** Numeral decoration, e.g. "°", "ø7", "maj7". */
  numeral: string;
  /** Small penalty for complex chords so simple names win ties. */
  complexity: number;
}

export const CHORD_TYPES: readonly ChordType[] = [
  { suffix: '', intervals: [0, 4, 7], minor: false, numeral: '', complexity: 0 },
  { suffix: 'm', intervals: [0, 3, 7], minor: true, numeral: '', complexity: 0 },
  { suffix: 'dim', intervals: [0, 3, 6], minor: true, numeral: '°', complexity: 0.3 },
  { suffix: 'aug', intervals: [0, 4, 8], minor: false, numeral: '+', complexity: 0.4 },
  { suffix: 'sus2', intervals: [0, 2, 7], minor: false, numeral: 'sus2', complexity: 0.35 },
  { suffix: 'sus4', intervals: [0, 5, 7], minor: false, numeral: 'sus4', complexity: 0.3 },
  { suffix: '5', intervals: [0, 7], minor: false, numeral: '5', complexity: 0.1 },
  { suffix: '6', intervals: [0, 4, 7, 9], minor: false, numeral: '6', complexity: 0.45 },
  { suffix: 'm6', intervals: [0, 3, 7, 9], minor: true, numeral: '6', complexity: 0.5 },
  { suffix: '7', intervals: [0, 4, 7, 10], minor: false, numeral: '7', complexity: 0.2 },
  { suffix: 'maj7', intervals: [0, 4, 7, 11], minor: false, numeral: 'maj7', complexity: 0.25 },
  { suffix: 'm7', intervals: [0, 3, 7, 10], minor: true, numeral: '7', complexity: 0.2 },
  { suffix: 'm7b5', intervals: [0, 3, 6, 10], minor: true, numeral: 'ø7', complexity: 0.35 },
  { suffix: 'dim7', intervals: [0, 3, 6, 9], minor: true, numeral: '°7', complexity: 0.45 },
  { suffix: 'add9', intervals: [0, 2, 4, 7], minor: false, numeral: 'add9', complexity: 0.4 },
  { suffix: 'madd9', intervals: [0, 2, 3, 7], minor: true, numeral: 'add9', complexity: 0.45 },
];

/** Chord type with exactly these intervals (any order), if the dictionary has one. */
export function chordTypeOf(intervals: readonly number[]): ChordType | undefined {
  const key = [...new Set(intervals.map(mod12))].sort((a, b) => a - b).join(',');
  return CHORD_TYPES.find((t) => t.intervals.join(',') === key);
}

const TRIAD_MAJOR = CHORD_TYPES[0]!;
const TRIAD_MINOR = CHORD_TYPES[1]!;
const TRIAD_DIM = CHORD_TYPES[2]!;
const TRIAD_AUG = CHORD_TYPES[3]!;

export interface Chord {
  root: number; // pitch class
  type: ChordType;
}

/** Triad built on scale degree `degree` (0-based) of a 7-note scale by stacking thirds. */
export function diatonicTriad(key: number, scale: ScaleId, degree: number): Chord {
  const iv = parentScale(scale);
  const n = iv.length;
  const at = (d: number): number => iv[d % n]! + 12 * Math.floor(d / n);
  const r = at(degree);
  const third = at(degree + 2) - r;
  const fifth = at(degree + 4) - r;
  let type = TRIAD_MAJOR;
  if (third === 3 && fifth === 7) type = TRIAD_MINOR;
  else if (third === 3 && fifth === 6) type = TRIAD_DIM;
  else if (third === 4 && fifth === 8) type = TRIAD_AUG;
  return { root: mod12(key + r), type };
}

export function chordName(c: Chord, flats: boolean): string {
  return pcName(c.root, flats) + c.type.suffix;
}

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

/** Numeral for a chord on a known scale degree (0-based), e.g. borrowed "iv" in a major key. */
export function romanForDegree(degree: number, type: ChordType): string {
  const base = ROMAN[((degree % 7) + 7) % 7]!;
  return (type.minor ? base.toLowerCase() : base) + type.numeral;
}

/** Interval from a degree's root up to its diatonic seventh. */
export function diatonicSeventh(scale: ScaleId, degree: number): number {
  const iv = parentScale(scale);
  const n = iv.length;
  const at = (d: number): number => iv[d % n]! + 12 * Math.floor(d / n);
  return at(degree + 6) - at(degree);
}

/** Roman numeral of a chord in the key, "" when its notes are not all in the parent scale. */
export function romanNumeral(c: Chord, key: number, scale: ScaleId): string {
  const iv = parentScale(scale);
  const degree = iv.indexOf(mod12(c.root - key));
  if (degree < 0) return '';
  const inScale = new Set(iv.map((i) => mod12(key + i)));
  for (const i of c.type.intervals) if (!inScale.has(mod12(c.root + i))) return '';
  const base = ROMAN[degree]!;
  return (c.type.minor ? base.toLowerCase() : base) + c.type.numeral;
}

/** Voicing of a chord close to `prev` (smooth voice leading) inside [lo, hi], around `center`. */
export function voiceChord(c: Chord, prev: readonly number[], center: number, lo: number, hi: number): number[] {
  const iv = c.type.intervals;
  let best: number[] = [];
  let bestCost = Infinity;
  // Try every inversion in a few octave positions; pick the cheapest move from the last chord.
  for (let base = center - 12; base <= center + 12; base++) {
    if (mod12(base) !== c.root) continue;
    for (let inv = 0; inv < iv.length; inv++) {
      const notes: number[] = [];
      for (let k = 0; k < iv.length; k++) {
        const idx = (k + inv) % iv.length;
        notes.push(base + iv[idx]! + (k + inv >= iv.length ? 12 : 0));
      }
      notes.sort((a, b) => a - b);
      if (notes[0]! < lo || notes[notes.length - 1]! > hi) continue;
      let cost = 0;
      if (prev.length) {
        for (const n of notes) {
          let d = Infinity;
          for (const p of prev) d = Math.min(d, Math.abs(n - p));
          cost += d;
        }
      } else {
        cost = Math.abs(notes[0]! - center) * 0.5 + inv * 2;
      }
      if (cost < bestCost) {
        bestCost = cost;
        best = notes;
      }
    }
  }
  if (!best.length) {
    const base = center - mod12(center - c.root);
    best = iv.map((i) => Math.min(hi, Math.max(lo, base + i)));
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Chord detection
// ---------------------------------------------------------------------------------------------

/**
 * Finds the chord that best explains weighted pitch classes. `weights[pc]` is how present a
 * pitch class is (sounding notes ~1, recently played notes fade out). Allocation-free.
 */
export function detectChord(
  weights: Float32Array,
  bassPc: number,
  key: number,
  scale: ScaleId,
  out: Chord,
): boolean {
  let present = 0;
  let total = 0;
  let strongest = -1;
  for (let pc = 0; pc < 12; pc++) {
    const w = weights[pc]!;
    if (w > 0.05) {
      present++;
      total += w;
      if (strongest < 0 || w > weights[strongest]!) strongest = pc;
    }
  }
  if (present === 0) return false;
  const parent = parentScale(scale);
  if (present === 1) {
    // A single note: name the diatonic chord built on it ("E" in C major -> "Em").
    const degree = parent.indexOf(mod12(strongest - key));
    if (degree >= 0) {
      const c = diatonicTriad(key, scale, degree);
      out.root = c.root;
      out.type = c.type;
    } else {
      out.root = strongest;
      out.type = CHORD_TYPES[6]!; // power chord, neutral
    }
    return true;
  }
  const inScale = (pc: number): boolean => parent.includes(mod12(pc - key));
  let bestScore = -Infinity;
  let bestRoot = -1;
  let bestType: ChordType = TRIAD_MAJOR;
  for (let root = 0; root < 12; root++) {
    const rootW = weights[root]!;
    for (const t of CHORD_TYPES) {
      let matched = 0;
      let missing = 0;
      let mask = 0;
      for (const i of t.intervals) {
        const pc = (root + i) % 12;
        mask |= 1 << pc;
        const w = weights[pc]!;
        if (w > 0.05) matched += w;
        else missing += 1;
      }
      if (matched <= 0) continue;
      let extra = 0;
      for (let pc = 0; pc < 12; pc++) if (!(mask & (1 << pc))) extra += weights[pc]!;
      let diatonic = true;
      for (const i of t.intervals) if (!inScale(root + i)) diatonic = false;
      const score =
        matched * 2 -
        missing * 1.1 -
        extra * 1.6 +
        (root === bassPc ? 0.6 : 0) +
        (rootW > 0.05 ? 0.4 : -0.8) +
        (diatonic ? 0.35 : 0) -
        t.complexity;
      if (score > bestScore) {
        bestScore = score;
        bestRoot = root;
        bestType = t;
      }
    }
  }
  if (bestRoot < 0 || bestScore < total * 0.6) return false;
  out.root = bestRoot;
  out.type = bestType;
  return true;
}

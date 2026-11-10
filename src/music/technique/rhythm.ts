/**
 * Rhythm helpers for the performers: bars per time signature, strum patterns, arpeggiator rates,
 * swing and the deterministic "human feel". Pure functions, no audio.
 *
 * Positions are counted in Transport sixteenths ("steps") and, inside a beat, in 12 units per
 * quarter note so that straight, dotted and triplet rates are all whole numbers.
 */
import type { NoteRate, StrumPattern, TimeSignature } from '../../types';

/** Units per quarter note: 1/16 = 3, 1/16t = 2, 1/8t = 4, 1/8 = 6, 1/8d = 9, 1/4 = 12. */
export const UNITS_PER_BEAT = 12;
export const UNITS_PER_STEP = 3;

export const RATE_UNITS: Record<NoteRate, number> = {
  '1/4': 12,
  '1/8': 6,
  '1/8t': 4,
  '1/8d': 9,
  '1/16': 3,
  '1/16t': 2,
};

const STEPS_PER_BAR: Record<TimeSignature, number> = { '4/4': 16, '3/4': 12, '6/8': 12, '5/4': 20, '7/8': 14 };
/** Steps (within the bar) where the felt beats fall: 6/8 in two, 7/8 as 2+2+3. */
const BEAT_STEPS: Record<TimeSignature, readonly number[]> = {
  '4/4': [0, 4, 8, 12],
  '3/4': [0, 4, 8],
  '6/8': [0, 6],
  '5/4': [0, 4, 8, 12, 16],
  '7/8': [0, 4, 8],
};

export function stepsPerBar(ts: TimeSignature): number {
  return STEPS_PER_BAR[ts] ?? 16;
}

/** Index of the beat starting exactly at `stepInBar`, or -1 when no beat starts there. */
export function beatAt(ts: TimeSignature, stepInBar: number): number {
  return (BEAT_STEPS[ts] ?? BEAT_STEPS['4/4']).indexOf(stepInBar);
}

export function beatsPerBar(ts: TimeSignature): number {
  return (BEAT_STEPS[ts] ?? BEAT_STEPS['4/4']).length;
}

export const mod = (n: number, m: number): number => ((n % m) + m) % m;

/**
 * Strum patterns: one bar of 4/4 on 8th-note slots (the diagrams the controls show).
 *   D = down strum (all strings, low -> high)     U = up strum (top strings, high -> low, softer)
 *   x = reggae chop: a short, damped off-beat chord on the top strings
 *   . = rest (the strings keep ringing)
 * Shorter bars play the first slots (3/4 and 6/8 = the first 6 eighths, 7/8 = 7); a 5/4 bar
 * wraps into the pattern's start for its last beat.
 */
export const STRUM_RHYTHMS: Record<StrumPattern, string> = {
  single: 'D.......',
  'down-up': 'DUDUDUDU',
  folk: 'D.DU.UDU',
  pop: 'D..U.UDU',
  reggae: '..x...x.',
  ballad: 'D...D.DU',
};

/** The stroke a pattern plays on an 8th slot of the bar ('.' for none). */
export function strokeAt(pattern: StrumPattern, slotInBar: number): string {
  const p = STRUM_RHYTHMS[pattern];
  if (!p) return '.';
  return p[slotInBar % p.length] ?? '.';
}

/**
 * Swing delay (seconds) of a position `unit` (12 per beat), the same curve Tone's Transport uses
 * on an 8th-note subdivision: on-beat notes stay, the off-beat 8th moves by swing * beat / 3.
 */
export function swingDelay(unit: number, swing: number, beatSec: number): number {
  const u = mod(unit, UNITS_PER_BEAT);
  if (swing <= 0 || u === 0) return 0;
  return Math.sin((Math.PI * u) / UNITS_PER_BEAT) * swing * (beatSec / 3);
}

// ---------------------------------------------------------------------------------------------
// Human feel: deterministic, so a chord's notes share one timing and a replay is identical.
// ---------------------------------------------------------------------------------------------

/** Hash of two integers to [0, 1). */
export function hash01(a: number, b = 0): number {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul((b | 0) + 0x9e3779b9, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** Timing offset for an event: up to +-15 ms at humanize 1. */
export function timingJitter(seed: number, humanize: number): number {
  return humanize > 0 ? (hash01(seed, 7) * 2 - 1) * 0.015 * humanize : 0;
}

/** Velocity multiplier for one note of an event: up to +-12 % at humanize 1. */
export function velocityJitter(seed: number, index: number, humanize: number): number {
  return humanize > 0 ? 1 + (hash01(seed, 101 + index) * 2 - 1) * 0.12 * humanize : 1;
}

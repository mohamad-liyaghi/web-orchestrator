/**
 * Automatic diatonic harmony for melody notes: a third above, a sixth below, a fifth above or the
 * octave, counted in the key's seven-note scale (so a third is major or minor as the key wants).
 */
import type { Harmony, ScaleId } from '../../types';
import { mod12, parentScale } from '../theory';

/** Scale steps up from a melody note to its harmony note, and the octave adjustment. */
const STEPS: Record<Exclude<Harmony, 'off'>, [steps: number, octave: number]> = {
  'third-above': [2, 0],
  'sixth-below': [2, -12],
  'fifth-above': [4, 0],
  octave: [0, 12],
};

/** `steps` scale notes above `midi` (which must be in the scale). */
function stepUp(midi: number, steps: number, inScale: (pc: number) => boolean): number {
  let m = midi;
  for (let k = 0; k < steps; k++) {
    m++;
    while (!inScale(mod12(m))) m++;
  }
  return m;
}

/**
 * The harmony note for `midi`, or null for 'off'. A melody note outside the scale (blues note,
 * chromatic passing tone) is harmonised from the scale note below it, keeping the same offset,
 * so the harmony moves in parallel instead of jumping.
 */
export function harmonyNote(midi: number, kind: Harmony, key: number, scale: ScaleId): number | null {
  if (kind === 'off') return null;
  const [steps, octave] = STEPS[kind];
  if (!steps) return midi + octave;
  const parent = parentScale(scale);
  const pcs = new Set(parent.map((i) => mod12(key + i)));
  const inScale = (pc: number): boolean => pcs.has(pc);
  const whole = Math.round(midi);
  const frac = midi - whole;
  let base = whole;
  while (!inScale(mod12(base)) && whole - base < 3) base--;
  return stepUp(base, steps, inScale) + (whole - base) + frac + octave;
}

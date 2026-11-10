/**
 * Chord voicings with voice leading: close position (the cheapest move from the last chord),
 * open (the middle voice up an octave), drop-2, a wide spread (orchestral / harp), real guitar
 * shapes, and power chords.
 */
import type { Voicing } from '../../types';
import { CHORD_TYPES, chordTypeOf, mod12, voiceChord, type Chord } from '../theory';
import { fitShape, guitarShape, powerShape } from './guitar';

export type VoicingKind = Voicing | 'power';

export interface VoicingRequest {
  chord: Chord;
  kind: VoicingKind;
  /** Last voicing (voice leading). */
  prev: readonly number[];
  /** Register centre for close voicings. */
  center: number;
  lo: number;
  hi: number;
  /** Guitar: allow open shapes (auto style) or only barre shapes. */
  preferOpen?: boolean;
}

const sortAsc = (a: number, b: number): number => a - b;

function fitOctaves(notes: number[], lo: number, hi: number): number[] {
  // Shift the whole shape by octaves into the range, then drop what still sticks out.
  let shift = 0;
  const min = Math.min(...notes);
  const max = Math.max(...notes);
  while (max + shift > hi && min + shift - 12 >= lo) shift -= 12;
  while (min + shift < lo && max + shift + 12 <= hi) shift += 12;
  const out = notes.map((n) => n + shift).filter((n) => n >= lo && n <= hi);
  return out.length ? out.sort(sortAsc) : notes.sort(sortAsc);
}

/** Wide shape over two octaves: root, fifth, tenth, fifth, octave (strings section / harp). */
function spreadVoicing(c: Chord, prev: readonly number[], center: number, lo: number, hi: number): number[] {
  const third = c.type.intervals[1] ?? 4;
  const fifth = c.type.intervals[2] ?? 7;
  const top = c.type.intervals[3];
  let root = center - 7 - mod12(center - 7 - c.root);
  if (prev.length) {
    // Keep the bass of the shape close to where the last chord's bass was.
    const low = Math.min(...prev);
    if (root - low > 6) root -= 12;
    else if (low - root > 6) root += 12;
  }
  while (root + 24 > hi && root - 12 >= lo) root -= 12;
  while (root < lo) root += 12;
  const notes = [root, root + fifth, root + 12 + third, root + 12 + fifth, root + 24];
  if (top !== undefined) notes.splice(3, 0, root + 12 + top);
  return notes.filter((n) => n >= lo && n <= hi);
}

/** The notes to play for a chord. */
export function voiceFor(r: VoicingRequest): number[] {
  const { chord, kind, prev, center, lo, hi } = r;
  switch (kind) {
    case 'guitar': {
      const shape = guitarShape(chord, prev, r.preferOpen !== false);
      if (shape) {
        const fitted = fitShape(shape.notes, lo, hi);
        if (fitted.length >= 2) return fitted;
      }
      return voiceChord(chord, prev, center, lo, hi);
    }
    case 'power': {
      const fitted = fitShape(powerShape(chord.root, prev).notes, lo, hi);
      return fitted.length >= 2 ? fitted : voiceChord({ root: chord.root, type: CHORD_TYPES[6]! }, prev, center, lo, hi);
    }
    case 'spread':
      return spreadVoicing(chord, prev, center, lo, hi);
    case 'open': {
      // Close voicing, then the second voice from the bottom up an octave (root-5-10 for a triad).
      const close = voiceChord(chord, prev, center - 5, lo, hi);
      if (close.length < 3) return close;
      const out = close.slice();
      out[1] = out[1]! + 12;
      return fitOctaves(out, lo, hi);
    }
    case 'drop2': {
      // Four voices, the second from the top dropped an octave (jazz piano / guitar voicing).
      let close = voiceChord(chord, prev, center + 4, lo, hi);
      if (close.length === 3) close = [...close, close[0]! + 12].sort(sortAsc);
      if (close.length < 4) return close;
      const out = close.slice();
      out[out.length - 2] = out[out.length - 2]! - 12;
      return fitOctaves(out, lo, hi);
    }
    default:
      return voiceChord(chord, prev, center, lo, hi);
  }
}

/** The chord the notes actually spell (a power chord is "C5", not "C"). */
export function soundingChord(chord: Chord, notes: readonly number[]): Chord {
  if (!notes.length) return chord;
  const set = new Set(notes.map((n) => mod12(n - chord.root)));
  const own = chord.type.intervals;
  if (own.length === set.size && own.every((i) => set.has(mod12(i)))) return chord;
  const t = chordTypeOf([...set]);
  return t ? { root: chord.root, type: t } : chord;
}

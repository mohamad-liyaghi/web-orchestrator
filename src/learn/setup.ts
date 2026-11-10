import type { ScaleId, Settings } from '../types';
import type { Song } from './songs';

/**
 * Lane setup for a song: the key, scale, octave and span that put every song note on a lead lane
 * while keeping the lanes as wide (few) as possible.
 *
 * The lane layout mirrors the music engine's lead lanes: `span` scale notes ascending from the
 * root in octave 4 + `octave` (octave 3 when the span covers more than ~two octaves). The engine
 * may still shift the run to fit the instrument's range; the LearnController copes with that by
 * moving the song by whole octaves onto whatever lanes it is given.
 */

const INTERVALS: Record<ScaleId, readonly number[]> = {
  major: [0, 2, 4, 5, 7, 9, 11],
  minor: [0, 2, 3, 5, 7, 8, 10],
  'major-pentatonic': [0, 2, 4, 7, 9],
  'minor-pentatonic': [0, 3, 5, 7, 10],
  blues: [0, 3, 5, 6, 7, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  'harmonic-minor': [0, 2, 3, 5, 7, 8, 11],
  japanese: [0, 1, 5, 7, 8],
  chromatic: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  continuous: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
};

const mod12 = (n: number): number => ((n % 12) + 12) % 12;

export function scaleContains(key: number, scale: ScaleId, midi: number): boolean {
  return INTERVALS[scale].includes(mod12(midi - key));
}

/** Lead lane notes (ascending) for these settings, as the music engine lays them out. */
export function laneNotes(key: number, scale: ScaleId, octave: number, span: number): number[] {
  const iv = INTERVALS[scale];
  const baseOctave = (span / iv.length) * 12 > 26 ? 3 : 4;
  const root = 12 * (baseOctave + octave + 1) + mod12(key);
  const inScale = new Set(iv.map((i) => mod12(key + i)));
  const out: number[] = [];
  for (let m = root; out.length < span && m < root + 144; m++) if (inScale.has(mod12(m))) out.push(m);
  return out;
}

export interface LaneSetup {
  key: number;
  scale: ScaleId;
  octave: number;
  span: number;
}

/**
 * Smallest span (then the octave closest to 0) whose lanes hold every note of the song.
 * Chromatic lanes have no tonal centre, so they start on the song's lowest pitch class to keep the
 * lanes as wide as possible.
 */
export function laneSetup(song: Song): LaneSetup {
  let lo = Infinity;
  for (const n of song.notes) lo = Math.min(lo, n.midi);
  const key = song.scale === 'chromatic' ? mod12(lo) : song.key;
  const wanted = new Set(song.notes.map((n) => n.midi));
  for (let span = 8; span <= 24; span++) {
    for (const octave of [0, -1, 1, -2, 2]) {
      const lanes = new Set(laneNotes(key, song.scale, octave, span));
      let ok = true;
      for (const m of wanted) if (!lanes.has(m)) ok = false;
      if (ok) return { key, scale: song.scale, octave, span };
    }
  }
  // Unreachable for the shipped songs (dev/learn-check.ts proves it); stay usable anyway.
  return { key, scale: song.scale, octave: 0, span: 24 };
}

/** Settings patch applied when a song starts. Nothing is restored afterwards. */
export function learnPatch(song: Song, instrumentIds: readonly string[]): Partial<Settings> {
  const lanes = laneSetup(song);
  const patch: Partial<Settings> = {
    mode: 'melody',
    key: lanes.key,
    scale: lanes.scale,
    octave: lanes.octave,
    span: lanes.span,
    tempo: Math.max(60, Math.min(160, song.bpm)),
  };
  if (instrumentIds.includes(song.lead)) patch.lead = song.lead;
  return patch;
}

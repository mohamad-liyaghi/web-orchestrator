/**
 * Real six-string guitar chord shapes in standard tuning (E2 A2 D3 G3 B3 E4): the open shapes a
 * guitarist reaches for first (C, D, E, G, A, Am, Dm, Em and their 7 / maj7 / m7 / sus / add9 /
 * 6 variants), and movable E-shape and A-shape barre chords everywhere else. Muted strings are
 * left out, so every returned note is a string that actually rings, low string first.
 */
import { mod12, type Chord } from '../theory';

/** Open-string pitches, low E to high E. */
export const STRINGS: readonly number[] = [40, 45, 50, 55, 59, 64];
const X = -1;

type Frets = readonly number[];

/** Open shapes by "<root pc>:<chord suffix>", frets low E -> high E, -1 = muted. */
const OPEN: Record<string, Frets> = {
  // C
  '0:': [X, 3, 2, 0, 1, 0],
  '0:7': [X, 3, 2, 3, 1, 0],
  '0:maj7': [X, 3, 2, 0, 0, 0],
  '0:add9': [X, 3, 2, 0, 3, 0],
  '0:sus4': [X, 3, 3, 0, 1, 1],
  '0:sus2': [X, 3, 0, 0, 1, 3],
  '0:6': [X, 3, 2, 2, 1, 0],
  // D
  '2:': [X, X, 0, 2, 3, 2],
  '2:7': [X, X, 0, 2, 1, 2],
  '2:maj7': [X, X, 0, 2, 2, 2],
  '2:m': [X, X, 0, 2, 3, 1],
  '2:m7': [X, X, 0, 2, 1, 1],
  '2:sus4': [X, X, 0, 2, 3, 3],
  '2:sus2': [X, X, 0, 2, 3, 0],
  '2:6': [X, X, 0, 2, 0, 2],
  '2:m6': [X, X, 0, 2, 0, 1],
  '2:5': [X, X, 0, 2, 3, X],
  // E
  '4:': [0, 2, 2, 1, 0, 0],
  '4:7': [0, 2, 0, 1, 0, 0],
  '4:maj7': [0, 2, 1, 1, 0, 0],
  '4:m': [0, 2, 2, 0, 0, 0],
  '4:m7': [0, 2, 0, 0, 0, 0],
  '4:sus4': [0, 2, 2, 2, 0, 0],
  '4:add9': [0, 2, 4, 1, 0, 0],
  '4:madd9': [0, 2, 4, 0, 0, 0],
  '4:6': [0, 2, 2, 1, 2, 0],
  '4:m6': [0, 2, 2, 0, 2, 0],
  '4:5': [0, 2, 2, X, X, X],
  // F
  '5:maj7': [X, X, 3, 2, 1, 0],
  // G
  '7:': [3, 2, 0, 0, 0, 3],
  '7:7': [3, 2, 0, 0, 0, 1],
  '7:maj7': [3, 2, 0, 0, 0, 2],
  '7:add9': [3, 2, 0, 2, 0, 3],
  '7:sus4': [3, 3, 0, 0, 1, 3],
  '7:sus2': [3, 0, 0, 0, 3, 3],
  '7:6': [3, 2, 0, 0, 0, 0],
  // A
  '9:': [X, 0, 2, 2, 2, 0],
  '9:7': [X, 0, 2, 0, 2, 0],
  '9:maj7': [X, 0, 2, 1, 2, 0],
  '9:m': [X, 0, 2, 2, 1, 0],
  '9:m7': [X, 0, 2, 0, 1, 0],
  '9:sus4': [X, 0, 2, 2, 3, 0],
  '9:sus2': [X, 0, 2, 2, 0, 0],
  '9:add9': [X, 0, 2, 4, 2, 0],
  '9:madd9': [X, 0, 2, 4, 1, 0],
  '9:6': [X, 0, 2, 2, 2, 2],
  '9:m6': [X, 0, 2, 2, 1, 2],
  '9:5': [X, 0, 2, 2, X, X],
  // B
  '11:7': [X, 2, 1, 2, 0, 2],
  '11:m7': [X, 2, 0, 2, 0, 2],
};

/** Movable shapes: fret offsets from the barre fret, null = muted. Root on the low E string. */
const E_SHAPE: Record<string, readonly (number | null)[]> = {
  '': [0, 2, 2, 1, 0, 0],
  m: [0, 2, 2, 0, 0, 0],
  '7': [0, 2, 0, 1, 0, 0],
  m7: [0, 2, 0, 0, 0, 0],
  maj7: [0, null, 1, 1, 0, null],
  sus4: [0, 2, 2, 2, 0, 0],
  m7b5: [0, null, 0, 0, -1, null],
  dim7: [0, null, -1, 0, -1, null],
  '5': [0, 2, 2, null, null, null],
};
/** Root on the A string. Covers every chord type in the dictionary. */
const A_SHAPE: Record<string, readonly (number | null)[]> = {
  '': [null, 0, 2, 2, 2, 0],
  m: [null, 0, 2, 2, 1, 0],
  '7': [null, 0, 2, 0, 2, 0],
  m7: [null, 0, 2, 0, 1, 0],
  maj7: [null, 0, 2, 1, 2, 0],
  sus4: [null, 0, 2, 2, 3, 0],
  sus2: [null, 0, 2, 2, 0, 0],
  add9: [null, 0, 2, 4, 2, 0],
  madd9: [null, 0, 2, 4, 1, 0],
  '6': [null, 0, 2, 2, 2, 2],
  m6: [null, 0, 2, 2, 1, 2],
  dim: [null, 0, 1, 2, 1, null],
  m7b5: [null, 0, 1, 0, 1, null],
  aug: [null, 0, 3, 2, 2, null],
  dim7: [null, 0, 1, -1, 1, null],
  '5': [null, 0, 2, 2, null, null],
};

export interface GuitarShape {
  /** Sounding notes, low string first (muted strings omitted). */
  notes: number[];
  /** Fret per string (-1 muted), for display and tests. */
  frets: number[];
  /** Neck position: the barre fret (0 for open shapes). */
  position: number;
  kind: 'open' | 'E' | 'A';
}

function fromFrets(frets: readonly number[], kind: GuitarShape['kind'], position: number): GuitarShape {
  const notes: number[] = [];
  frets.forEach((f, s) => {
    if (f >= 0) notes.push(STRINGS[s]! + f);
  });
  return { notes, frets: frets.slice(), position, kind };
}

function movable(shape: readonly (number | null)[] | undefined, fret: number, kind: 'E' | 'A'): GuitarShape | null {
  if (!shape) return null;
  const frets = shape.map((o) => (o === null ? -1 : fret + o));
  if (frets.some((f, i) => shape[i] !== null && (f < 0 || f > 17))) return null;
  return fromFrets(frets, kind, fret);
}

/** How far the fingers move from the last chord: mean distance of each note to its nearest. */
function moveCost(notes: readonly number[], prev: readonly number[]): number {
  if (!prev.length) return 0;
  let sum = 0;
  for (const n of notes) {
    let d = Infinity;
    for (const p of prev) d = Math.min(d, Math.abs(n - p));
    sum += d;
  }
  return sum / Math.max(1, notes.length);
}

/**
 * The shape a guitarist plays for `chord`. Open shapes win when `preferOpen`; otherwise the
 * E- or A-shape barre low on the neck that moves least from the previous chord (`prev`).
 */
export function guitarShape(chord: Chord, prev: readonly number[] = [], preferOpen = true): GuitarShape | null {
  const suffix = chord.type.suffix;
  const open = OPEN[`${chord.root}:${suffix}`];
  if (open && preferOpen) return fromFrets(open, 'open', 0);
  const candidates: GuitarShape[] = [];
  const fe = mod12(chord.root - STRINGS[0]!);
  const fa = mod12(chord.root - STRINGS[1]!);
  for (const f of [fe, fe + 12]) {
    const s = movable(E_SHAPE[suffix], f, 'E');
    if (s) candidates.push(s);
  }
  for (const f of [fa, fa + 12]) {
    const s = movable(A_SHAPE[suffix], f, 'A');
    if (s) candidates.push(s);
  }
  if (open) candidates.push(fromFrets(open, 'open', 0));
  let best: GuitarShape | null = null;
  let bestCost = Infinity;
  for (const c of candidates) {
    // Low on the neck, near where the hand already is; the E shape is the fuller sound.
    const cost = c.position * 0.25 + moveCost(c.notes, prev) * 0.2 + (c.kind === 'A' ? 0.3 : 0) + (c.position > 12 ? 4 : 0);
    if (cost < bestCost) {
      bestCost = cost;
      best = c;
    }
  }
  return best;
}

/** Power chord (root, fifth, octave) on the low strings, as rock players play it. */
export function powerShape(root: number, prev: readonly number[] = []): GuitarShape {
  const fe = mod12(root - STRINGS[0]!);
  const fa = mod12(root - STRINGS[1]!);
  const e = movable(E_SHAPE['5'], fe, 'E')!;
  const a = movable(A_SHAPE['5'], fa, 'A')!;
  const cost = (s: GuitarShape) => s.position * 0.2 + moveCost(s.notes, prev) * 0.2;
  return cost(e) <= cost(a) ? e : a;
}

/** Fits shape notes into an instrument's range (banjo and friends start higher than a guitar). */
export function fitShape(notes: readonly number[], lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let n of notes) {
    while (n < lo) n += 12;
    while (n > hi) n -= 12;
    if (n >= lo && n <= hi && !out.includes(n)) out.push(n);
  }
  return out.sort((a, b) => a - b);
}

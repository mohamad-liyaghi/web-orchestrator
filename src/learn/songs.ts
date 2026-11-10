import type { ScaleId } from '../types';

/**
 * Learn mode song library. Public-domain melodies only (traditional tunes and composers who died
 * long ago; "Happy Birthday to You" is public domain in the US since 2016).
 *
 * Each song is a single melody line: MIDI notes with lengths in beats (rests are folded into the
 * note before them), the song's key (pitch class of the tonic) and a scale that contains every
 * note, so the lanes can show all of them. `dev/learn-check.ts` verifies both.
 */

export interface SongNote {
  /** MIDI note number (60 = C4). */
  midi: number;
  /** Length in beats (quarter notes). */
  beats: number;
}

export interface Song {
  id: string;
  title: string;
  credit: string;
  /** 1 easy, 2 medium, 3 hard. */
  difficulty: 1 | 2 | 3;
  /** Tonic pitch class 0..11 (0 = C). */
  key: number;
  /** A scale (rooted on `key`) that contains every note. */
  scale: ScaleId;
  /** Display key, e.g. "C major". */
  keyName: string;
  bpm: number;
  beatsPerBar: 3 | 4;
  /** Suggested lead instrument (InstrumentDef id); ignored when the catalog lacks it. */
  lead: string;
  notes: readonly SongNote[];
}

const PITCH: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

/** "C4" "F#4" "Bb3" -> MIDI. */
export function parseNote(name: string): number {
  const m = /^([A-G])([#b]?)(-?\d)$/.exec(name);
  if (!m) throw new Error(`bad note name: ${name}`);
  const acc = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  return 12 * (Number(m[3]) + 1) + PITCH[m[1]!]! + acc;
}

/**
 * Melody text -> notes. Tokens are `Note[:beats]` (default 1 beat); `|` bar lines are ignored
 * and only there to keep the transcriptions readable.
 */
function melody(text: string): SongNote[] {
  const out: SongNote[] = [];
  for (const tok of text.trim().split(/\s+/)) {
    if (tok === '|') continue;
    const [name, len] = tok.split(':');
    const beats = len === undefined ? 1 : Number(len);
    if (!(beats > 0)) throw new Error(`bad length: ${tok}`);
    out.push({ midi: parseNote(name!), beats });
  }
  return out;
}

export const SONGS: readonly Song[] = [
  {
    id: 'mary-lamb',
    title: 'Mary Had a Little Lamb',
    credit: 'Traditional',
    difficulty: 1,
    key: 0,
    scale: 'major-pentatonic',
    keyName: 'C major',
    bpm: 104,
    beatsPerBar: 4,
    lead: 'marimba',
    notes: melody(`
      E4 D4 C4 D4 | E4 E4 E4:2 | D4 D4 D4:2 | E4 G4 G4:2 |
      E4 D4 C4 D4 | E4 E4 E4 E4 | D4 D4 E4 D4 | C4:4`),
  },
  {
    id: 'twinkle',
    title: 'Twinkle Twinkle Little Star',
    credit: 'Traditional',
    difficulty: 1,
    key: 0,
    scale: 'major',
    keyName: 'C major',
    bpm: 100,
    beatsPerBar: 4,
    lead: 'music-box',
    notes: melody(`
      C4 C4 G4 G4 | A4 A4 G4:2 | F4 F4 E4 E4 | D4 D4 C4:2 |
      G4 G4 F4 F4 | E4 E4 D4:2 | G4 G4 F4 F4 | E4 E4 D4:2 |
      C4 C4 G4 G4 | A4 A4 G4:2 | F4 F4 E4 E4 | D4 D4 C4:2`),
  },
  {
    id: 'ode-to-joy',
    title: 'Ode to Joy',
    credit: 'L. van Beethoven',
    difficulty: 1,
    key: 0,
    scale: 'major',
    keyName: 'C major',
    bpm: 100,
    beatsPerBar: 4,
    lead: 'violin',
    notes: melody(`
      E4 E4 F4 G4 | G4 F4 E4 D4 | C4 C4 D4 E4 | E4:1.5 D4:0.5 D4:2 |
      E4 E4 F4 G4 | G4 F4 E4 D4 | C4 C4 D4 E4 | D4:1.5 C4:0.5 C4:2`),
  },
  {
    id: 'jingle-bells',
    title: 'Jingle Bells',
    credit: 'J. L. Pierpont',
    difficulty: 1,
    key: 0,
    scale: 'major',
    keyName: 'C major',
    bpm: 112,
    beatsPerBar: 4,
    lead: 'celesta',
    notes: melody(`
      E4 E4 E4:2 | E4 E4 E4:2 | E4 G4 C4:1.5 D4:0.5 | E4:4 |
      F4 F4 F4:1.5 F4:0.5 | F4 E4 E4 E4:0.5 E4:0.5 | E4 D4 D4 E4 | D4:2 G4:2 |
      E4 E4 E4:2 | E4 E4 E4:2 | E4 G4 C4:1.5 D4:0.5 | E4:4 |
      F4 F4 F4 F4 | F4 E4 E4 E4:0.5 E4:0.5 | G4 G4 F4 D4 | C4:4`),
  },
  {
    id: 'frere-jacques',
    title: 'Frère Jacques',
    credit: 'Traditional',
    difficulty: 2,
    key: 0,
    scale: 'major',
    keyName: 'C major',
    bpm: 100,
    beatsPerBar: 4,
    lead: 'pizzicato',
    notes: melody(`
      C4 D4 E4 C4 | C4 D4 E4 C4 | E4 F4 G4:2 | E4 F4 G4:2 |
      G4:0.5 A4:0.5 G4:0.5 F4:0.5 E4 C4 | G4:0.5 A4:0.5 G4:0.5 F4:0.5 E4 C4 |
      C4 G3 C4:2 | C4 G3 C4:2`),
  },
  {
    id: 'happy-birthday',
    title: 'Happy Birthday',
    credit: 'M. & P. Hill',
    difficulty: 2,
    key: 0,
    scale: 'major',
    keyName: 'C major',
    bpm: 96,
    beatsPerBar: 3,
    lead: 'electric-piano',
    // The dotted pickups are evened out to eighths: easier to re-articulate with the mouth.
    notes: melody(`
      G3:0.5 G3:0.5 | A3 G3 C4 | B3:2 G3:0.5 G3:0.5 | A3 G3 D4 | C4:2 G3:0.5 G3:0.5 |
      G4 E4 C4 | B3 A3 F4:0.5 F4:0.5 | E4 C4 D4 | C4:3`),
  },
  {
    id: 'amazing-grace',
    title: 'Amazing Grace',
    credit: 'Traditional',
    difficulty: 2,
    key: 7,
    scale: 'major-pentatonic',
    keyName: 'G major',
    bpm: 84,
    beatsPerBar: 3,
    lead: 'church-organ',
    notes: melody(`
      D4 | G4:2 B4:0.5 G4:0.5 | B4:2 A4 | G4:2 E4 | D4:2 D4 | G4:2 B4:0.5 G4:0.5 | B4:2 A4 |
      D5:5 B4 | D5:2 B4:0.5 G4:0.5 | B4:2 A4 | G4:2 E4 | D4:2 D4 | G4:2 B4:0.5 G4:0.5 | B4:2 A4 | G4:3`),
  },
  {
    id: 'canon-in-d',
    title: 'Canon in D (theme)',
    credit: 'J. Pachelbel',
    difficulty: 2,
    key: 2,
    scale: 'major',
    keyName: 'D major',
    bpm: 72,
    beatsPerBar: 4,
    lead: 'string-ensemble',
    notes: melody(`
      F#5:2 E5:2 | D5:2 C#5:2 | B4:2 A4:2 | B4:2 C#5:2 |
      D5:2 C#5:2 | B4:2 A4:2 | G4:2 F#4:2 | G4:2 E4:2 |
      F#5:2 E5:2 | D5:2 C#5:2 | B4:2 A4:2 | B4:2 C#5:2 | D5:4`),
  },
  {
    id: 'greensleeves',
    title: 'Greensleeves',
    credit: 'Traditional English',
    difficulty: 3,
    key: 9,
    scale: 'chromatic',
    keyName: 'A minor',
    bpm: 108,
    beatsPerBar: 3,
    lead: 'nylon-guitar',
    notes: melody(`
      A4 | C5:2 D5 | E5:1.5 F5:0.5 E5 | D5:2 B4 | G4:1.5 A4:0.5 B4 | C5:2 A4 | A4:1.5 G#4:0.5 A4 | B4:2 G#4 | E4:2
      A4 | C5:2 D5 | E5:1.5 F5:0.5 E5 | D5:2 B4 | G4:1.5 A4:0.5 B4 | C5:1.5 B4:0.5 A4 | G#4:1.5 F#4:0.5 G#4 | A4:3`),
  },
  {
    id: 'fur-elise',
    title: 'Für Elise (opening)',
    credit: 'L. van Beethoven',
    difficulty: 3,
    key: 9,
    scale: 'chromatic',
    keyName: 'A minor',
    bpm: 66,
    beatsPerBar: 3,
    lead: 'grand-piano',
    // Sixteenths are half beats; the rests after each long note are folded into it.
    notes: melody(`
      E5:0.5 D#5:0.5 | E5:0.5 D#5:0.5 E5:0.5 B4:0.5 D5:0.5 C5:0.5 | A4:1.5 C4:0.5 E4:0.5 A4:0.5 |
      B4:1.5 E4:0.5 G#4:0.5 B4:0.5 | C5:1.5 E4:0.5 E5:0.5 D#5:0.5 |
      E5:0.5 D#5:0.5 E5:0.5 B4:0.5 D5:0.5 C5:0.5 | A4:1.5 C4:0.5 E4:0.5 A4:0.5 |
      B4:1.5 E4:0.5 C5:0.5 B4:0.5 | A4:3`),
  },
];

export function findSong(id: string): Song | undefined {
  return SONGS.find((s) => s.id === id);
}

/** The song after `id` in the list (wraps around). */
export function nextSong(id: string): Song {
  const i = SONGS.findIndex((s) => s.id === id);
  return SONGS[(i + 1) % SONGS.length]!;
}

import type {
  ArpPattern,
  BassPattern,
  Harmony,
  InstrumentDef,
  NoteRate,
  PlayStyle,
  ReverbType,
  Settings,
  StrumPattern,
  SustainPedal,
  TimeSignature,
  VelocityCurve,
  Voicing,
} from '../types';
import type { Option } from './controls';
import { frag } from './dom';

/** Plain-language labels, hints and tiny diagrams for the technique and studio settings. */

export const PLAY_STYLE_OPTS: ReadonlyArray<Option<PlayStyle>> = [
  { id: 'auto', label: 'Auto', hint: 'Each instrument plays like the real one, with its own technique. Your patterns below still apply.' },
  { id: 'manual', label: 'Manual', hint: 'Every instrument plays exactly the technique you set below, nothing added.' },
];

/**
 * Strum patterns over one bar of eighth notes: D = down strum, U = up strum, · = rest.
 * The engine plays the same rhythms.
 */
export const STRUM_OPTS: ReadonlyArray<Option<StrumPattern> & { steps: string }> = [
  { id: 'single', label: 'Single', steps: 'D·······', hint: 'One strum per chord: let it ring.' },
  { id: 'down-up', label: 'Down-up', steps: 'DUDUDUDU', hint: 'Steady eighth notes, down on the beat, up in between.' },
  { id: 'folk', label: 'Folk', steps: 'D·DU·UDU', hint: 'The campfire classic: down, down-up, up-down-up.' },
  { id: 'pop', label: 'Pop', steps: 'D··U·UDU', hint: 'Syncopated and driving, with a push before beat 3.' },
  { id: 'reggae', label: 'Reggae', steps: '··D···D·', hint: 'Short chops on beats 2 and 4: the skank. Try it with palm mute.' },
  { id: 'ballad', label: 'Ballad', steps: 'D···D·DU', hint: 'Slow and open, a fill at the end of the bar.' },
];

export const strumSteps = (p: StrumPattern): string => STRUM_OPTS.find((o) => o.id === p)?.steps ?? '';

/** Readable form of a strum pattern: "D · D U · U D U". */
export const strumText = (p: StrumPattern): string => strumSteps(p).split('').join(' ');

/** Screen-reader form: "down, rest, down, up, ...". */
export const strumSpoken = (p: StrumPattern): string =>
  strumSteps(p)
    .split('')
    .map((c) => (c === 'D' ? 'down' : c === 'U' ? 'up' : 'rest'))
    .join(', ');

export const ARP_OPTS: ReadonlyArray<Option<ArpPattern> & { contour: number[] }> = [
  { id: 'up', label: 'Up', contour: [0, 1, 2, 3], hint: 'Lowest note to highest, then again.' },
  { id: 'down', label: 'Down', contour: [3, 2, 1, 0], hint: 'Highest note to lowest.' },
  { id: 'up-down', label: 'Up-down', contour: [0, 1, 2, 3, 2, 1], hint: 'Up and back down without repeating the top note.' },
  { id: 'random', label: 'Random', contour: [1, 3, 0, 2, 3, 1], hint: 'A new order every time, always in the chord.' },
  { id: 'broken', label: 'Broken', contour: [0, 2, 1, 3], hint: 'Skips through the chord: 1-3-2-4, like a harp roll.' },
  { id: 'alberti', label: 'Alberti', contour: [0, 3, 2, 3], hint: 'Low-high-middle-high: the classical piano left hand.' },
];

export const RATE_OPTS: ReadonlyArray<Option<NoteRate> & { short: string }> = [
  { id: '1/4', label: '1/4', short: '1/4', hint: 'Quarter notes: one note per beat.' },
  { id: '1/8', label: '1/8', short: '1/8', hint: 'Eighth notes: two per beat.' },
  { id: '1/8t', label: '1/8 triplet', short: '1/8T', hint: 'Eighth-note triplets: three per beat.' },
  { id: '1/8d', label: 'Dotted 1/8', short: '1/8.', hint: 'Dotted eighths: three sixteenths long, the classic echo rhythm.' },
  { id: '1/16', label: '1/16', short: '1/16', hint: 'Sixteenth notes: four per beat.' },
  { id: '1/16t', label: '1/16 triplet', short: '1/16T', hint: 'Sixteenth triplets: six per beat, very fast.' },
];

export const rateLabel = (r: NoteRate): string => RATE_OPTS.find((o) => o.id === r)?.label ?? r;

export const BASS_OPTS: ReadonlyArray<Option<BassPattern>> = [
  { id: 'root', label: 'Root', hint: 'The chord’s root note, held: solid and simple.' },
  { id: 'root-fifth', label: 'Root-fifth', hint: 'Root then fifth, back and forth: country, waltz and march.' },
  { id: 'octave', label: 'Octave', hint: 'Root jumping an octave: disco and dance.' },
  { id: 'walking', label: 'Walking', hint: 'A note on every beat, walking to the next chord: jazz.' },
  { id: 'off', label: 'Off', hint: 'No bass line under the chords.' },
];

export const VOICING_OPTS: ReadonlyArray<Option<Voicing>> = [
  { id: 'guitar', label: 'Guitar shapes', hint: 'Real six-string chord shapes, the way a guitarist would finger them.' },
  { id: 'close', label: 'Close', hint: 'All notes packed inside one octave: tight and clear.' },
  { id: 'open', label: 'Open', hint: 'Notes spread over two octaves: wide and airy.' },
  { id: 'drop2', label: 'Drop-2', hint: 'The second-highest note dropped an octave: the jazz piano and guitar sound.' },
  { id: 'spread', label: 'Spread', hint: 'Very wide, bass far below: cinematic.' },
];

export const HARMONY_OPTS: ReadonlyArray<Option<Harmony>> = [
  { id: 'off', label: 'Off', hint: 'Single notes, no added harmony.' },
  { id: 'third-above', label: '3rd above', hint: 'A second voice a third above, in the key: sweet duet.' },
  { id: 'sixth-below', label: '6th below', hint: 'A voice a sixth below, in the key: warm and folky.' },
  { id: 'fifth-above', label: '5th above', hint: 'A fifth above: open, powerful, medieval.' },
  { id: 'octave', label: 'Octave', hint: 'The same note an octave up: bigger, brighter lead.' },
];

export const PEDAL_OPTS: ReadonlyArray<Option<SustainPedal>> = [
  { id: 'auto', label: 'Auto', hint: 'Pedal down while a chord or phrase lasts, lifted on each change: clean and connected.' },
  { id: 'hold', label: 'Hold', hint: 'Pedal held down: notes ring into each other, dreamy.' },
  { id: 'off', label: 'Off', hint: 'No pedal: every note stops when you let go.' },
];

export const CURVE_OPTS: ReadonlyArray<Option<VelocityCurve>> = [
  { id: 'soft', label: 'Soft', hint: 'Light touch: small gestures already play loud.' },
  { id: 'linear', label: 'Linear', hint: 'Loudness follows your mouth or hand one to one.' },
  { id: 'hard', label: 'Hard', hint: 'Heavy touch: open wide or raise high for full loudness. More control when quiet.' },
  { id: 'fixed', label: 'Fixed', hint: 'Every note at the same loudness, like an organ.' },
];

export const REVERB_OPTS: ReadonlyArray<Option<ReverbType>> = [
  { id: 'room', label: 'Room', hint: 'Small and close: a studio room.' },
  { id: 'hall', label: 'Hall', hint: 'A concert hall: the natural default.' },
  { id: 'plate', label: 'Plate', hint: 'Bright and dense: the classic vocal and snare sound.' },
  { id: 'cathedral', label: 'Cathedral', hint: 'Huge and long: stone walls, seconds of tail.' },
];

export const TIME_SIG_OPTS: ReadonlyArray<Option<TimeSignature>> = [
  { id: '4/4', label: '4/4', hint: 'Common time: pop, rock, almost everything.' },
  { id: '3/4', label: '3/4', hint: 'Waltz time: ONE two three.' },
  { id: '6/8', label: '6/8', hint: 'Two swaying groups of three: ballads, jigs.' },
  { id: '5/4', label: '5/4', hint: 'Odd time: 3 + 2, like “Take Five”.' },
  { id: '7/8', label: '7/8', hint: 'Odd time: 2 + 2 + 3, a limping dance feel.' },
];

/** Beats (counted pulses) per bar for the beat dots. */
export function beatsPerBar(ts: TimeSignature): number {
  return Number(ts.split('/')[0]) || 4;
}

/** Tiny velocity curve icon: input loudness (x) -> note velocity (y). Static markup. */
export function curveIcon(c: VelocityCurve): DocumentFragment {
  const paths: Record<VelocityCurve, string> = {
    soft: 'M2 18C3 8 8 3 18 2',
    linear: 'M2 18L18 2',
    hard: 'M2 18C12 17 17 12 18 2',
    fixed: 'M2 7H18',
  };
  return frag(
    `<svg class="curve-ic" viewBox="0 0 20 20" aria-hidden="true" focusable="false"><path d="M2 2V18H18" class="curve-axis"/><path d="${paths[c]}" class="curve-line"/></svg>`,
  );
}

/** Tiny arpeggio contour: dots stepping through the chord. Static markup from numbers. */
export function contourIcon(contour: readonly number[]): DocumentFragment {
  const n = contour.length;
  const pts = contour.map((v, i) => [3 + (i * 26) / Math.max(1, n - 1), 17 - v * 4.4] as const);
  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
  const dots = pts.map(([x, y]) => `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="1.9"/>`).join('');
  return frag(`<svg class="contour-ic" viewBox="0 0 32 20" aria-hidden="true" focusable="false"><polyline points="${line}"/>${dots}</svg>`);
}

// ---------------------------------------------------------------------------------------------
// Instrument awareness
// ---------------------------------------------------------------------------------------------

/** How an instrument is played, for picking the technique controls that matter. */
export type TechniqueKind = 'guitar' | 'keys' | 'legato' | 'plucked' | 'mallet' | 'organ' | 'bass';

const STRUMMED = new Set(['banjo']);
const PEDAL = new Set(['vibraphone']);

export function techniqueKind(inst: InstrumentDef | undefined): TechniqueKind {
  if (!inst) return 'legato';
  if (inst.family === 'guitar' || STRUMMED.has(inst.id)) return 'guitar';
  if (inst.family === 'keys' || PEDAL.has(inst.id)) return 'keys';
  if (inst.family === 'bass') return 'bass';
  if (inst.family === 'organ') return inst.sustained && inst.id !== 'harmonica' ? 'organ' : 'legato';
  if (inst.family === 'mallet') return 'mallet';
  return inst.sustained ? 'legato' : 'plucked';
}

export const KIND_TEXT: Record<TechniqueKind, { title: string; auto: string }> = {
  guitar: { title: 'Guitar', auto: 'Auto strums real chord shapes string by string: downstrokes low to high, upstrokes on the top strings.' },
  keys: { title: 'Keys', auto: 'Auto works the sustain pedal like a pianist: down through a chord, lifted on each change.' },
  legato: { title: 'Bowed, blown & sung', auto: 'Auto plays legato: notes connect and slide into each other with a little glide.' },
  plucked: { title: 'Plucked', auto: 'Auto lets each pluck ring out naturally, like the real instrument.' },
  mallet: { title: 'Mallets', auto: 'Auto rolls long notes with quick mallet strokes, like a real player.' },
  organ: { title: 'Organ', auto: 'Auto holds every note for as long as you play, the way an organ speaks.' },
  bass: { title: 'Bass', auto: 'Auto plays the bass like a bassist and walks its patterns between chords.' },
};

/** Which voices sound and what each plays, from the mode and the left-hand role. */
export interface VoicePlan {
  /** Instrument that plays the chords (lead in chords mode, the left-hand instrument with leftHand chords). */
  chordInst: string | null;
  /** Instrument playing single melody notes. */
  melodyInst: string | null;
  /** A bass line plays under chords (bass pattern matters). */
  bassUnderChords: boolean;
  /** Every instrument that sounds right now. */
  sounding: string[];
}

export function voicePlan(s: Settings): VoicePlan {
  if (s.mode === 'chords') return { chordInst: s.lead, melodyInst: null, bassUnderChords: true, sounding: [s.lead, s.bass] };
  const sounding = [s.lead];
  if (s.leftHand === 'bass' || s.leftHand === 'chords') sounding.push(s.bass);
  return { chordInst: s.leftHand === 'chords' ? s.bass : null, melodyInst: s.lead, bassUnderChords: s.leftHand === 'chords', sounding };
}

/** Short "how chords are played" label for the chord deck, e.g. "Folk strum", "Arp 1/16 ↑". */
export function chordPlayLabel(s: Settings): string {
  if (s.chordPlay === 'strum') return `${STRUM_OPTS.find((o) => o.id === s.strumPattern)?.label ?? ''} strum`;
  if (s.chordPlay === 'arp') {
    const r = RATE_OPTS.find((o) => o.id === s.arpRate)?.short ?? s.arpRate;
    const p = ARP_OPTS.find((o) => o.id === s.arpPattern)?.label.toLowerCase() ?? s.arpPattern;
    return `Arp ${r} ${p}`;
  }
  return 'Block chords';
}

// ---------------------------------------------------------------------------------------------
// Value formatting in musician units
// ---------------------------------------------------------------------------------------------

export const pct = (v: number): string => `${Math.round(v * 100)}%`;
export const signedDb = (v: number): string => (Math.abs(v) < 0.05 ? '0 dB' : `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(1)} dB`);
export const semis = (v: number): string => (v === 0 ? '0 st' : `${v > 0 ? '+' : '−'}${Math.abs(v)} st`);

/** Cents between a tuning and A440, e.g. 432 -> "−32 ¢". */
export function centsFrom440(hz: number): string {
  const c = Math.round(1200 * Math.log2(hz / 440));
  return c === 0 ? 'standard' : `${c > 0 ? '+' : '−'}${Math.abs(c)} ¢`;
}

/** Fields owned by the Technique section (its reset button resets exactly these). */
export const TECHNIQUE_KEYS = [
  'playStyle',
  'strumPattern',
  'arpPattern',
  'arpRate',
  'arpOctaves',
  'bassPattern',
  'voicing',
  'harmony',
  'sustainPedal',
  'palmMute',
  'glide',
  'humanize',
] as const satisfies ReadonlyArray<keyof Settings>;

/** Fields owned by the Studio tab (its reset button resets exactly these). */
export const STUDIO_KEYS = [
  'tuning',
  'transpose',
  'timeSignature',
  'swing',
  'countIn',
  'clickVolume',
  'velocityCurve',
  'attack',
  'release',
  'reverbType',
  'reverb',
  'delay',
  'delayTime',
  'delayFeedback',
  'chorus',
  'eqLow',
  'eqMid',
  'eqHigh',
  'compressor',
  'width',
] as const satisfies ReadonlyArray<keyof Settings>;

export function pickDefaults(keys: ReadonlyArray<keyof Settings>, defaults: Settings): Partial<Settings> {
  const out: Record<string, unknown> = {};
  for (const k of keys) out[k] = defaults[k];
  return out as Partial<Settings>;
}

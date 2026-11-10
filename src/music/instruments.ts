/**
 * Instrument catalog. Sampled instruments come from the FluidR3_GM soundfont (CC BY 3.0, see
 * public/samples/CREDITS.txt), processed by scripts/build-samples.mjs. Synths are built from
 * Tone.js voices and download nothing.
 *
 * This file is also imported by scripts/build-samples.mjs (Node type stripping), so it must only
 * use `import type` and plain data.
 */
import type { InstrumentDef, InstrumentFamily } from '../types';

export type SynthPreset = 'theremin' | 'analog-lead' | 'square-lead' | 'warm-pad' | 'fm-bell' | 'pluck' | 'sub-bass';

/** How the sample builder cuts each source note. */
export interface SampleSource {
  /** General MIDI program name in the soundfont, e.g. "acoustic_grand_piano". */
  gm: string;
  /** Struck/plucked: longest kept duration at the bottom and top of the range (seconds). */
  dur?: [number, number];
  /** Sustained: loop region start after the onset and its length (seconds). */
  loop?: [number, number];
}

export interface InstrumentSpec extends InstrumentDef {
  sample?: SampleSource;
  synth?: SynthPreset;
  /** Release time (seconds) when the gate closes. */
  release: number;
  /** Built-in vibrato depth 0..1 (the theremin wobbles even without raised brows). */
  vibrato?: number;
  /** Output trim in dB for balance against the other instruments. */
  trim?: number;
}

type Row = [
  id: string,
  name: string,
  family: InstrumentFamily,
  sustained: boolean,
  range: [number, number],
  color: string,
  glyph: string,
  blurb: string,
  extra: Partial<InstrumentSpec>,
];

const S = (gm: string, dur: [number, number]): Partial<InstrumentSpec> => ({ sample: { gm, dur } });
const L = (gm: string, loop: [number, number] = [0.6, 1.1]): Partial<InstrumentSpec> => ({ sample: { gm, loop } });

const ROWS: Row[] = [
  // Keys
  ['grand-piano', 'Grand Piano', 'keys', false, [33, 96], '#7dd3fc', '🎹', 'Concert grand, warm lows and bright highs', { ...S('acoustic_grand_piano', [2.6, 1.3]), release: 0.35 }],
  ['electric-piano', 'Electric Piano', 'keys', false, [36, 91], '#f0abfc', 'EP', 'Mellow tine keys with a soft bell', { ...S('electric_piano_1', [2.4, 1.3]), release: 0.3 }],
  ['harpsichord', 'Harpsichord', 'keys', false, [36, 89], '#fcd34d', '𝄞', 'Baroque plucked keys, crisp and courtly', { ...S('harpsichord', [1.8, 1.0]), release: 0.15 }],
  ['celesta', 'Celesta', 'keys', false, [60, 96], '#c4b5fd', '✦', 'Sugar-plum bells, delicate and sweet', { ...S('celesta', [1.6, 1.0]), release: 0.3 }],
  // Guitar
  ['acoustic-guitar', 'Acoustic Guitar', 'guitar', false, [40, 84], '#fbbf24', '🎸', 'Steel strings, bright campfire strum', { ...S('acoustic_guitar_steel', [2.4, 1.4]), release: 0.25 }],
  ['nylon-guitar', 'Nylon Guitar', 'guitar', false, [40, 84], '#f59e0b', '🪕', 'Classical gut strings, round and intimate', { ...S('acoustic_guitar_nylon', [2.2, 1.3]), release: 0.25 }],
  ['clean-guitar', 'Clean Electric', 'guitar', false, [40, 86], '#38bdf8', '⚡', 'Glassy clean electric, chorus-ready', { ...S('electric_guitar_clean', [2.2, 1.3]), release: 0.25 }],
  ['distortion-guitar', 'Distortion Guitar', 'guitar', false, [40, 86], '#f43f5e', '🔥', 'Saturated stack, singing sustain', { ...S('distortion_guitar', [2.4, 1.6]), release: 0.18, trim: -3 }],
  // Bass
  ['upright-bass', 'Upright Bass', 'bass', false, [28, 60], '#d6a36b', '𝄢', 'Woody acoustic jazz bass', { ...S('acoustic_bass', [2.0, 1.3]), release: 0.2 }],
  ['electric-bass', 'Electric Bass', 'bass', false, [28, 64], '#60a5fa', 'EB', 'Fingerstyle electric, warm and punchy', { ...S('electric_bass_finger', [2.2, 1.4]), release: 0.18 }],
  ['slap-bass', 'Slap Bass', 'bass', false, [28, 64], '#a3e635', 'SB', 'Popping funk slap with snap', { ...S('slap_bass_1', [1.6, 1.0]), release: 0.15 }],
  // Strings
  ['violin', 'Violin', 'strings', true, [55, 96], '#fb923c', '🎻', 'Solo violin, expressive and lyrical', { ...L('violin', [0.7, 1.1]), release: 0.3 }],
  ['cello', 'Cello', 'strings', true, [36, 76], '#ea580c', 'Vc', 'Rich, deep and singing bowed cello', { ...L('cello', [0.7, 1.1]), release: 0.35 }],
  ['string-ensemble', 'String Ensemble', 'strings', true, [36, 96], '#fdba74', '≋', 'Lush section strings, cinematic', { ...L('string_ensemble_1', [0.8, 1.2]), release: 0.6 }],
  ['pizzicato', 'Pizzicato Strings', 'strings', false, [36, 84], '#fda4af', '·', 'Plucked section strings, playful', { ...S('pizzicato_strings', [1.1, 0.7]), release: 0.12 }],
  ['harp', 'Concert Harp', 'strings', false, [36, 96], '#fde68a', '𝄐', 'Shimmering harp, gentle and airy', { ...S('orchestral_harp', [2.2, 1.3]), release: 0.4 }],
  // Voice
  ['opera-choir', 'Opera Choir', 'voice', true, [48, 84], '#e879f9', '🎤', 'Full choir singing "aah", grand and operatic', { ...L('choir_aahs', [0.7, 1.3]), release: 0.5 }],
  ['voice-oohs', 'Voice Oohs', 'voice', true, [48, 84], '#d8b4fe', 'Oo', 'Soft breathy "ooh" vocal pad', { ...L('voice_oohs', [0.7, 1.3]), release: 0.5 }],
  // Brass
  ['trumpet', 'Trumpet', 'brass', true, [54, 86], '#facc15', '🎺', 'Bright solo trumpet, bold and brassy', { ...L('trumpet', [0.5, 1.0]), release: 0.15 }],
  ['trombone', 'Trombone', 'brass', true, [40, 72], '#eab308', 'Tb', 'Warm slide trombone, smooth low brass', { ...L('trombone', [0.5, 1.0]), release: 0.18 }],
  ['french-horn', 'French Horn', 'brass', true, [41, 77], '#ca8a04', 'Hn', 'Noble horn, round and heroic', { ...L('french_horn', [0.6, 1.0]), release: 0.25 }],
  ['brass-section', 'Brass Section', 'brass', true, [40, 84], '#fde047', 'Br', 'Punchy horn section stabs', { ...L('brass_section', [0.5, 1.0]), release: 0.2 }],
  // Woodwind
  ['flute', 'Flute', 'woodwind', true, [60, 96], '#5eead4', 'Fl', 'Silver flute, airy and pure', { ...L('flute', [0.5, 1.1]), release: 0.2 }],
  ['clarinet', 'Clarinet', 'woodwind', true, [50, 89], '#2dd4bf', 'Cl', 'Woody clarinet, dark and smooth', { ...L('clarinet', [0.5, 1.0]), release: 0.18 }],
  ['oboe', 'Oboe', 'woodwind', true, [58, 91], '#14b8a6', 'Ob', 'Reedy oboe, plaintive and sweet', { ...L('oboe', [0.5, 1.0]), release: 0.18 }],
  ['alto-sax', 'Alto Sax', 'woodwind', true, [49, 81], '#f97316', '🎷', 'Smoky alto sax, late-night jazz', { ...L('alto_sax', [0.5, 1.0]), release: 0.2 }],
  ['tenor-sax', 'Tenor Sax', 'woodwind', true, [44, 75], '#c2410c', 'Ts', 'Husky tenor sax, big and soulful', { ...L('tenor_sax', [0.5, 1.0]), release: 0.2 }],
  ['pan-flute', 'Pan Flute', 'woodwind', true, [60, 96], '#99f6e4', 'Pf', 'Breathy Andean pan pipes', { ...L('pan_flute', [0.5, 1.1]), release: 0.3 }],
  // Mallet
  ['marimba', 'Marimba', 'mallet', false, [45, 96], '#fb7185', 'Ma', 'Rosewood bars, warm and woody', { ...S('marimba', [1.2, 0.6]), release: 0.15 }],
  ['vibraphone', 'Vibraphone', 'mallet', false, [53, 89], '#818cf8', 'Vb', 'Cool jazz vibes with a gentle shimmer', { ...S('vibraphone', [2.4, 1.6]), release: 0.4 }],
  ['xylophone', 'Xylophone', 'mallet', false, [65, 100], '#f472b6', 'Xy', 'Bright hard-mallet bars, cheerful', { ...S('xylophone', [0.9, 0.5]), release: 0.1 }],
  ['glockenspiel', 'Glockenspiel', 'mallet', false, [72, 105], '#e0f2fe', '🔔', 'Crystal steel bells, sparkling', { ...S('glockenspiel', [1.6, 1.0]), release: 0.4 }],
  ['music-box', 'Music Box', 'mallet', false, [60, 96], '#fbcfe8', '♪', 'Tiny wind-up comb, dreamy and nostalgic', { ...S('music_box', [1.6, 1.0]), release: 0.4 }],
  ['kalimba', 'Kalimba', 'mallet', false, [60, 91], '#bef264', 'Ka', 'Thumb piano, soft and earthy', { ...S('kalimba', [1.2, 0.7]), release: 0.2 }],
  ['steel-drums', 'Steel Drums', 'mallet', false, [52, 88], '#22d3ee', '◎', 'Caribbean steel pan, sunny and bright', { ...S('steel_drums', [1.4, 0.8]), release: 0.2 }],
  // Organ
  ['church-organ', 'Church Organ', 'organ', true, [36, 96], '#a78bfa', '⛪', 'Cathedral pipes, majestic', { ...L('church_organ', [0.6, 1.2]), release: 0.5, trim: -2 }],
  ['rock-organ', 'Rock Organ', 'organ', true, [36, 96], '#8b5cf6', 'Hm', 'Drawbar tonewheel with a growl', { ...L('rock_organ', [0.4, 1.0]), release: 0.12, trim: -2 }],
  ['accordion', 'Accordion', 'organ', true, [53, 89], '#f87171', '🪗', 'Parisian musette accordion', { ...L('accordion', [0.5, 1.0]), release: 0.15 }],
  ['harmonica', 'Harmonica', 'organ', true, [60, 89], '#94a3b8', 'Hc', 'Bluesy harp, reedy and raw', { ...L('harmonica', [0.5, 1.0]), release: 0.15 }],
  // World
  ['sitar', 'Sitar', 'world', false, [48, 84], '#f59e0b', 'Si', 'Buzzing sympathetic strings of India', { ...S('sitar', [2.4, 1.6]), release: 0.3 }],
  ['koto', 'Koto', 'world', false, [55, 91], '#fca5a5', 'Ko', 'Japanese zither, elegant and clear', { ...S('koto', [1.8, 1.1]), release: 0.25 }],
  ['shamisen', 'Shamisen', 'world', false, [50, 86], '#fecaca', 'Sh', 'Snappy three-string lute of Japan', { ...S('shamisen', [1.4, 0.9]), release: 0.15 }],
  ['banjo', 'Banjo', 'world', false, [48, 84], '#fde047', 'Bj', 'Twangy bluegrass banjo', { ...S('banjo', [1.4, 0.9]), release: 0.15 }],
  ['shakuhachi', 'Shakuhachi', 'world', true, [60, 91], '#86efac', 'Sk', 'Bamboo flute, breathy and meditative', { ...L('shakuhachi', [0.6, 1.1]), release: 0.3 }],
  // Synth (zero download)
  ['theremin', 'Theremin', 'synth', true, [48, 96], '#22d3ee', '〰', 'Eerie gliding sine with a sci-fi wobble', { synth: 'theremin', release: 0.25, vibrato: 0.22 }],
  ['analog-lead', 'Analog Lead', 'synth', true, [36, 96], '#f472b6', '⟋', 'Fat detuned saw lead with a filter bite', { synth: 'analog-lead', release: 0.2, trim: -3 }],
  ['square-lead', 'Square Lead', 'synth', true, [36, 96], '#a3e635', '⊓', 'Hollow chiptune square, retro and bold', { synth: 'square-lead', release: 0.12, trim: -5 }],
  ['warm-pad', 'Warm Pad', 'synth', true, [36, 88], '#c084fc', '◐', 'Slow-blooming analog pad, soft as fog', { synth: 'warm-pad', release: 1.2, trim: -2 }],
  ['fm-bell', 'FM Bell', 'synth', false, [48, 96], '#67e8f9', '✧', 'Glassy FM bell, crystalline', { synth: 'fm-bell', release: 1.0, trim: -2 }],
  ['pluck', 'Pluck', 'synth', false, [40, 96], '#fdba74', '⌁', 'Snappy synth pluck, tight and bright', { synth: 'pluck', release: 0.25, trim: -2 }],
  ['sub-bass', 'Sub Bass', 'synth', true, [24, 60], '#4ade80', '▁', 'Deep round sub, felt more than heard', { synth: 'sub-bass', release: 0.15 }],
];

/** Download sizes in KB, written from the build-samples report. */
const SIZE_KB: Record<string, number> = {
  'grand-piano': 338,
  'electric-piano': 285,
  'harpsichord': 218,
  'celesta': 139,
  'acoustic-guitar': 245,
  'nylon-guitar': 228,
  'clean-guitar': 242,
  'distortion-guitar': 275,
  'upright-bass': 161,
  'electric-bass': 190,
  'slap-bass': 139,
  'violin': 227,
  'cello': 212,
  'string-ensemble': 352,
  'pizzicato': 126,
  'harp': 287,
  'opera-choir': 218,
  'voice-oohs': 218,
  'trumpet': 155,
  'trombone': 155,
  'french-horn': 178,
  'brass-section': 206,
  'flute': 178,
  'clarinet': 181,
  'oboe': 155,
  'alto-sax': 155,
  'tenor-sax': 142,
  'pan-flute': 178,
  'marimba': 109,
  'vibraphone': 206,
  'xylophone': 47,
  'glockenspiel': 128,
  'music-box': 138,
  'kalimba': 70,
  'steel-drums': 74,
  'church-organ': 318,
  'rock-organ': 254,
  'accordion': 168,
  'harmonica': 142,
  'sitar': 210,
  'koto': 154,
  'shamisen': 124,
  'banjo': 113,
  'shakuhachi': 160,
};

export const INSTRUMENT_SPECS: readonly InstrumentSpec[] = ROWS.map(
  ([id, name, family, sustained, range, color, glyph, blurb, extra]): InstrumentSpec => ({
    id,
    name,
    family,
    kind: extra.synth ? 'synth' : 'sampled',
    sustained,
    range,
    sizeKB: extra.synth ? 0 : (SIZE_KB[id] ?? 0),
    color,
    glyph,
    blurb,
    release: 0.2,
    ...extra,
  }),
);

/** Public catalog (InstrumentDef fields only). */
export const INSTRUMENTS: readonly InstrumentDef[] = INSTRUMENT_SPECS.map((s) => ({
  id: s.id,
  name: s.name,
  family: s.family,
  kind: s.kind,
  sustained: s.sustained,
  range: s.range,
  sizeKB: s.sizeKB,
  color: s.color,
  glyph: s.glyph,
  blurb: s.blurb,
}));

const BY_ID = new Map(INSTRUMENT_SPECS.map((s) => [s.id, s]));

export function instrumentSpec(id: string): InstrumentSpec {
  return BY_ID.get(id) ?? INSTRUMENT_SPECS[0]!;
}

/** Sample notes for an instrument: every third semitone (C, Eb, Gb, A) covering its range. */
export function sampleNotes(range: [number, number]): number[] {
  const out: number[] = [];
  for (let m = range[0] - 1; m <= range[1] + 1; m++) if (m % 3 === 0) out.push(m);
  return out;
}

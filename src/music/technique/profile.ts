/**
 * Playing technique per instrument. With playStyle 'auto' each family plays the way a player of
 * that instrument would: guitars strum real chord shapes string by string and slide between close
 * notes, keys pedal and roll chords slightly, bowed strings / winds / voices play legato with a
 * little glide and open voicings, organs play block chords at a fixed level, mallets and harps
 * roll their chords. 'manual' applies the technique settings exactly as set.
 */
import type { Settings, SustainPedal } from '../../types';
import type { InstrumentSpec } from '../instruments';
import type { VoicingKind } from './voicing';

export type Idiom =
  | 'guitar' // steel / nylon / clean electric, banjo
  | 'power' // distortion guitar: power chords
  | 'lute' // shamisen: three strings, strummed close triads
  | 'keys' // piano, electric piano, celesta: sustain pedal
  | 'harpsichord' // no pedal, rolled chords
  | 'legato' // bowed strings, brass, woodwinds, voices, duduk, shakuhachi, harmonica
  | 'organ' // block chords, no velocity
  | 'mallet' // rolled chords
  | 'harp' // harp, koto, sitar: wide rolls
  | 'bass' // bass instruments
  | 'synth' // synths: as designed
  | 'plain'; // anything else (plucked synths, pizzicato)

export type Strike = 'block' | 'strum' | 'roll';

export interface Technique {
  readonly idiom: Idiom;
  readonly auto: boolean;
  readonly sustained: boolean;
  /** How chordPlay 'block' attacks a chord. */
  readonly strike: Strike;
  /** Gap between notes of a rolled chord, seconds. */
  readonly rollGap: number;
  readonly voicing: VoicingKind;
  /** Open guitar shapes allowed (barre-only otherwise). */
  readonly openShapes: boolean;
  /** Strings an up strum reaches (counted from the top). */
  readonly upStrings: number;
  /** Strum patterns repeat in time (plucked / struck instruments); sustained ones hold. */
  readonly repeatStrum: boolean;
  readonly palmMute: boolean;
  readonly pedal: SustainPedal;
  /** Arpeggio notes ring on instead of being damped by the next one. */
  readonly ring: boolean;
  /** Melody: close fast notes slide / hammer on instead of a fresh pick. */
  readonly slides: boolean;
  /** Melody on samples: overlapping legato crossfade. */
  readonly legato: boolean;
  /** Largest bend (semitones) of the sampler legato bend illusion, 0 = none. */
  readonly bend: number;
  /** Bend / glide time, seconds. */
  readonly glideTime: number;
  /** Synth portamento override in seconds, null = the preset's own. */
  readonly portamento: number | null;
  readonly fixedVelocity: boolean;
  readonly humanize: number;
  readonly release: number;
}

const GUITARS = new Set(['acoustic-guitar', 'nylon-guitar', 'clean-guitar', 'banjo']);
const KEYS_PEDAL = new Set(['grand-piano', 'electric-piano', 'celesta', 'vibraphone']);
const HARP_LIKE = new Set(['harp', 'koto', 'sitar']);
const SECTION = new Set(['string-ensemble', 'opera-choir', 'voice-oohs', 'brass-section']);

export function idiomOf(spec: InstrumentSpec): Idiom {
  const id = spec.id;
  if (GUITARS.has(id)) return 'guitar';
  if (id === 'distortion-guitar') return 'power';
  if (id === 'shamisen') return 'lute';
  if (id === 'harpsichord') return 'harpsichord';
  if (HARP_LIKE.has(id)) return 'harp';
  if (id === 'harmonica') return 'legato';
  switch (spec.family) {
    case 'keys':
      return 'keys';
    case 'bass':
      return 'bass';
    case 'organ':
      return 'organ';
    case 'mallet':
      return 'mallet';
    case 'synth':
      return 'synth';
    case 'guitar':
      return 'guitar';
    default:
      return spec.sustained ? 'legato' : 'plain';
  }
}

/** Resolves the technique for an instrument under the current settings. */
export function resolveTechnique(spec: InstrumentSpec, s: Settings): Technique {
  const idiom = idiomOf(spec);
  const auto = s.playStyle === 'auto';
  const sustained = spec.sustained;
  const glideTime = 0.015 + s.glide * 0.25;
  const common = {
    idiom,
    auto,
    sustained,
    upStrings: 3,
    humanize: s.humanize,
    release: spec.release,
    openShapes: true,
    fixedVelocity: false,
    glideTime,
  };
  if (!auto) {
    const plucked = !sustained;
    const pedal: SustainPedal = plucked ? s.sustainPedal : 'off';
    return {
      ...common,
      strike: 'block',
      rollGap: 0,
      voicing: s.voicing,
      upStrings: s.voicing === 'guitar' ? 4 : 3,
      repeatStrum: plucked,
      palmMute: plucked && s.palmMute,
      pedal,
      ring: pedal !== 'off',
      slides: plucked && s.glide > 0,
      legato: sustained && s.glide > 0,
      bend: sustained && s.glide > 0 ? 2 : 0,
      portamento: spec.kind === 'synth' ? s.glide * 0.3 : null,
    };
  }
  // Auto: the family idiom; an explicit non-default voicing still wins.
  const userVoicing = s.voicing !== 'close' ? s.voicing : null;
  const bendOn = s.glide > 0 ? 2 : 0;
  switch (idiom) {
    case 'guitar':
    case 'power':
      return {
        ...common,
        strike: 'strum',
        rollGap: 0,
        voicing: userVoicing ?? (idiom === 'power' ? 'power' : 'guitar'),
        upStrings: spec.id === 'banjo' ? 3 : 4,
        repeatStrum: true,
        palmMute: s.palmMute,
        pedal: 'off',
        ring: true,
        slides: true,
        legato: false,
        bend: 0,
        portamento: null,
      };
    case 'lute':
      return { ...common, strike: 'strum', rollGap: 0, voicing: userVoicing ?? 'close', repeatStrum: true, palmMute: s.palmMute, pedal: 'off', ring: true, slides: true, legato: false, bend: 0, portamento: null };
    case 'keys':
      return {
        ...common,
        strike: 'roll',
        rollGap: 0.007,
        voicing: userVoicing ?? 'close',
        repeatStrum: true,
        palmMute: false,
        pedal: KEYS_PEDAL.has(spec.id) ? s.sustainPedal : 'off',
        ring: KEYS_PEDAL.has(spec.id) && s.sustainPedal !== 'off',
        slides: false,
        legato: false,
        bend: 0,
        portamento: null,
      };
    case 'harpsichord':
      return { ...common, strike: 'roll', rollGap: 0.014, voicing: userVoicing ?? 'close', repeatStrum: true, palmMute: false, pedal: 'off', ring: false, slides: false, legato: false, bend: 0, portamento: null };
    case 'mallet': {
      const pedal = KEYS_PEDAL.has(spec.id) ? s.sustainPedal : 'off';
      return { ...common, strike: 'roll', rollGap: 0.026, voicing: userVoicing ?? 'close', repeatStrum: true, palmMute: false, pedal, ring: true, slides: false, legato: false, bend: 0, portamento: null };
    }
    case 'harp':
      return { ...common, strike: 'roll', rollGap: spec.id === 'harp' ? 0.045 : 0.035, voicing: userVoicing ?? 'spread', repeatStrum: true, palmMute: false, pedal: 'off', ring: true, slides: spec.id !== 'harp', legato: false, bend: 0, portamento: null };
    case 'legato':
      return {
        ...common,
        strike: 'block',
        rollGap: 0,
        voicing: userVoicing ?? (SECTION.has(spec.id) ? 'spread' : 'open'),
        repeatStrum: false,
        palmMute: false,
        pedal: 'off',
        ring: false,
        slides: false,
        legato: true,
        bend: bendOn,
        portamento: null,
      };
    case 'organ':
      return { ...common, strike: 'block', rollGap: 0, voicing: userVoicing ?? 'close', repeatStrum: false, palmMute: false, pedal: 'off', ring: false, slides: false, legato: true, bend: 0, portamento: null, fixedVelocity: true, humanize: 0 };
    case 'bass':
      return { ...common, strike: 'block', rollGap: 0, voicing: userVoicing ?? 'close', repeatStrum: !sustained, palmMute: !sustained && s.palmMute, pedal: 'off', ring: false, slides: !sustained, legato: sustained, bend: sustained ? bendOn : 0, portamento: null };
    case 'synth':
    case 'plain':
    default:
      // As designed: synth presets keep their own portamento and envelopes.
      return { ...common, strike: 'block', rollGap: 0, voicing: userVoicing ?? 'close', repeatStrum: !sustained, palmMute: false, pedal: 'off', ring: false, slides: false, legato: false, bend: 0, portamento: null };
  }
}

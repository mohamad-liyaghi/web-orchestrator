import type { Settings } from './types';

/** One-tap setups shown in the controls. Each is a settings patch on top of the current settings. */
export interface Preset {
  id: string;
  name: string;
  /** Short glyph for the chip. */
  glyph: string;
  description: string;
  settings: Partial<Settings>;
}

export const PRESETS: readonly Preset[] = [
  {
    id: 'grand-stage',
    name: 'Grand Stage',
    glyph: '🎹',
    description: 'Concert grand, hand volume, C major pentatonic: impossible to play a wrong note.',
    settings: { mode: 'melody', lead: 'grand-piano', leftHand: 'volume', key: 0, scale: 'major-pentatonic', groove: false, reverb: 0.35 },
  },
  {
    id: 'opera-night',
    name: 'Opera Night',
    glyph: '🎭',
    description: 'Sing with your hand: opera choir in A minor, left hand plays the chords.',
    settings: { mode: 'melody', lead: 'opera-choir', bass: 'grand-piano', leftHand: 'chords', chordPlay: 'block', key: 9, scale: 'minor', groove: false, reverb: 0.6 },
  },
  {
    id: 'theremin',
    name: 'Theremin',
    glyph: '🛸',
    description: 'The classic: continuous pitch on the right hand, volume on the left.',
    settings: { mode: 'melody', lead: 'theremin', leftHand: 'volume', scale: 'continuous', trigger: 'always', groove: false, reverb: 0.45 },
  },
  {
    id: 'campfire',
    name: 'Campfire',
    glyph: '🎸',
    description: 'Chords mode: left-hand fingers pick the chord, the guitar strums it over a soft beat.',
    settings: { mode: 'chords', lead: 'acoustic-guitar', bass: 'electric-bass', chordPlay: 'strum', trigger: 'always', key: 7, scale: 'major', groove: true, beat: 'pop', tempo: 92, reverb: 0.3 },
  },
  {
    id: 'piano-ballad',
    name: 'Piano Ballad',
    glyph: '🕯️',
    description: 'Chords mode on the grand piano, arpeggiated, in A minor. Open your mouth to play.',
    settings: { mode: 'chords', lead: 'grand-piano', bass: 'electric-bass', chordPlay: 'arp', trigger: 'mouth', key: 9, scale: 'minor', groove: false, tempo: 76, reverb: 0.5 },
  },
  {
    id: 'night-groove',
    name: 'Night Groove',
    glyph: '🌙',
    description: 'Piano lead, electric bass on the left hand, blues scale and a beat.',
    settings: { mode: 'melody', lead: 'grand-piano', bass: 'electric-bass', leftHand: 'bass', key: 2, scale: 'blues', groove: true, beat: 'lofi', tempo: 88, reverb: 0.3 },
  },
];

import type { InstrumentFamily } from '../types';

/** Display metadata per instrument family (order = order in pickers and on the landing page). */
export const FAMILIES: ReadonlyArray<{ id: InstrumentFamily; label: string; color: string }> = [
  { id: 'keys', label: 'Keys', color: '#7cc4ff' },
  { id: 'guitar', label: 'Guitars', color: '#ffb547' },
  { id: 'bass', label: 'Basses', color: '#ff6b8b' },
  { id: 'strings', label: 'Strings', color: '#ff8a5c' },
  { id: 'voice', label: 'Voices', color: '#ff3dcb' },
  { id: 'brass', label: 'Brass', color: '#ffd23f' },
  { id: 'woodwind', label: 'Winds', color: '#6bffb8' },
  { id: 'mallet', label: 'Mallets', color: '#3cf2ff' },
  { id: 'world', label: 'World', color: '#ff9f43' },
  { id: 'organ', label: 'Organs', color: '#b48cff' },
  { id: 'synth', label: 'Synths', color: '#8b5cf6' },
];

export function familyMeta(id: InstrumentFamily): { label: string; color: string } {
  return FAMILIES.find((f) => f.id === id) ?? { label: id, color: '#3cf2ff' };
}

/** Showcase on the landing page (the landing renders before the engine catalog is needed). */
export const SHOWCASE: ReadonlyArray<{ name: string; family: InstrumentFamily }> = [
  { name: 'Grand Piano', family: 'keys' },
  { name: 'Opera Choir', family: 'voice' },
  { name: 'Nylon Guitar', family: 'guitar' },
  { name: 'Cello', family: 'strings' },
  { name: 'Theremin', family: 'synth' },
  { name: 'Electric Bass', family: 'bass' },
  { name: 'French Horn', family: 'brass' },
  { name: 'Flute', family: 'woodwind' },
  { name: 'Marimba', family: 'mallet' },
  { name: 'Sitar', family: 'world' },
  { name: 'Cathedral Organ', family: 'organ' },
  { name: 'Electric Piano', family: 'keys' },
  { name: 'Violin', family: 'strings' },
  { name: 'Overdrive Guitar', family: 'guitar' },
  { name: 'Trumpet', family: 'brass' },
  { name: 'Alto Sax', family: 'woodwind' },
  { name: 'Vibraphone', family: 'mallet' },
  { name: 'Koto', family: 'world' },
  { name: 'Upright Bass', family: 'bass' },
  { name: 'String Ensemble', family: 'strings' },
  { name: 'Analog Lead', family: 'synth' },
  { name: 'Kalimba', family: 'world' },
  { name: 'Clarinet', family: 'woodwind' },
  { name: 'Glass Pad', family: 'synth' },
];

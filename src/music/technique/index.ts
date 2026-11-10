/** Playing techniques: how each instrument family performs notes and chords. */
export { resolveTechnique, idiomOf, type Technique, type Idiom, type Strike } from './profile';
export { MelodyPerformer, type HarmonyFn } from './melody';
export { voiceFor, soundingChord, type VoicingKind, type VoicingRequest } from './voicing';
export { guitarShape, powerShape, fitShape, STRINGS, type GuitarShape } from './guitar';
export { harmonyNote } from './harmony';
export * from './rhythm';

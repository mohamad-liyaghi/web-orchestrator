/**
 * Music module public API: Tone.js engine, instrument catalog, scales, gesture -> note mapping,
 * chord player, backing groove and recorder.
 */
import type { MusicEngine } from '../types';
import { createEngine } from './engine';

export function createMusicEngine(): MusicEngine {
  return createEngine();
}

export { INSTRUMENTS } from './instruments';
export { SCALES } from './theory';

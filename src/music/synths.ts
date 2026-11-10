/**
 * Zero-download synth voices. Each preset builds one monophonic Tone voice; the synth player keeps
 * a small pool of them for chords and overlapping plucks.
 */
import { FMSynth, MonoSynth, Synth } from 'tone/build/esm/classes.js';
import type { SynthPreset } from './instruments';

export type MonoVoice = Synth | MonoSynth | FMSynth;

export function createSynthVoice(preset: SynthPreset): MonoVoice {
  switch (preset) {
    case 'theremin':
      return new Synth({
        oscillator: { type: 'sine' },
        envelope: { attack: 0.06, decay: 0.1, sustain: 1, release: 0.25 },
        portamento: 0.07,
      });
    case 'analog-lead':
      return new MonoSynth({
        oscillator: { type: 'fatsawtooth', count: 2, spread: 18 },
        envelope: { attack: 0.01, decay: 0.2, sustain: 0.85, release: 0.2 },
        filter: { type: 'lowpass', rolloff: -24, Q: 2 },
        filterEnvelope: { attack: 0.005, decay: 0.35, sustain: 0.45, release: 0.3, baseFrequency: 420, octaves: 3.6 },
        portamento: 0.035,
      });
    case 'square-lead':
      return new Synth({
        oscillator: { type: 'square' },
        envelope: { attack: 0.005, decay: 0.1, sustain: 0.8, release: 0.12 },
        portamento: 0.02,
      });
    case 'warm-pad':
      return new MonoSynth({
        oscillator: { type: 'fatsawtooth', count: 3, spread: 28 },
        envelope: { attack: 0.45, decay: 0.6, sustain: 0.85, release: 1.2 },
        filter: { type: 'lowpass', rolloff: -12, Q: 0.6 },
        filterEnvelope: { attack: 0.8, decay: 1.2, sustain: 0.6, release: 1.2, baseFrequency: 380, octaves: 2.2 },
        portamento: 0.12,
      });
    case 'fm-bell':
      return new FMSynth({
        harmonicity: 3.01,
        modulationIndex: 11,
        oscillator: { type: 'sine' },
        envelope: { attack: 0.002, decay: 1.6, sustain: 0, release: 1.0 },
        modulation: { type: 'sine' },
        modulationEnvelope: { attack: 0.002, decay: 0.5, sustain: 0.1, release: 0.6 },
      });
    case 'pluck':
      return new MonoSynth({
        oscillator: { type: 'sawtooth' },
        envelope: { attack: 0.002, decay: 0.35, sustain: 0, release: 0.25 },
        filter: { type: 'lowpass', rolloff: -24, Q: 1.5 },
        filterEnvelope: { attack: 0.001, decay: 0.18, sustain: 0, release: 0.2, baseFrequency: 300, octaves: 4.5 },
      });
    case 'sub-bass':
      return new MonoSynth({
        oscillator: { type: 'triangle' },
        envelope: { attack: 0.012, decay: 0.2, sustain: 0.95, release: 0.15 },
        filter: { type: 'lowpass', rolloff: -24, Q: 0.7 },
        filterEnvelope: { attack: 0.01, decay: 0.2, sustain: 1, release: 0.2, baseFrequency: 220, octaves: 1.5 },
        portamento: 0.04,
      });
  }
}

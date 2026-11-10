import type { LeftHandRole, ScaleId, Settings, TriggerMode } from './types';
import { clamp } from './geometry';

export const DEFAULT_SETTINGS: Settings = {
  lead: 'grand-piano',
  bass: 'electric-bass',
  leftHand: 'volume',
  key: 0,
  scale: 'major-pentatonic',
  octave: 0,
  span: 15,
  trigger: 'mouth',
  groove: false,
  tempo: 96,
  reverb: 0.35,
  volume: 0.8,
  skeleton: true,
  lanes: true,
};

const STORAGE_KEY = 'orchestrator.settings.v1';
const SCALES: readonly ScaleId[] = [
  'major',
  'minor',
  'major-pentatonic',
  'minor-pentatonic',
  'blues',
  'dorian',
  'mixolydian',
  'harmonic-minor',
  'japanese',
  'chromatic',
  'continuous',
];
const TRIGGERS: readonly TriggerMode[] = ['mouth', 'pinch', 'always'];
const LEFT_HAND: readonly LeftHandRole[] = ['volume', 'bass', 'off'];

const num = (v: unknown, fallback: number, lo: number, hi: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? clamp(v, lo, hi) : fallback;
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback);

/** Coerce anything (stored JSON, a UI patch) into a valid Settings object. */
export function sanitizeSettings(raw: unknown, instrumentIds: readonly string[]): Settings {
  const d = DEFAULT_SETTINGS;
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const inst = (v: unknown, fallback: string): string =>
    typeof v === 'string' && instrumentIds.includes(v) ? v : fallback;
  return {
    lead: inst(r.lead, d.lead),
    bass: inst(r.bass, d.bass),
    leftHand: LEFT_HAND.includes(r.leftHand as LeftHandRole) ? (r.leftHand as LeftHandRole) : d.leftHand,
    key: Math.round(num(r.key, d.key, 0, 11)),
    scale: SCALES.includes(r.scale as ScaleId) ? (r.scale as ScaleId) : d.scale,
    octave: Math.round(num(r.octave, d.octave, -2, 2)),
    span: Math.round(num(r.span, d.span, 8, 24)),
    trigger: TRIGGERS.includes(r.trigger as TriggerMode) ? (r.trigger as TriggerMode) : d.trigger,
    groove: bool(r.groove, d.groove),
    tempo: Math.round(num(r.tempo, d.tempo, 60, 160)),
    reverb: num(r.reverb, d.reverb, 0, 1),
    volume: num(r.volume, d.volume, 0, 1),
    skeleton: bool(r.skeleton, d.skeleton),
    lanes: bool(r.lanes, d.lanes),
  };
}

export function loadSettings(instrumentIds: readonly string[]): Settings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return sanitizeSettings(raw ? JSON.parse(raw) : null, instrumentIds);
  } catch {
    return sanitizeSettings(null, instrumentIds);
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {
    /* private mode / storage blocked: settings just won't persist */
  }
}

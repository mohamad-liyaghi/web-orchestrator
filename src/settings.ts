import type { ActionGesture, GestureAction, LeftHandRole, ScaleId, Settings, TriggerMode } from './types';
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
  sensitivity: 0.5,
  groove: false,
  tempo: 96,
  reverb: 0.35,
  volume: 0.8,
  skeleton: true,
  lanes: true,
  lowPower: false,
  gesturesEnabled: true,
  gestures: {
    fist: 'mute',
    peace: 'next-instrument',
    'thumbs-up': 'toggle-groove',
    rock: 'octave-up',
  },
};

export const ACTION_GESTURES: readonly ActionGesture[] = ['fist', 'peace', 'thumbs-up', 'rock'];
export const GESTURE_ACTIONS: readonly GestureAction[] = [
  'none',
  'mute',
  'octave-up',
  'octave-down',
  'next-instrument',
  'prev-instrument',
  'next-preset',
  'next-scale',
  'toggle-groove',
  'toggle-record',
];

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
const LEFT_HAND: readonly LeftHandRole[] = ['volume', 'bass', 'chords', 'off'];

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
    sensitivity: num(r.sensitivity, d.sensitivity, 0, 1),
    groove: bool(r.groove, d.groove),
    tempo: Math.round(num(r.tempo, d.tempo, 60, 160)),
    reverb: num(r.reverb, d.reverb, 0, 1),
    volume: num(r.volume, d.volume, 0, 1),
    skeleton: bool(r.skeleton, d.skeleton),
    lanes: bool(r.lanes, d.lanes),
    lowPower: bool(r.lowPower, d.lowPower),
    gesturesEnabled: bool(r.gesturesEnabled, d.gesturesEnabled),
    gestures: sanitizeGestures(r.gestures),
  };
}

function sanitizeGestures(raw: unknown): Settings['gestures'] {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out = { ...DEFAULT_SETTINGS.gestures };
  for (const g of ACTION_GESTURES) {
    const v = r[g];
    if (GESTURE_ACTIONS.includes(v as GestureAction)) out[g] = v as GestureAction;
  }
  return out;
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

/** Mouth gate thresholds for a sensitivity 0..1: [open above, close below] on FaceState.mouthOpen. */
export function mouthThresholds(sensitivity: number): [open: number, close: number] {
  const open = 0.36 - 0.26 * clamp(sensitivity, 0, 1); // 0.36 (strict) .. 0.10 (very sensitive); 0.5 -> 0.23
  return [open, open * 0.55];
}

// ---------------------------------------------------------------------------------------------
// Shareable setup links: settings live in the URL hash, e.g. #lead=theremin&scale=minor&key=9
// ---------------------------------------------------------------------------------------------

const SHARE_KEYS: readonly (keyof Settings)[] = [
  'lead',
  'bass',
  'leftHand',
  'key',
  'scale',
  'octave',
  'span',
  'trigger',
  'groove',
  'tempo',
  'reverb',
];

/** URL (current page, no query) that reproduces the musical part of these settings. */
export function shareUrl(s: Settings): string {
  const params = new URLSearchParams();
  for (const k of SHARE_KEYS) params.set(k, String(s[k]));
  return `${location.origin}${location.pathname}#${params.toString()}`;
}

/** Settings patch encoded in the URL hash (unknown keys and bad values are ignored later by sanitizeSettings). */
export function settingsFromHash(hash: string = location.hash): Partial<Settings> | null {
  const raw = hash.replace(/^#/, '');
  if (!raw.includes('=')) return null;
  const params = new URLSearchParams(raw);
  const out: Record<string, unknown> = {};
  for (const k of SHARE_KEYS) {
    const v = params.get(k);
    if (v === null) continue;
    if (v === 'true' || v === 'false') out[k] = v === 'true';
    else if (v.trim() !== '' && Number.isFinite(Number(v))) out[k] = Number(v);
    else out[k] = v;
  }
  return Object.keys(out).length ? (out as Partial<Settings>) : null;
}

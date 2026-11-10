import type {
  ActionGesture,
  GestureAction,
  GestureEvent,
  InstrumentDef,
  ScaleDef,
  Settings,
  TrackingFrame,
} from './types';
import { ACTION_GESTURES } from './settings';
import { PRESETS } from './presets';
import { clamp } from './geometry';

/** How long a gesture must be held before its action fires. */
const HOLD_MS = 500;
/** Minimum time between two fired actions. */
const COOLDOWN_MS = 900;

export const GESTURE_GLYPH: Record<ActionGesture, string> = {
  fist: '✊',
  peace: '✌️',
  'thumbs-up': '👍',
  rock: '🤘',
};

export const ACTION_LABEL: Record<GestureAction, string> = {
  none: 'Nothing',
  mute: 'Mute (hold)',
  'octave-up': 'Octave up',
  'octave-down': 'Octave down',
  'next-instrument': 'Next instrument',
  'prev-instrument': 'Previous instrument',
  'next-preset': 'Next preset',
  'next-scale': 'Next scale',
  'toggle-groove': 'Beat on / off',
  'toggle-record': 'Start / stop recording',
};

interface Hold {
  gesture: ActionGesture;
  since: number;
  fired: boolean;
}

export interface GestureDeps {
  getSettings(): Settings;
  apply(patch: Partial<Settings>): void;
  toggleRecording(): void;
  isRecording(): boolean;
  instruments: readonly InstrumentDef[];
  scales: readonly ScaleDef[];
}

/**
 * Turns held hand poses into one-shot actions (octave, instrument, preset, scale, beat, record).
 * 'mute' is not handled here: it is a held state the music engine applies per voice.
 */
export class GestureController {
  last: GestureEvent | null = null;
  pending: { handId: number; gesture: ActionGesture; progress: number } | null = null;
  private readonly holds = new Map<number, Hold>();
  private lastFire = -Infinity;
  private presetIndex = -1;

  constructor(private readonly deps: GestureDeps) {}

  reset(): void {
    this.holds.clear();
    this.pending = null;
  }

  update(frame: TrackingFrame): void {
    const s = this.deps.getSettings();
    this.pending = null;
    if (!s.gesturesEnabled) {
      this.holds.clear();
      return;
    }
    const seen = new Set<number>();
    const hands = frame.hands;
    hands.forEach((hand, i) => {
      seen.add(hand.id);
      // In chords mode the left hand's finger count picks chords: its poses are not commands.
      const isRoleHand = hands.length === 2 && i === 0;
      if (isRoleHand && s.leftHand === 'chords') {
        this.holds.delete(hand.id);
        return;
      }
      const g = hand.gesture;
      const action = isActionGesture(g) ? s.gestures[g] : 'none';
      if (!isActionGesture(g) || action === 'none' || action === 'mute') {
        this.holds.delete(hand.id);
        return;
      }
      let hold = this.holds.get(hand.id);
      if (!hold || hold.gesture !== g) {
        hold = { gesture: g, since: frame.t, fired: false };
        this.holds.set(hand.id, hold);
      }
      if (hold.fired) return;
      const progress = clamp((frame.t - hold.since) / HOLD_MS, 0, 1);
      if (!this.pending || progress > this.pending.progress) this.pending = { handId: hand.id, gesture: g, progress };
      if (progress >= 1 && frame.t - this.lastFire >= COOLDOWN_MS) {
        hold.fired = true;
        this.lastFire = frame.t;
        this.pending = null;
        this.last = { gesture: g, action, label: this.run(action, s), t: frame.t };
      }
    });
    for (const id of this.holds.keys()) if (!seen.has(id)) this.holds.delete(id);
  }

  private run(action: GestureAction, s: Settings): string {
    const { instruments, scales } = this.deps;
    switch (action) {
      case 'octave-up':
      case 'octave-down': {
        const octave = clamp(s.octave + (action === 'octave-up' ? 1 : -1), -2, 2);
        this.deps.apply({ octave });
        return `Octave ${octave > 0 ? '+' : ''}${octave}`;
      }
      case 'next-instrument':
      case 'prev-instrument': {
        if (!instruments.length) return 'No instruments';
        const i = instruments.findIndex((x) => x.id === s.lead);
        const step = action === 'next-instrument' ? 1 : -1;
        const next = instruments[(i + step + instruments.length) % instruments.length]!;
        this.deps.apply({ lead: next.id });
        return next.name;
      }
      case 'next-preset': {
        if (!PRESETS.length) return 'No presets';
        this.presetIndex = (this.presetIndex + 1) % PRESETS.length;
        const p = PRESETS[this.presetIndex]!;
        this.deps.apply(p.settings);
        return `Preset: ${p.name}`;
      }
      case 'next-scale': {
        if (!scales.length) return 'No scales';
        const i = scales.findIndex((x) => x.id === s.scale);
        const next = scales[(i + 1) % scales.length]!;
        this.deps.apply({ scale: next.id });
        return `Scale: ${next.name}`;
      }
      case 'toggle-groove':
        this.deps.apply({ groove: !s.groove });
        return s.groove ? 'Beat off' : 'Beat on';
      case 'toggle-record': {
        const was = this.deps.isRecording();
        this.deps.toggleRecording();
        return was ? 'Recording saved' : 'Recording…';
      }
      default:
        return ACTION_LABEL[action];
    }
  }
}

function isActionGesture(g: string): g is ActionGesture {
  return (ACTION_GESTURES as readonly string[]).includes(g);
}

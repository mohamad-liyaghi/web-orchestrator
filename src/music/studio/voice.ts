/**
 * Studio-wide shaping every instrument player reads: concert pitch (A4 in Hz), transpose,
 * attack / release scaling and the expression -> velocity curve.
 *
 * Players join on creation and leave on dispose (a bounded set: live voices + looper tracks). A
 * tuning change glides every held note to the new pitch; envelope changes apply to the next
 * attack / release of every voice, so nothing retriggers.
 */
import type { VelocityCurve } from '../../types';

/** A player the studio can retune and reshape while it plays. */
export interface StudioMember {
  /** Glide every held note to the current concert pitch, starting at `time`. */
  retune(time: number): void;
  /** Re-read attack / release scaling (applies to the next attack / release). */
  reshape(): void;
}

/** Cents between a concert pitch and A440. */
export function tuningCents(a4: number): number {
  return 1200 * Math.log2(Math.max(1, a4) / 440);
}

/** Smoothing of a retune glide (s). */
const RETUNE_TAU = 0.03;
/** Attack added at attack = 1 (s): a slow swell. */
const MAX_EXTRA_ATTACK = 1.6;
/** Releases shorter than this are technical (note changes, voice steals) and never stretched. */
const MIN_SCALED_RELEASE = 0.1;

class StudioVoice {
  /** A4 in Hz. */
  tuning = 440;
  /** Global detune of everything that sounds, in cents. */
  cents = 0;
  /** Semitones added to every sounding note. */
  transpose = 0;
  /** Attack scale 0..1 (0 = instrument default). */
  attack = 0;
  /** Release scale 0..1 (0.5 = instrument default). */
  release = 0.5;
  curve: VelocityCurve = 'linear';
  private readonly members = new Set<StudioMember>();

  join(m: StudioMember): void {
    this.members.add(m);
  }

  leave(m: StudioMember): void {
    this.members.delete(m);
  }

  get memberCount(): number {
    return this.members.size;
  }

  /** Applies the studio settings; returns true when anything changed. */
  set(tuning: number, transpose: number, attack: number, release: number, curve: VelocityCurve, time: number): boolean {
    let changed = false;
    if (tuning !== this.tuning) {
      this.tuning = tuning;
      this.cents = tuningCents(tuning);
      for (const m of this.members) m.retune(time);
      changed = true;
    }
    if (attack !== this.attack || release !== this.release) {
      this.attack = attack;
      this.release = release;
      for (const m of this.members) m.reshape();
      changed = true;
    }
    if (transpose !== this.transpose || curve !== this.curve) changed = true;
    this.transpose = transpose;
    this.curve = curve;
    return changed;
  }

  /** Attack time for an instrument's own attack `base` (s). */
  attackTime(base: number): number {
    const a = this.attack;
    return a <= 0 ? base : base + a * a * MAX_EXTRA_ATTACK;
  }

  /** Release multiplier: 0.25x at 0, 1x at 0.5, 4x at 1. */
  get releaseFactor(): number {
    return Math.pow(16, this.release - 0.5);
  }

  /** Release time for a requested release `r` (s); short technical releases stay as they are. */
  releaseTime(r: number): number {
    return r < MIN_SCALED_RELEASE ? r : Math.max(MIN_SCALED_RELEASE * 0.5, r * this.releaseFactor);
  }

  /** Smoothing time constant of a retune glide (s). */
  get retuneTau(): number {
    return RETUNE_TAU;
  }

  /** Frequency (Hz) a written MIDI note sounds at: transposed, at the concert pitch. */
  hz(midi: number): number {
    return this.tuning * Math.pow(2, (midi + this.transpose - 69) / 12);
  }

  /**
   * Expression 0..1 (mouth openness above the gate) -> note velocity / breath level.
   * 'linear' is the classic response; 'soft' gives more output for a little effort, 'hard' needs
   * a wide-open mouth for full level, 'fixed' ignores expression.
   */
  velocity(x: number): number {
    const v = x < 0 ? 0 : x > 1 ? 1 : x;
    switch (this.curve) {
      case 'soft':
        return 0.3 + 0.7 * Math.pow(v, 0.45);
      case 'hard':
        return 0.12 + 0.88 * Math.pow(v, 1.7);
      case 'fixed':
        return 0.8;
      default:
        return 0.22 + 0.78 * Math.pow(v, 0.8);
    }
  }
}

/** The one studio voice shaping every player. */
export const studioVoice = new StudioVoice();

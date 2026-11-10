/**
 * Time signatures and swing on the engine's sixteenth grid.
 *
 * The engine's clock ticks every sixteenth. A meter says how many sixteenths make a bar, which
 * unit is "the beat" (a quarter in x/4, an eighth in x/8) and where the accented groups start
 * (5/4 = 3+2 beats, 7/8 = 2+2+3 eighths). Bars are counted from an origin step, so the meter can
 * change on a bar line while the clock keeps running.
 */
import type { TimeSignature } from '../../types';

export interface Meter {
  readonly id: TimeSignature;
  /** Sixteenths per bar. */
  readonly steps: number;
  /** Sixteenths per counted beat (4 = quarter, 2 = eighth). */
  readonly beatSteps: number;
  /** Counted beats per bar (bar:beat readouts, count-ins). */
  readonly beats: number;
  /** Bar-relative sixteenth of every accented group start; the first is the downbeat. */
  readonly groups: readonly number[];
  /** Compound / eighth-based meter: swing applies to sixteenths, beat styles use eighth pulses. */
  readonly eighths: boolean;
  /** [numerator, denominator] for the Transport. */
  readonly signature: readonly [number, number];
}

export const METERS: Record<TimeSignature, Meter> = {
  '4/4': { id: '4/4', steps: 16, beatSteps: 4, beats: 4, groups: [0], eighths: false, signature: [4, 4] },
  '3/4': { id: '3/4', steps: 12, beatSteps: 4, beats: 3, groups: [0], eighths: false, signature: [3, 4] },
  '6/8': { id: '6/8', steps: 12, beatSteps: 2, beats: 6, groups: [0, 6], eighths: true, signature: [6, 8] },
  '5/4': { id: '5/4', steps: 20, beatSteps: 4, beats: 5, groups: [0, 12], eighths: false, signature: [5, 4] },
  '7/8': { id: '7/8', steps: 14, beatSteps: 2, beats: 7, groups: [0, 4, 8], eighths: true, signature: [7, 8] },
};

export function meterOf(id: TimeSignature): Meter {
  return METERS[id] ?? METERS['4/4'];
}

/** Settings swing range: 0.6 means a full triplet shuffle. */
export const SWING_MAX = 0.6;

/**
 * How late a grid sixteenth sounds, in sixteenths, for a swing amount 0..0.6.
 *
 * Eighth swing (the default) stretches the first eighth of every beat and shortens the second:
 * at the maximum the off-beat eighth lands on the last triplet (2/3 of a sixteenth late), and the
 * sixteenths in between move proportionally. Sixteenth swing (house, and eighth-based meters, which
 * already have a lilt of their own) delays every off-sixteenth by up to a third of a sixteenth.
 */
export function swingSteps(barStep: number, amount: number, sixteenths: boolean): number {
  if (amount <= 0) return 0;
  const k = Math.min(1, amount / SWING_MAX);
  if (sixteenths) return barStep % 2 ? k / 3 : 0;
  const d = (k * 2) / 3;
  switch (((barStep % 4) + 4) % 4) {
    case 1:
    case 3:
      return d / 2;
    case 2:
      return d;
    default:
      return 0;
  }
}

/**
 * The bar grid the engine runs: current meter, the step where its bars start, and a meter change
 * waiting for the next bar line of the old one.
 */
export class MeterClock {
  meter: Meter = METERS['4/4'];
  /** Clock step (sixteenths since the Transport started) of a downbeat of the current meter. */
  origin = 0;
  private pending: Meter | null = null;

  /** Asks for a meter. Applies at once when the clock is idle, else on the next bar line. */
  request(id: TimeSignature, clockRunning: boolean): boolean {
    const next = meterOf(id);
    if (!clockRunning) {
      this.pending = null;
      const changed = next !== this.meter;
      this.meter = next;
      this.origin = 0;
      return changed;
    }
    this.pending = next === this.meter ? null : next;
    return false;
  }

  /** The clock (re)started at step 0. */
  restart(): void {
    if (this.pending) this.meter = this.pending;
    this.pending = null;
    this.origin = 0;
  }

  /** Called for every grid step in order: returns true when a pending meter took over here. */
  advance(step: number): boolean {
    if (!this.pending || this.barStep(step) !== 0) return false;
    this.meter = this.pending;
    this.pending = null;
    this.origin = step;
    return true;
  }

  /** Sixteenth inside the bar, 0..steps-1. */
  barStep(step: number): number {
    const n = this.meter.steps;
    return (((step - this.origin) % n) + n) % n;
  }

  /** 1-based bar and beat for a (fractional) clock step, from the origin. */
  position(step: number, out: { bar: number; beat: number }): void {
    const m = this.meter;
    const rel = Math.max(0, step - this.origin);
    const bar = Math.floor(rel / m.steps);
    out.bar = bar + 1;
    out.beat = Math.min(m.beats, Math.floor((rel - bar * m.steps) / m.beatSteps) + 1);
  }
}

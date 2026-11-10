/**
 * Reverb impulse responses, synthesized (nothing to download): filtered noise with an exponential
 * envelope, a pre-delay and a low-pass that closes as the tail decays (damping), plus a few early
 * reflections for the rooms that have walls you can hear.
 *
 * Building a long impulse costs a few milliseconds, so it is done in slices between frames
 * (never inside a tracking frame) and the last two are cached.
 */
import type { ReverbType } from '../../types';

export interface ReverbPreset {
  /** Tail length (s). */
  seconds: number;
  /** Envelope exponent: (1 - t)^decay. Higher = faster fall-off. */
  decay: number;
  /** Silence before the tail (s). */
  preDelay: number;
  /** One-pole low-pass coefficient at the start of the tail (1 = open) ... */
  bright: number;
  /** ... and how much it closes by the end (damping). */
  damping: number;
  /** Early reflections: [time (s), gain] pairs, alternating sides. */
  early: ReadonlyArray<readonly [number, number]>;
}

export const REVERB_PRESETS: Record<ReverbType, ReverbPreset> = {
  room: { seconds: 0.9, decay: 3.4, preDelay: 0.004, bright: 0.5, damping: 0.38, early: [[0.011, 0.5], [0.017, 0.42], [0.026, 0.33], [0.034, 0.25]] },
  // The engine's original reverb: keep it exactly (it is the default).
  hall: { seconds: 2.6, decay: 2.6, preDelay: 0.012, bright: 0.6, damping: 0.45, early: [] },
  plate: { seconds: 1.9, decay: 2.3, preDelay: 0, bright: 0.88, damping: 0.3, early: [] },
  cathedral: { seconds: 5.2, decay: 2.1, preDelay: 0.035, bright: 0.52, damping: 0.42, early: [[0.042, 0.32], [0.067, 0.27], [0.093, 0.22], [0.121, 0.16]] },
};

/** The cheap reverb of low-power mode: short whatever the type (the original low-power hall). */
const LOW_POWER: ReverbPreset = { seconds: 1.3, decay: 3.2, preDelay: 0.012, bright: 0.6, damping: 0.45, early: [] };

export function presetFor(type: ReverbType, lowPower: boolean): ReverbPreset {
  if (!lowPower) return REVERB_PRESETS[type] ?? REVERB_PRESETS.hall;
  const p = REVERB_PRESETS[type] ?? REVERB_PRESETS.hall;
  return { ...LOW_POWER, preDelay: Math.min(p.preDelay, 0.02), bright: p.bright, damping: p.damping };
}

interface BufferFactory {
  readonly sampleRate: number;
  createBuffer(channels: number, length: number, rate: number): AudioBuffer;
}

/** Frames computed per slice (~3 ms of work). */
const SLICE = 24_000;

/**
 * Fills an impulse response slice by slice. `step()` does one slice and returns true when done;
 * `buffer` is complete after that.
 */
export class ImpulseBuilder {
  readonly buffer: AudioBuffer;
  private readonly lp = [0, 0];
  private readonly seed = [0x9e3779b9, 0x85ebca6b];
  private pos = 0;
  private readonly pre: number;
  private readonly len: number;

  constructor(
    ctx: BufferFactory,
    readonly preset: ReverbPreset,
  ) {
    const rate = ctx.sampleRate;
    this.len = Math.max(2, Math.floor(rate * preset.seconds));
    this.pre = Math.min(this.len - 1, Math.floor(rate * preset.preDelay));
    this.buffer = ctx.createBuffer(2, this.len, rate);
    this.pos = this.pre;
  }

  get done(): boolean {
    return this.pos >= this.len;
  }

  step(): boolean {
    if (this.done) return true;
    const p = this.preset;
    const end = Math.min(this.len, this.pos + SLICE);
    const span = this.len - this.pre;
    for (let c = 0; c < 2; c++) {
      const d = this.buffer.getChannelData(c);
      let lp = this.lp[c]!;
      let s = this.seed[c]! | 0;
      for (let i = this.pos; i < end; i++) {
        const t = (i - this.pre) / span;
        // xorshift32 noise in -1..1 (deterministic, decorrelated per channel)
        s ^= s << 13;
        s ^= s >>> 17;
        s ^= s << 5;
        const n = (s >>> 0) / 2147483648 - 1;
        lp += (n - lp) * (p.bright - p.damping * t);
        d[i] = lp * Math.pow(1 - t, p.decay);
      }
      this.lp[c] = lp;
      this.seed[c] = s;
    }
    if (end === this.len && this.pos < this.len) this.addEarly();
    this.pos = end;
    return this.done;
  }

  /** Builds the whole impulse at once (tests, offline rendering). */
  finish(): AudioBuffer {
    while (!this.step()) {
      /* keep going */
    }
    return this.buffer;
  }

  private addEarly(): void {
    const rate = this.buffer.sampleRate;
    const p = this.preset;
    // Scale reflections to the tail's opening level so they sit inside it after normalization.
    const ref = 0.35;
    p.early.forEach(([time, gain], k) => {
      const i = Math.floor(time * rate);
      if (i <= 0 || i >= this.len - 4) return;
      const c = k % 2;
      const d = this.buffer.getChannelData(c);
      const o = this.buffer.getChannelData(1 - c);
      d[i]! += gain * ref;
      d[i + 1]! += gain * ref * 0.5;
      o[i + 3]! += gain * ref * 0.6;
    });
  }
}

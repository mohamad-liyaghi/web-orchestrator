/**
 * One Euro filter (Casiez, Roussel, Vogel, CHI 2012) over a fixed number of channels that share
 * one clock. Low cutoff when the signal is still (kills jitter), rising with speed (no lag on fast
 * moves). State lives in typed arrays: filtering allocates nothing.
 */
export interface OneEuroParams {
  /** Cutoff in Hz at zero speed. Lower = smoother at rest, more lag. */
  minCutoff: number;
  /** Cutoff increase per unit/s of speed. Higher = less lag when moving. */
  beta: number;
  /** Cutoff for the speed estimate, Hz. */
  dCutoff: number;
}

const TWO_PI = Math.PI * 2;

function alpha(cutoff: number, dt: number): number {
  const tau = 1 / (TWO_PI * cutoff);
  return 1 / (1 + tau / dt);
}

export class OneEuroBank {
  private readonly value: Float64Array;
  private readonly speed: Float64Array;
  private lastT = 0;
  private primed = false;

  constructor(
    readonly size: number,
    private readonly params: OneEuroParams,
  ) {
    this.value = new Float64Array(size);
    this.speed = new Float64Array(size);
  }

  /** Forget the history: the next sample passes through unfiltered. */
  reset(): void {
    this.primed = false;
  }

  /**
   * Filters `size` samples from `src` into `dst` (may be the same array).
   * @param tMs timestamp in milliseconds
   */
  filter(src: ArrayLike<number>, dst: Float32Array, tMs: number): void {
    const n = this.size;
    const value = this.value;
    const speed = this.speed;
    if (!this.primed || tMs <= this.lastT) {
      // First sample (or a clock glitch): start from the measurement.
      if (!this.primed) {
        for (let i = 0; i < n; i++) {
          const x = src[i] ?? 0;
          value[i] = x;
          speed[i] = 0;
          dst[i] = x;
        }
      } else {
        for (let i = 0; i < n; i++) dst[i] = value[i] ?? 0;
      }
      this.primed = true;
      this.lastT = tMs;
      return;
    }
    // Cap dt so a long pause does not let one sample jump through with a huge cutoff.
    const dt = Math.min(0.25, (tMs - this.lastT) / 1000);
    this.lastT = tMs;
    const { minCutoff, beta, dCutoff } = this.params;
    const aD = alpha(dCutoff, dt);
    for (let i = 0; i < n; i++) {
      const x = src[i] ?? 0;
      const prev = value[i] ?? x;
      const rawSpeed = (x - prev) / dt;
      const s = (speed[i] ?? 0) + aD * (rawSpeed - (speed[i] ?? 0));
      speed[i] = s;
      const a = alpha(minCutoff + beta * Math.abs(s), dt);
      const v = prev + a * (x - prev);
      value[i] = v;
      dst[i] = v;
    }
  }
}

/**
 * Melody performer: plays the single-note line of a voice the way its instrument would.
 *
 *  - guitars and basses: two close notes in quick succession slide / hammer on (a soft attack that
 *    bends in from the last note) instead of a fresh pick;
 *  - bowed strings, winds and voices on samples: overlapping legato crossfade with a short bend;
 *  - synths: portamento glide (the preset's own, or the glide setting in manual);
 *  - keys: sustain pedal (notes ring on; 'auto' re-pedals when a new note would clash);
 *  - an optional diatonic harmony note on the same instrument;
 *  - humanized velocity, deterministic per note.
 *
 * The engine reads `handle` / `midi` after every call: they are the main sounding note.
 */
import type { Player, StartOptions } from '../players';
import type { Technique } from './profile';
import { velocityJitter } from './rhythm';

/** Pedal-held notes kept at most (oldest let go beyond this). */
const MAX_PEDALLED = 12;
/** A pedalled sample has faded by then: stop tracking it. */
const PEDAL_TRACK_S = 2.5;

interface Ringing {
  handle: number;
  midi: number;
  at: number;
}

/** Pitch classes a step or less apart blur under the pedal. */
function clashes(a: number, b: number): boolean {
  const d = (((Math.round(a) - Math.round(b)) % 12) + 12) % 12;
  return d === 0 || d === 1 || d === 2 || d === 10 || d === 11;
}

export type HarmonyFn = (midi: number) => number | null;

export class MelodyPerformer {
  handle = -1;
  midi: number | null = null;
  private harmHandle = -1;
  private harmMidi: number | null = null;
  private lastOnset = -Infinity;
  private seq = 0;
  private readonly pedalled: Ringing[] = [];

  constructor(
    private readonly player: () => Player | null,
    /** An extra note (harmony) started: counted like any played note. */
    private readonly onExtra: (midi: number) => void,
  ) {}

  /** Fresh attack (gate opened, or retrigger). Returns true when a note started. */
  start(midi: number, velocity: number, t: number, tech: Technique, harmony: HarmonyFn): boolean {
    const p = this.player();
    if (!p) return false;
    p.setGlide(tech.portamento);
    this.repedal(midi, t, tech);
    const vel = this.velocity(velocity, midi, tech);
    const h = p.start(midi, vel, t);
    this.handle = h;
    this.midi = h >= 0 ? midi : null;
    if (h < 0) return false;
    this.lastOnset = t;
    this.startHarmony(p, harmony(midi), vel, t, tech);
    return true;
  }

  /** The melody moved to another note while the gate stays open. Returns true for an onset. */
  change(midi: number, velocity: number, t: number, tech: Technique, harmony: HarmonyFn): boolean {
    const p = this.player();
    const prev = this.midi;
    if (!p || this.handle < 0 || prev === null) return this.start(midi, velocity, t, tech, harmony);
    // Synth legato: the voice glides, no new attack.
    if (tech.sustained && p.glide(this.handle, midi, t)) {
      this.midi = midi;
      this.lastOnset = t;
      const hm = harmony(midi);
      if (this.harmHandle >= 0 && hm !== null && p.glide(this.harmHandle, hm, t)) this.harmMidi = hm;
      else {
        this.dropHarmony(p, t, 0.08);
        this.startHarmony(p, hm, 1, t, tech);
      }
      return true;
    }
    const d = Math.abs(midi - prev);
    let opts: StartOptions | undefined;
    let oldRelease: number;
    let vel = this.velocity(velocity, midi, tech);
    if (tech.slides && d >= 1 && d <= 2.5 && t - this.lastOnset < 0.15) {
      // Hammer-on / slide: no fresh pick, the string keeps sounding into the new fret.
      opts = { attack: 0.012, bendFrom: prev, bendTime: 0.035 };
      vel *= 0.62;
      oldRelease = 0.045;
    } else if (tech.legato) {
      // Bowed / blown legato: overlap the notes, bend a little into the new one.
      const bend = tech.bend > 0 ? Math.max(-tech.bend, Math.min(tech.bend, prev - midi)) : 0;
      opts = bend ? { attack: 0.035, bendFrom: midi + bend, bendTime: tech.glideTime } : { attack: 0.035 };
      oldRelease = 0.11;
    } else {
      oldRelease = tech.sustained ? 0.07 : Math.max(tech.release, 0.3);
    }
    const hm = harmony(midi);
    const prevHarm = this.harmMidi;
    this.letGo(p, this.handle, prev, t, oldRelease, tech, midi);
    this.handle = -1;
    if (this.harmHandle >= 0 && prevHarm !== null) this.letGo(p, this.harmHandle, prevHarm, t, oldRelease, tech, hm ?? midi);
    this.harmHandle = -1;
    this.harmMidi = null;
    this.repedal(midi, t, tech);
    const h = p.start(midi, vel, t, 1, opts);
    this.handle = h;
    this.midi = h >= 0 ? midi : null;
    if (h < 0) return false;
    this.lastOnset = t;
    const hOpts = opts?.bendFrom !== undefined && hm !== null && prevHarm !== null ? { ...opts, bendFrom: hm + (opts.bendFrom - midi) } : opts;
    this.startHarmony(p, hm, vel, t, tech, hOpts);
    return true;
  }

  /** Continuous pitch (theremin-style scales): glide the held note and its harmony. */
  glide(midi: number, t: number, harmony: HarmonyFn): void {
    const p = this.player();
    if (!p || this.handle < 0) return;
    if (p.glide(this.handle, midi, t)) this.midi = midi;
    if (this.harmHandle >= 0) {
      const hm = harmony(midi);
      if (hm !== null && p.glide(this.harmHandle, hm, t)) this.harmMidi = hm;
    }
  }

  /** The gate closed (or the note must end): release everything, the pedal lifts too. */
  release(t: number, release: number): void {
    const p = this.player();
    if (p) {
      if (this.handle >= 0) p.stop(this.handle, t, release);
      if (this.harmHandle >= 0) p.stop(this.harmHandle, t, release);
      for (const r of this.pedalled) p.stop(r.handle, t, release);
    }
    this.pedalled.length = 0;
    this.handle = -1;
    this.midi = null;
    this.harmHandle = -1;
    this.harmMidi = null;
  }

  /** Forget every handle (the player was replaced and released them itself). */
  reset(): void {
    this.pedalled.length = 0;
    this.handle = -1;
    this.midi = null;
    this.harmHandle = -1;
    this.harmMidi = null;
  }

  /** Sounding notes besides the main one: the harmony and pedal-held notes. */
  forEachExtra(now: number, fn: (midi: number) => void): void {
    if (this.harmHandle >= 0 && this.harmMidi !== null) fn(this.harmMidi);
    for (const r of this.pedalled) if (now - r.at < 1.8) fn(r.midi);
  }

  get extraCount(): number {
    return (this.harmHandle >= 0 ? 1 : 0) + this.pedalled.length;
  }

  private velocity(velocity: number, midi: number, tech: Technique): number {
    if (tech.sustained || tech.fixedVelocity) return velocity;
    const v = velocity * velocityJitter(++this.seq, Math.round(midi), tech.humanize);
    return v < 0 ? 0 : v > 1 ? 1 : v;
  }

  private startHarmony(p: Player, hm: number | null, vel: number, t: number, tech: Technique, opts?: StartOptions): void {
    if (hm === null) return;
    const [lo, hi] = p.spec.range;
    if (hm < lo || hm > hi) return;
    // A touch softer than the lead note; sustained samples ignore velocity, so use the gain.
    const h = p.start(hm, tech.sustained ? vel : vel * 0.8, t, tech.sustained ? 0.72 : 1, opts);
    if (h < 0) return;
    this.harmHandle = h;
    this.harmMidi = hm;
    this.onExtra(hm);
  }

  private dropHarmony(p: Player, t: number, release: number): void {
    if (this.harmHandle >= 0) p.stop(this.harmHandle, t, release);
    this.harmHandle = -1;
    this.harmMidi = null;
  }

  /** A key comes up: with the pedal down the note rings on, otherwise it is released. */
  private letGo(p: Player, handle: number, midi: number, t: number, release: number, tech: Technique, next: number): void {
    const keep = tech.pedal === 'hold' || (tech.pedal === 'auto' && !clashes(midi, next));
    if (!keep) {
      p.stop(handle, t, release);
      return;
    }
    this.pedalled.push({ handle, midi: Math.round(midi), at: t });
    while (this.pedalled.length > MAX_PEDALLED) p.stop(this.pedalled.shift()!.handle, t, 0.3);
  }

  /** Auto pedal: notes that would blur with the new one are damped (a quick pedal change). */
  private repedal(next: number, t: number, tech: Technique): void {
    if (!this.pedalled.length) return;
    const p = this.player();
    for (let i = this.pedalled.length - 1; i >= 0; i--) {
      const r = this.pedalled[i]!;
      const stale = t - r.at > PEDAL_TRACK_S;
      if (stale || tech.pedal === 'off' || (tech.pedal === 'auto' && clashes(r.midi, next))) {
        if (!stale) p?.stop(r.handle, t, 0.22);
        this.pedalled.splice(i, 1);
      }
    }
  }
}

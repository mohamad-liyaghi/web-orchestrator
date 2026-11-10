/**
 * Instrument players. A player turns note on/off calls into sound and owns every node it
 * starts, so releasing everything (instrument switch, panic, dispose) can never leave a note
 * hanging.
 *
 *  - SamplePlayer: one AudioBufferSourceNode + gain envelope per note, repitched from the
 *    nearest sample (at most one semitone away). Sustained notes loop a crossfaded region that
 *    the sample builder baked in, so they hold as long as the gate stays open.
 *  - SynthPlayer: a small pool of monophonic Tone voices; legato changes glide (portamento).
 */
import { Gain } from 'tone/build/esm/core/context/Gain.js';
import { connect } from 'tone/build/esm/core/context/ToneAudioNode.js';
import type { BaseContext } from 'tone/build/esm/core/context/BaseContext.js';
import type { InstrumentSpec } from './instruments';
import type { SampleSet } from './samples';
import { createSynthVoice, type MonoVoice } from './synths';
import { midiToFreq } from './theory';

export interface Player {
  readonly spec: InstrumentSpec;
  readonly output: Gain;
  /** Starts a note; returns a handle (or -1 when the note cannot play). */
  start(midi: number, velocity: number, time: number): number;
  /** Legato pitch change of a held note. False when the player cannot glide (samples). */
  glide(handle: number, midi: number, time: number): boolean;
  /** Releases a note (release defaults to the instrument's own). */
  stop(handle: number, time: number, release?: number): void;
  stopAll(time: number, release?: number): void;
  /** Number of notes still producing sound (held or releasing). */
  readonly activeCount: number;
  dispose(): void;
}

/** Polyphony caps, shared and mutable so low-power mode applies to live players. */
export interface VoiceLimits {
  sample: number;
  synth: number;
}

const dbToGain = (db: number): number => Math.pow(10, db / 20);

// ---------------------------------------------------------------------------------------------
// Samples
// ---------------------------------------------------------------------------------------------

interface SampleNote {
  handle: number;
  src: AudioBufferSourceNode;
  env: GainNode;
  level: number;
  t0: number;
  attackEnd: number;
  /** Release start, Infinity while held. */
  releaseAt: number;
  tau: number;
  ended: boolean;
}

let handleSeq = 0;

export class SamplePlayer implements Player {
  readonly output: Gain;
  private notes: SampleNote[] = [];
  private disposed = false;

  constructor(
    readonly spec: InstrumentSpec,
    private readonly set: SampleSet,
    private readonly ctx: BaseContext,
    private readonly limits: VoiceLimits,
  ) {
    this.output = new Gain(dbToGain(spec.trim ?? 0));
  }

  get activeCount(): number {
    return this.notes.length;
  }

  start(midi: number, velocity: number, time: number): number {
    if (this.disposed) return -1;
    const m = Math.max(0, Math.min(127, Math.round(midi)));
    const zone = this.set.nearest[m];
    if (!zone) return -1;
    this.sweep(time);
    this.enforcePolyphony(time);

    const src = this.ctx.createBufferSource();
    src.buffer = zone.buffer;
    src.playbackRate.value = Math.pow(2, (m - zone.midi) / 12);
    if (zone.loop) {
      src.loop = true;
      src.loopStart = zone.loopStart;
      src.loopEnd = zone.loopEnd;
    }
    const env = this.ctx.createGain();
    const v = Math.max(0, Math.min(1, velocity));
    const level = this.spec.sustained ? 1 : 0.06 + 0.94 * Math.pow(v, 1.5);
    const attack = this.spec.sustained ? 0.012 : 0.0025;
    env.gain.setValueAtTime(0, time);
    env.gain.linearRampToValueAtTime(level, time + attack);
    src.connect(env);
    connect(env, this.output);
    const note: SampleNote = {
      handle: ++handleSeq,
      src,
      env,
      level,
      t0: time,
      attackEnd: time + attack,
      releaseAt: Infinity,
      tau: 0,
      ended: false,
    };
    src.onended = () => this.cleanup(note);
    src.start(time, zone.offset);
    this.notes.push(note);
    return note.handle;
  }

  glide(): boolean {
    return false;
  }

  stop(handle: number, time: number, release = this.spec.release): void {
    const note = this.notes.find((n) => n.handle === handle);
    if (note) this.release(note, time, release);
  }

  stopAll(time: number, release = this.spec.release): void {
    for (const n of this.notes) this.release(n, time, release);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const n of this.notes.slice()) {
      try {
        n.src.stop();
      } catch {
        /* never started or already stopped */
      }
      this.cleanup(n);
    }
    this.output.dispose();
  }

  /** Gain of a note's envelope at `time` (needed to release without a jump). */
  private valueAt(n: SampleNote, time: number): number {
    if (time >= n.releaseAt) return n.level * Math.exp(-(time - n.releaseAt) / Math.max(1e-3, n.tau));
    if (time >= n.attackEnd) return n.level;
    const k = (time - n.t0) / Math.max(1e-4, n.attackEnd - n.t0);
    return n.level * Math.max(0, Math.min(1, k));
  }

  private release(n: SampleNote, time: number, release: number): void {
    if (n.ended) return;
    const r = Math.max(0.01, release);
    // Already releasing at least this fast: nothing to do.
    if (n.releaseAt <= time && n.tau <= r / 5) return;
    const v = this.valueAt(n, time);
    const g = n.env.gain;
    g.cancelScheduledValues(time);
    g.setValueAtTime(v, time);
    n.tau = r / 5;
    n.releaseAt = time;
    g.setTargetAtTime(0, time, n.tau);
    try {
      n.src.stop(time + r * 1.4 + 0.02);
    } catch {
      /* already stopped */
    }
  }

  private enforcePolyphony(time: number): void {
    // Count notes that are still loud; the oldest beyond the cap is faded out quickly.
    let loud = 0;
    for (let i = this.notes.length - 1; i >= 0; i--) {
      const n = this.notes[i]!;
      if (n.releaseAt === Infinity || time - n.releaseAt < n.tau * 2) {
        loud++;
        if (loud >= this.limits.sample) this.release(n, time, 0.04);
      }
    }
  }

  /** Safety net: forget notes whose release finished long ago even if 'ended' never fired. */
  private sweep(time: number): void {
    for (let i = this.notes.length - 1; i >= 0; i--) {
      const n = this.notes[i]!;
      const loopForever = n.releaseAt === Infinity && n.src.loop;
      const done = n.releaseAt !== Infinity ? time > n.releaseAt + n.tau * 10 + 1 : !loopForever && time > n.t0 + (n.src.buffer?.duration ?? 0) + 1;
      if (done) {
        try {
          n.src.stop();
        } catch {
          /* already stopped */
        }
        this.cleanup(n);
      }
    }
  }

  private cleanup(n: SampleNote): void {
    if (n.ended) return;
    n.ended = true;
    n.src.onended = null;
    n.src.disconnect();
    n.env.disconnect();
    const i = this.notes.indexOf(n);
    if (i >= 0) this.notes.splice(i, 1);
  }
}

// ---------------------------------------------------------------------------------------------
// Synths
// ---------------------------------------------------------------------------------------------

interface SynthSlot {
  voice: MonoVoice;
  handle: number;
  held: boolean;
  t0: number;
  /** Audio time after which the voice is silent again. */
  freeAt: number;
  /** Latest attack/release time scheduled on the voice: Tone rejects events before it. */
  last: number;
}

export class SynthPlayer implements Player {
  readonly output: Gain;
  private readonly slots: SynthSlot[] = [];
  private disposed = false;

  constructor(
    readonly spec: InstrumentSpec,
    private readonly limits: VoiceLimits,
  ) {
    this.output = new Gain(dbToGain(spec.trim ?? 0));
    // Build the first voice now, so the first note does not pay for node creation.
    if (spec.synth) this.addSlot();
  }

  get activeCount(): number {
    let n = 0;
    const now = this.output.context.currentTime;
    for (const s of this.slots) if (s.held || s.freeAt > now) n++;
    return n;
  }

  start(midi: number, velocity: number, time: number): number {
    if (this.disposed || !this.spec.synth) return -1;
    time = Math.max(time, this.output.context.currentTime);
    const slot = this.pickSlot(time);
    // A stolen voice may already hold a strum/arpeggio note scheduled slightly ahead.
    const at = Math.max(time, slot.last + 0.002);
    slot.handle = ++handleSeq;
    slot.held = true;
    slot.t0 = at;
    slot.last = at;
    slot.freeAt = Infinity;
    try {
      // A fresh attack must not glide in from the voice's previous pitch.
      slot.voice.frequency.cancelScheduledValues(at);
      slot.voice.frequency.setValueAtTime(midiToFreq(midi), at);
      slot.voice.triggerAttack(midiToFreq(midi), at, Math.max(0.05, Math.min(1, velocity)));
    } catch (e) {
      slot.held = false;
      slot.freeAt = 0;
      console.warn('[music] synth note skipped:', e instanceof Error ? e.message : e);
      return -1;
    }
    return slot.handle;
  }

  glide(handle: number, midi: number, time: number): boolean {
    const slot = this.slots.find((s) => s.handle === handle && s.held);
    if (!slot) return false;
    slot.voice.setNote(midiToFreq(midi), Math.max(time, slot.last));
    return true;
  }

  stop(handle: number, time: number): void {
    const slot = this.slots.find((s) => s.handle === handle);
    if (slot?.held) this.releaseSlot(slot, time);
  }

  stopAll(time: number): void {
    for (const s of this.slots) if (s.held) this.releaseSlot(s, time);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const s of this.slots) s.voice.dispose();
    this.slots.length = 0;
    this.output.dispose();
  }

  private releaseSlot(s: SynthSlot, time: number): void {
    s.held = false;
    const at = Math.max(time, s.t0 + 0.005, s.last + 0.002);
    s.last = at;
    s.voice.triggerRelease(at);
    s.freeAt = at + this.spec.release * 1.5 + 0.05;
  }

  private addSlot(): SynthSlot {
    const voice = createSynthVoice(this.spec.synth!);
    voice.connect(this.output);
    const slot: SynthSlot = { voice, handle: -1, held: false, t0: 0, freeAt: 0, last: 0 };
    this.slots.push(slot);
    return slot;
  }

  private pickSlot(time: number): SynthSlot {
    let best: SynthSlot | undefined;
    for (const s of this.slots) if (!s.held && s.freeAt <= time) return s;
    if (this.slots.length < Math.max(1, this.limits.synth)) return this.addSlot();
    // Steal: prefer a releasing voice, else the oldest held one.
    for (const s of this.slots) if (!s.held && (!best || s.freeAt < best.freeAt)) best = s;
    if (!best) for (const s of this.slots) if (!best || s.t0 < best.t0) best = s;
    best!.held = false;
    return best!;
  }
}

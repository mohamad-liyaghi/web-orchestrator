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
import { studioVoice, type StudioMember } from './studio/voice';

/**
 * Observer of a player's notes (looper recording, MIDI out). `off` fires once per note, whatever
 * ends it: a release, a voice steal, stopAll or dispose.
 */
export interface NoteTap {
  on(player: Player, handle: number, midi: number, velocity: number, time: number): void;
  /** A held note changed pitch without a new attack (synth legato). */
  glide(player: Player, handle: number, midi: number, time: number): void;
  off(player: Player, handle: number, time: number): void;
  /** A note scheduled ahead was withdrawn before it sounded (instead of `off`). `time` is the
   *  start it had been given. */
  cancel(player: Player, handle: number, time: number): void;
}

/** Optional articulation of a note start. */
export interface StartOptions {
  /** Attack time in seconds (instrument default when omitted): softer re-attacks, legato. */
  attack?: number;
  /** Start at this pitch and bend to the note (slides, legato portamento on samples). */
  bendFrom?: number;
  /** Bend duration, seconds. */
  bendTime?: number;
}

export interface Player {
  readonly spec: InstrumentSpec;
  readonly output: Gain;
  /** Note observer, null for none. */
  tap: NoteTap | null;
  /** Starts a note; returns a handle (or -1 when the note cannot play). `gain` scales its level
   *  (loop playback reproduces the loudness the live channel had). */
  start(midi: number, velocity: number, time: number, gain?: number, opts?: StartOptions): number;
  /** Legato pitch change of a held note. False when the player cannot glide (samples). */
  glide(handle: number, midi: number, time: number): boolean;
  /** Releases a note (release defaults to the instrument's own). */
  stop(handle: number, time: number, release?: number): void;
  /** Withdraws a note scheduled to start after `time` so it never sounds (a note already
   *  sounding is released quickly instead). */
  cancel(handle: number, time: number): void;
  /** Portamento of legato glides in seconds; null restores the instrument's own. */
  setGlide(seconds: number | null): void;
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
  /** Playback rate at A440 (the concert pitch multiplies it). */
  rate: number;
  env: GainNode;
  level: number;
  t0: number;
  attackEnd: number;
  /** Release start, Infinity while held. */
  releaseAt: number;
  tau: number;
  ended: boolean;
  /** The tap has been told this note ended. */
  tapOff: boolean;
}

let handleSeq = 0;

export class SamplePlayer implements Player, StudioMember {
  readonly output: Gain;
  tap: NoteTap | null = null;
  private notes: SampleNote[] = [];
  private disposed = false;

  constructor(
    readonly spec: InstrumentSpec,
    private readonly set: SampleSet,
    private readonly ctx: BaseContext,
    private readonly limits: VoiceLimits,
  ) {
    this.output = new Gain(dbToGain(spec.trim ?? 0));
    studioVoice.join(this);
  }

  get activeCount(): number {
    return this.notes.length;
  }

  retune(time: number): void {
    const k = Math.pow(2, studioVoice.cents / 1200);
    for (const n of this.notes) if (!n.ended) n.src.playbackRate.setTargetAtTime(n.rate * k, time, studioVoice.retuneTau);
  }

  reshape(): void {
    /* attack and release are read per note */
  }

  start(midi: number, velocity: number, time: number, gain = 1, opts?: StartOptions): number {
    if (this.disposed) return -1;
    const written = Math.max(0, Math.min(127, Math.round(midi)));
    const m = Math.max(0, Math.min(127, written + studioVoice.transpose));
    const zone = this.set.nearest[m];
    if (!zone) return -1;
    this.sweep(time);
    this.enforcePolyphony(time);

    const src = this.ctx.createBufferSource();
    src.buffer = zone.buffer;
    const rate = Math.pow(2, (m - zone.midi) / 12);
    // The concert pitch (A4) scales every rate.
    const tune = Math.pow(2, studioVoice.cents / 1200);
    if (opts?.bendFrom !== undefined && opts.bendTime && Math.abs(opts.bendFrom - m) > 0.01) {
      // A short bend into the note: the slide / portamento illusion on a sample.
      const from = Math.pow(2, (Math.max(m - 4, Math.min(m + 4, opts.bendFrom)) - zone.midi) / 12);
      src.playbackRate.setValueAtTime(from * tune, time);
      src.playbackRate.exponentialRampToValueAtTime(rate * tune, time + Math.max(0.005, opts.bendTime));
    } else {
      src.playbackRate.value = rate * tune;
    }
    if (zone.loop) {
      src.loop = true;
      src.loopStart = zone.loopStart;
      src.loopEnd = zone.loopEnd;
    }
    const env = this.ctx.createGain();
    const v = Math.max(0, Math.min(1, velocity));
    const level = (this.spec.sustained ? 1 : 0.06 + 0.94 * Math.pow(v, 1.5)) * Math.max(0, Math.min(1, gain));
    const attack = Math.max(0.0015, opts?.attack ?? studioVoice.attackTime(this.spec.sustained ? 0.012 : 0.0025));
    env.gain.setValueAtTime(0, time);
    env.gain.linearRampToValueAtTime(level, time + attack);
    src.connect(env);
    connect(env, this.output);
    const note: SampleNote = {
      handle: ++handleSeq,
      src,
      rate,
      env,
      level,
      t0: time,
      attackEnd: time + attack,
      releaseAt: Infinity,
      tau: 0,
      ended: false,
      tapOff: false,
    };
    src.onended = () => this.cleanup(note);
    src.start(time, zone.offset);
    this.notes.push(note);
    this.tap?.on(this, note.handle, written, v, time);
    return note.handle;
  }

  glide(): boolean {
    return false;
  }

  setGlide(): void {
    /* samples bend per note (StartOptions) */
  }

  stop(handle: number, time: number, release = this.spec.release): void {
    const note = this.notes.find((n) => n.handle === handle);
    if (note) this.release(note, time, release);
  }

  cancel(handle: number, time: number): void {
    const n = this.notes.find((x) => x.handle === handle);
    if (!n || n.ended) return;
    if (n.t0 <= time + 0.001 || n.releaseAt !== Infinity) {
      this.release(n, time, 0.03);
      return;
    }
    // Not started yet: silence the envelope and stop the source before it ever plays.
    n.tapOff = true;
    this.tap?.cancel(this, n.handle, n.t0);
    const g = n.env.gain;
    g.cancelScheduledValues(time);
    g.setValueAtTime(0, time);
    try {
      n.src.stop(time);
    } catch {
      /* already stopped */
    }
    this.cleanup(n);
  }

  stopAll(time: number, release = this.spec.release): void {
    for (const n of this.notes) this.release(n, time, release);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    studioVoice.leave(this);
    const now = this.ctx.currentTime;
    for (const n of this.notes.slice()) {
      this.tapOff(n, now);
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

  private tapOff(n: SampleNote, time: number): void {
    if (n.tapOff) return;
    n.tapOff = true;
    this.tap?.off(this, n.handle, time);
  }

  private release(n: SampleNote, time: number, release: number): void {
    if (n.ended) return;
    this.tapOff(n, time);
    const r = Math.max(0.01, studioVoice.releaseTime(release));
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
    this.tapOff(n, this.ctx.currentTime);
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
  /** The preset's own portamento. */
  portamento: number;
  /** The voice was silent when its current note was scheduled (nothing to fade out). */
  fresh: boolean;
  /** The preset's own envelope times (the studio scales them). */
  baseAttack: number;
  baseRelease: number;
}

/** The parts of a Tone voice the cancel path touches (envelopes and oscillators). */
interface VoicePart {
  cancel?: (after: number) => unknown;
  stop?: (time: number) => unknown;
  _state?: { getValueAtTime(time: number): string | undefined; getNextState(state: string, time: number): { time: number } | undefined };
}

/** True when the voice's oscillator is not running at `time` (its last note has fully ended). */
function oscillatorSilentAt(osc: VoicePart | undefined, time: number, fallback: boolean): boolean {
  const state = osc?._state?.getValueAtTime(time);
  return state === undefined ? fallback : state !== 'started';
}

export class SynthPlayer implements Player, StudioMember {
  readonly output: Gain;
  tap: NoteTap | null = null;
  private readonly slots: SynthSlot[] = [];
  private disposed = false;
  private glideOverride: number | null = null;

  constructor(
    readonly spec: InstrumentSpec,
    private readonly limits: VoiceLimits,
  ) {
    this.output = new Gain(dbToGain(spec.trim ?? 0));
    studioVoice.join(this);
    // Build the first voice now, so the first note does not pay for node creation.
    if (spec.synth) this.addSlot();
  }

  retune(time: number): void {
    for (const s of this.slots) s.voice.detune.setTargetAtTime(studioVoice.cents, Math.max(time, this.output.context.currentTime), studioVoice.retuneTau);
  }

  reshape(): void {
    for (const s of this.slots) this.shape(s);
  }

  private shape(s: SynthSlot): void {
    s.voice.envelope.attack = studioVoice.attackTime(s.baseAttack);
    s.voice.envelope.release = s.baseRelease * studioVoice.releaseFactor;
  }

  get activeCount(): number {
    let n = 0;
    const now = this.output.context.currentTime;
    for (const s of this.slots) if (s.held || s.freeAt > now) n++;
    return n;
  }

  start(midi: number, velocity: number, time: number, gain = 1): number {
    if (this.disposed || !this.spec.synth) return -1;
    time = Math.max(time, this.output.context.currentTime);
    const slot = this.pickSlot(time);
    const fresh = !slot.held && slot.freeAt <= time;
    // A stolen voice may already hold a strum/arpeggio note scheduled slightly ahead.
    const at = Math.max(time, slot.last + 0.002);
    const v = Math.max(0.05, Math.min(1, velocity));
    slot.handle = ++handleSeq;
    slot.fresh = fresh;
    slot.held = true;
    slot.t0 = at;
    slot.last = at;
    slot.freeAt = Infinity;
    const porta = this.glideOverride ?? slot.portamento;
    if (slot.voice.portamento !== porta) slot.voice.portamento = porta;
    try {
      // A fresh attack must not glide in from the voice's previous pitch.
      slot.voice.frequency.cancelScheduledValues(at);
      const hz = midiToFreq(midi + studioVoice.transpose);
      slot.voice.frequency.setValueAtTime(hz, at);
      slot.voice.triggerAttack(hz, at, v * Math.max(0.02, Math.min(1, gain)));
    } catch (e) {
      slot.held = false;
      slot.freeAt = 0;
      console.warn('[music] synth note skipped:', e instanceof Error ? e.message : e);
      return -1;
    }
    this.tap?.on(this, slot.handle, midi, v, at);
    return slot.handle;
  }

  glide(handle: number, midi: number, time: number): boolean {
    const slot = this.slots.find((s) => s.handle === handle && s.held);
    if (!slot) return false;
    slot.voice.setNote(midiToFreq(midi + studioVoice.transpose), Math.max(time, slot.last));
    this.tap?.glide(this, handle, midi, time);
    return true;
  }

  stop(handle: number, time: number): void {
    const slot = this.slots.find((s) => s.handle === handle);
    if (slot?.held) this.releaseSlot(slot, time);
  }

  setGlide(seconds: number | null): void {
    this.glideOverride = seconds === null ? null : Math.max(0, Math.min(1, seconds));
  }

  cancel(handle: number, time: number): void {
    const slot = this.slots.find((s) => s.handle === handle && s.held);
    if (!slot) return;
    time = Math.max(time, this.output.context.currentTime);
    if (slot.t0 <= time + 0.001) {
      this.releaseSlot(slot, time);
      return;
    }
    // Not started yet: drop the scheduled attack.
    slot.held = false;
    this.tap?.cancel(this, slot.handle, slot.t0);
    const v = slot.voice as unknown as Record<string, VoicePart | undefined>;
    try {
      for (const k of ['envelope', 'filterEnvelope', 'modulationEnvelope']) v[k]?.cancel?.(time);
      const silent = oscillatorSilentAt(v.oscillator, time, slot.fresh);
      // A voice still ringing from an earlier note lets that tail fade out.
      if (!silent) slot.voice.triggerRelease(time);
      // The oscillators must not keep the withdrawn start: a later note on this voice may be
      // scheduled before it, which Tone rejects. Stopping at the moment they fall silent anyway
      // (now, or where the earlier note's tail ends) clears everything scheduled after.
      for (const k of ['oscillator', 'modulation']) {
        const osc = v[k];
        if (!osc?.stop) continue;
        if (oscillatorSilentAt(osc, time, slot.fresh)) osc.stop(time);
        else {
          const end = osc._state?.getNextState('stopped', time);
          if (end && end.time < slot.t0) osc.stop(end.time);
        }
      }
      slot.freeAt = silent ? time : time + this.spec.release * studioVoice.releaseFactor * 1.5 + 0.05;
      slot.last = time;
    } catch {
      // Fall back to an ordinary release right after the attack.
      const at = Math.max(slot.t0 + 0.005, slot.last + 0.002);
      try {
        slot.voice.triggerRelease(at);
      } catch {
        /* the voice is stolen or reused before long */
      }
      slot.last = at;
      slot.freeAt = at + this.spec.release * studioVoice.releaseFactor * 1.5 + 0.05;
    }
  }

  stopAll(time: number): void {
    for (const s of this.slots) if (s.held) this.releaseSlot(s, time);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    studioVoice.leave(this);
    const now = this.output.context.currentTime;
    for (const s of this.slots) {
      if (s.held) this.tap?.off(this, s.handle, now);
      s.voice.dispose();
    }
    this.slots.length = 0;
    this.output.dispose();
  }

  private releaseSlot(s: SynthSlot, time: number): void {
    s.held = false;
    this.tap?.off(this, s.handle, time);
    const at = Math.max(time, s.t0 + 0.005, s.last + 0.002);
    s.last = at;
    s.voice.triggerRelease(at);
    s.freeAt = at + this.spec.release * studioVoice.releaseFactor * 1.5 + 0.05;
  }

  private addSlot(): SynthSlot {
    const voice = createSynthVoice(this.spec.synth!);
    voice.connect(this.output);
    const env = voice.envelope;
    const slot: SynthSlot = {
      voice,
      handle: -1,
      held: false,
      t0: 0,
      freeAt: 0,
      last: 0,
      portamento: voice.portamento,
      fresh: true,
      baseAttack: env.toSeconds(env.attack),
      baseRelease: env.toSeconds(env.release),
    };
    voice.detune.value = studioVoice.cents;
    this.shape(slot);
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
    if (best!.held) this.tap?.off(this, best!.handle, time);
    best!.held = false;
    return best!;
  }
}

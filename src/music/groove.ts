/**
 * Backing groove: synthesized kit patterns (pop, lofi, rock, house, metronome), a round pulse bass
 * on the chord root and a pad that follows the chord the player is implying. Mixed under the
 * instruments; fades in and out instead of cutting.
 *
 * The engine owns the Transport and calls schedule() one sixteenth AHEAD of every sixteenth, so
 * the beat is immune to main-thread hiccups (camera inference) even with the tiny context
 * lookAhead the instruments need for low latency.
 */
import { Filter, Gain, MembraneSynth, NoiseSynth, PolySynth, Synth } from 'tone/build/esm/classes.js';
import type { BaseContext } from 'tone/build/esm/core/context/BaseContext.js';
import type { InputNode } from 'tone/build/esm/core/context/ToneAudioNode.js';
import type { BeatStyle } from '../types';
import { midiToFreq } from './theory';

export interface GrooveChord {
  /** Pitch class of the root. */
  root: number;
  /** Chord tones relative to the root. */
  intervals: readonly number[];
}

interface Pattern {
  kick: number[];
  snare: number[];
  hat: number[];
  bass: number[];
  /** Delay of the off-sixteenths as a fraction of a sixteenth (swing). */
  swing: number;
  level: number;
  pad: boolean;
  hatTone: number;
  click?: boolean;
}

const _ = 0;
const PATTERNS: Record<BeatStyle, Pattern> = {
  pop: {
    kick: [1, _, _, _, _, _, _, 0.5, 0.9, _, 0.45, _, _, _, _, _],
    snare: [_, _, _, _, 1, _, _, _, _, _, _, _, 1, _, _, 0.25],
    hat: [0.5, _, 0.8, _, 0.5, _, 0.8, 0.25, 0.5, _, 0.8, _, 0.5, 0.2, 0.8, _],
    bass: [1, _, _, _, _, _, _, 0.6, 0.85, _, _, _, _, _, 0.6, _],
    swing: 0.08,
    level: 0.55,
    pad: true,
    hatTone: 7500,
  },
  lofi: {
    kick: [1, _, _, _, _, _, _, _, _, _, 0.8, _, _, _, 0.3, _],
    snare: [_, _, _, _, 0.7, _, _, _, _, _, _, _, 0.7, _, _, _],
    hat: [0.35, _, 0.25, _, 0.35, _, 0.25, _, 0.35, _, 0.25, _, 0.35, _, 0.25, 0.15],
    bass: [0.8, _, _, _, _, _, _, _, _, _, 0.6, _, _, _, _, _],
    swing: 0.34,
    level: 0.42,
    pad: true,
    hatTone: 5200,
  },
  rock: {
    kick: [1, _, _, _, _, _, _, _, 1, _, 0.9, _, _, _, _, _],
    snare: [_, _, _, _, 1, _, _, _, _, _, _, _, 1, _, _, _],
    hat: [0.75, _, 0.6, _, 0.75, _, 0.6, _, 0.75, _, 0.6, _, 0.75, _, 0.6, _],
    bass: [1, _, 0.7, _, 0.7, _, 0.7, _, 1, _, 0.7, _, 0.7, _, 0.7, _],
    swing: 0,
    level: 0.58,
    pad: false,
    hatTone: 6500,
  },
  house: {
    kick: [1, _, _, _, 1, _, _, _, 1, _, _, _, 1, _, _, _],
    snare: [_, _, _, _, 0.8, _, _, _, _, _, _, _, 0.8, _, _, _],
    hat: [_, _, 0.9, _, _, _, 0.9, _, _, _, 0.9, _, _, _, 0.9, 0.3],
    bass: [_, _, 0.9, _, _, _, 0.9, _, _, _, 0.9, _, _, _, 0.9, _],
    swing: 0.04,
    level: 0.55,
    pad: true,
    hatTone: 8500,
  },
  metronome: {
    kick: [],
    snare: [],
    hat: [],
    bass: [],
    swing: 0,
    level: 0.5,
    pad: false,
    hatTone: 8000,
    click: true,
  },
};

export class Groove {
  readonly output = new Gain(0);
  private readonly kick = new MembraneSynth({
    pitchDecay: 0.04,
    octaves: 5,
    envelope: { attack: 0.001, decay: 0.32, sustain: 0, release: 0.1 },
    volume: -4,
  });
  private readonly snareFilter = new Filter({ type: 'bandpass', frequency: 2200, Q: 0.7 });
  private readonly snare = new NoiseSynth({
    noise: { type: 'pink' },
    envelope: { attack: 0.001, decay: 0.13, sustain: 0, release: 0.05 },
    volume: -12,
  });
  private readonly hatFilter = new Filter({ type: 'highpass', frequency: 7500 });
  private readonly hat = new NoiseSynth({
    noise: { type: 'white' },
    envelope: { attack: 0.001, decay: 0.035, sustain: 0, release: 0.02 },
    volume: -22,
  });
  private readonly bass = new Synth({
    oscillator: { type: 'triangle' },
    envelope: { attack: 0.005, decay: 0.25, sustain: 0.3, release: 0.12 },
    volume: -9,
  });
  private readonly click = new Synth({
    oscillator: { type: 'sine' },
    envelope: { attack: 0.001, decay: 0.05, sustain: 0, release: 0.02 },
    volume: -8,
  });
  private readonly padFilter = new Filter({ type: 'lowpass', frequency: 1100, Q: 0.4 });
  private pad: PolySynth<Synth>;
  private running = false;
  private lastPadKey = '';
  private lowPower = false;
  private style: Pattern = PATTERNS.pop;
  /** The player's own chords cover the harmony (chords mode): drums only. */
  private harmony = true;

  constructor(
    private readonly ctx: BaseContext,
    private readonly chord: () => GrooveChord,
    destination: InputNode,
  ) {
    this.pad = this.makePad(12);
    this.kick.connect(this.output);
    this.snare.chain(this.snareFilter, this.output);
    this.hat.chain(this.hatFilter, this.output);
    this.bass.connect(this.output);
    this.click.connect(this.output);
    this.padFilter.connect(this.output);
    this.output.connect(destination);
  }

  get isRunning(): boolean {
    return this.running;
  }

  setStyle(style: BeatStyle): void {
    const next = PATTERNS[style] ?? PATTERNS.pop;
    if (next === this.style) return;
    this.style = next;
    this.hatFilter.frequency.setValueAtTime(next.hatTone, this.ctx.currentTime);
    if (this.running) this.output.gain.setTargetAtTime(next.level, this.ctx.currentTime, 0.1);
    if (!next.pad) this.pad.releaseAll(this.ctx.currentTime);
  }

  setHarmony(on: boolean): void {
    if (on === this.harmony) return;
    this.harmony = on;
    if (!on) this.pad.releaseAll(this.ctx.currentTime);
    this.lastPadKey = '';
  }

  setLowPower(on: boolean): void {
    if (on === this.lowPower) return;
    this.lowPower = on;
    const old = this.pad;
    old.releaseAll(this.ctx.currentTime);
    window.setTimeout(() => old.dispose(), 1500);
    this.pad = this.makePad(on ? 6 : 12);
  }

  /** Fade in. The engine starts the Transport. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastPadKey = '';
    const now = this.ctx.currentTime;
    this.output.gain.cancelScheduledValues(now);
    this.output.gain.setTargetAtTime(this.style.level, now, 0.12);
  }

  /** Fade out (hits already scheduled play into the fade). */
  stop(): void {
    if (!this.running) return;
    this.running = false;
    const now = this.ctx.currentTime;
    this.output.gain.cancelScheduledValues(now);
    this.output.gain.setTargetAtTime(0, now, 0.12);
    this.pad.releaseAll(now + 0.3);
  }

  /** Immediately silent (panic). */
  silence(): void {
    this.running = false;
    const now = this.ctx.currentTime;
    this.output.gain.cancelScheduledValues(now);
    this.output.gain.setValueAtTime(0, now);
    this.pad.releaseAll(now);
    this.bass.triggerRelease(now);
  }

  dispose(): void {
    for (const n of [this.kick, this.snare, this.snareFilter, this.hat, this.hatFilter, this.bass, this.click, this.pad, this.padFilter, this.output]) {
      n.dispose();
    }
  }

  private makePad(voices: number): PolySynth<Synth> {
    const pad = new PolySynth(Synth, {
      oscillator: { type: 'fattriangle', count: 2, spread: 14 },
      envelope: { attack: 0.35, decay: 0.4, sustain: 0.7, release: 0.8 },
      volume: -17,
    });
    pad.maxPolyphony = voices;
    pad.connect(this.padFilter);
    return pad;
  }

  /** Schedules sixteenth `step` (counted from the Transport start) at audio time `time`. */
  schedule(step: number, time: number, sixteenth: number): void {
    if (!this.running) return;
    const p = this.style;
    const s = ((step % 16) + 16) % 16;
    const at = time + (s % 2 ? sixteenth * p.swing : 0);
    if (p.click) {
      if (s % 4 === 0) this.click.triggerAttackRelease(s === 0 ? 1760 : 1320, 0.03, at, s === 0 ? 1 : 0.55);
      return;
    }
    const k = p.kick[s];
    if (k) this.kick.triggerAttackRelease(46, 0.2, at, k);
    const sn = p.snare[s];
    if (sn) this.snare.triggerAttackRelease(0.1, at, sn);
    const h = p.hat[s];
    if (h && !(this.lowPower && s % 2)) this.hat.triggerAttackRelease(0.03, at, h);
    if (!this.harmony) return;
    const c = this.chord();
    const b = p.bass[s];
    if (b) this.bass.triggerAttackRelease(midiToFreq(36 + c.root), sixteenth * 1.6, at, b);
    // Pad: on the bar, or on the next beat when the chord changed.
    if (!p.pad || s % 4 !== 0) return;
    const key = `${c.root}:${c.intervals.join(',')}`;
    if (s === 0 || key !== this.lastPadKey) {
      this.lastPadKey = key;
      const notes = c.intervals
        .slice(0, this.lowPower ? 2 : 3)
        .map((i) => midiToFreq(48 + c.root + i + (c.root + i > 7 ? -12 : 0)));
      // Run after the Transport callback returns (same audio time): when the PolySynth has to build
      // a voice, Tone's constructors schedule without a time and warn inside a Transport callback.
      const pad = this.pad;
      const length = sixteenth * (16 - s) * 0.98;
      queueMicrotask(() => {
        if (pad.disposed) return;
        pad.releaseAll(time);
        pad.triggerAttackRelease(notes, length, time, 0.45);
      });
    }
  }
}

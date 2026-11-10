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
import type { BeatStyle, TimeSignature } from '../types';
import { METERS, swingSteps, type Meter } from './studio/meter';
import { studioVoice } from './studio/voice';

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
  /** Delay of the off-sixteenths as a fraction of a sixteenth (the style's own swing). */
  swing: number;
  /** The style swings sixteenths (house), not eighths, when the user adds swing. */
  sixteenthSwing?: boolean;
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
    sixteenthSwing: true,
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

type Hits = ReadonlyArray<readonly [step: number, velocity: number]>;

/** Kick and snare of each odd meter: waltz 3/4, compound 6/8, 5/4 as 3+2, 7/8 as 2+2+3. */
const ODD_METERS: Record<Exclude<TimeSignature, '4/4'>, { kick: Hits; snare: Hits }> = {
  '3/4': { kick: [[0, 1]], snare: [[4, 0.55], [8, 0.55]] },
  '6/8': { kick: [[0, 1], [10, 0.4]], snare: [[6, 1]] },
  '5/4': { kick: [[0, 1], [12, 0.9]], snare: [[8, 1], [16, 0.9]] },
  '7/8': { kick: [[0, 1], [8, 0.85]], snare: [[4, 1], [12, 0.7]] },
};

/**
 * A style's pattern in a meter. 4/4 keeps the hand-written patterns; the other meters are built
 * from their accent map and the style's character (hat feel, bass rhythm, four-on-the-floor).
 */
const built = new Map<string, Pattern>();

export function patternFor(style: BeatStyle, meter: Meter): Pattern {
  const base = PATTERNS[style] ?? PATTERNS.pop;
  if (meter.id === '4/4' || base.click) return base;
  const key = `${style}:${meter.id}`;
  let p = built.get(key);
  if (!p) built.set(key, (p = buildPattern(style, base, meter)));
  return p;
}

function buildPattern(style: BeatStyle, base: Pattern, meter: Meter): Pattern {
  const map = ODD_METERS[meter.id as Exclude<TimeSignature, '4/4'>];
  const n = meter.steps;
  const kick = new Array<number>(n).fill(0);
  const snare = new Array<number>(n).fill(0);
  const hat = new Array<number>(n).fill(0);
  const bass = new Array<number>(n).fill(0);
  const soft = style === 'lofi' ? 0.75 : 1;
  for (const [i, v] of map.kick) kick[i] = v * soft;
  for (const [i, v] of map.snare) snare[i] = v * (style === 'lofi' ? 0.7 : 1);
  if (style === 'house') {
    // Four on the floor: a kick on every beat (every group start in eighth meters).
    const pulses = meter.eighths ? meter.groups : Array.from({ length: meter.beats }, (_, b) => b * meter.beatSteps);
    for (const i of pulses) kick[i] = 1;
  }
  const isGroup = (i: number): boolean => meter.groups.includes(i);
  for (let i = 0; i < n; i += 2) {
    const onBeat = meter.eighths ? isGroup(i) : i % meter.beatSteps === 0;
    switch (style) {
      case 'rock':
        hat[i] = onBeat ? 0.75 : 0.6;
        bass[i] = isGroup(i) ? 1 : 0.7;
        break;
      case 'lofi':
        hat[i] = onBeat ? 0.35 : 0.25;
        if (kick[i]) bass[i] = 0.8 * kick[i]!;
        break;
      case 'house':
        if (!onBeat) {
          hat[i] = 0.9;
          bass[i] = 0.9;
        }
        break;
      default:
        hat[i] = onBeat ? 0.5 : 0.8;
        if (kick[i]) bass[i] = kick[i]! >= 0.9 ? 1 : 0.6;
    }
  }
  return { ...base, kick, snare, hat, bass };
}

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
  private styleId: BeatStyle = 'pop';
  private meter: Meter = METERS['4/4'];
  private style: Pattern = PATTERNS.pop;
  /** Metronome click level relative to the default click volume. */
  private clickLevel = 1;
  /** Latest hit time: Tone's synths reject a start before the previous one. */
  private lastAt = 0;
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

  /** Swing of the current pattern: off-sixteenths are late by this fraction of a sixteenth. */
  get swing(): number {
    return this.style.swing;
  }

  /** The style swings sixteenths rather than eighths. */
  get sixteenthSwing(): boolean {
    return !!this.style.sixteenthSwing;
  }

  /**
   * How late grid sixteenth `barStep` sounds, in sixteenths: the user's swing when set (eighths,
   * or sixteenths for house and eighth-based meters), else the style's own groove.
   */
  offset(barStep: number, userSwing: number): number {
    if (userSwing > 0) return swingSteps(barStep, userSwing, this.sixteenthSwing || this.meter.eighths);
    return barStep % 2 ? this.style.swing : 0;
  }

  /** Metronome click volume relative to the default (0 = silent). */
  setClickLevel(level: number): void {
    this.clickLevel = Math.max(0, level);
    this.click.volume.value = this.clickLevel > 0 ? -8 + 20 * Math.log10(this.clickLevel) : -Infinity;
  }

  setMeter(meter: Meter): void {
    if (meter === this.meter) return;
    this.meter = meter;
    this.lastPadKey = '';
    this.applyPattern(patternFor(this.styleId, meter));
  }

  setStyle(style: BeatStyle): void {
    this.styleId = style;
    this.applyPattern(patternFor(style, this.meter));
  }

  private applyPattern(next: Pattern): void {
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

  /**
   * Schedules bar sixteenth `s` (0..meter.steps-1) at audio time `time`, `offset` sixteenths late
   * (swing).
   */
  schedule(s: number, time: number, sixteenth: number, offset: number): void {
    if (!this.running) return;
    const p = this.style;
    const m = this.meter;
    // Grid steps arrive in order, but a tempo change can pull a step slightly before the one that
    // was scheduled ahead with the old tempo: never go back in time.
    const at = Math.max(time + offset * sixteenth, this.lastAt + 0.001);
    this.lastAt = at;
    if (p.click) {
      if (s % m.beatSteps !== 0 || this.clickLevel <= 0) return;
      // Downbeat high, other group starts (5/4, 6/8, 7/8) a little accented, the rest soft.
      if (s === 0) this.click.triggerAttackRelease(1760, 0.03, at, 1);
      else if (m.groups.includes(s)) this.click.triggerAttackRelease(1540, 0.03, at, 0.75);
      else this.click.triggerAttackRelease(1320, 0.03, at, 0.55);
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
    if (b) this.bass.triggerAttackRelease(studioVoice.hz(36 + c.root), sixteenth * 1.6, at, b);
    // Pad: on the bar, or on the next beat (group in eighth meters) when the chord changed.
    if (!p.pad || (m.eighths ? !m.groups.includes(s) : s % 4 !== 0)) return;
    const key = `${c.root}:${c.intervals.join(',')}`;
    if (s === 0 || key !== this.lastPadKey) {
      const notes = c.intervals
        .slice(0, this.lowPower ? 2 : 3)
        .map((i) => studioVoice.hz(48 + c.root + i + (c.root + i > 7 ? -12 : 0)));
      // Run after the Transport callback returns (same audio time): when the PolySynth has to build
      // a voice, Tone's constructors schedule without a time and warn inside a Transport callback.
      const pad = this.pad;
      // Chords changing every beat at a fast tempo would overrun the pad's voices (releasing ones
      // still count): keep the sounding chord until voices free up, never drop notes mid-chord.
      const room = pad.maxPolyphony - pad.activeVoices;
      if (room < notes.length) {
        if (s !== 0 || room <= 0) return;
        notes.length = room;
      }
      this.lastPadKey = key;
      const length = sixteenth * (m.steps - s) * 0.98;
      queueMicrotask(() => {
        if (pad.disposed) return;
        pad.releaseAll(time);
        pad.triggerAttackRelease(notes, length, time, 0.45);
      });
    }
  }
}

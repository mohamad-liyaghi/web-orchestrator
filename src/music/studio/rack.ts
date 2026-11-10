/**
 * The studio FX rack, built from plain Web Audio nodes (so it renders the same in the live
 * context and in an OfflineAudioContext for tests):
 *
 *   input -> EQ3 -> chorus -> delay (tempo synced) -> reverb -> [+ side input] -> compressor
 *         -> stereo width -> limiter -> safety clip -> output
 *
 * The side input (the backing groove) gets its own copy of the EQ and joins before the
 * compressor, so drums are equalized and glued but never chorused or echoed.
 *
 * Every parameter moves on a short ramp. Effects at their neutral value cost nothing: inserts
 * (EQ, compressor, width) crossfade to a dry path and then disconnect; sends (chorus, delay,
 * reverb) fade out and disconnect once their tail has died. Low-power mode keeps chorus, delay
 * and width off and uses a short reverb. Switching the reverb type builds the new impulse in
 * slices between frames and crossfades into it.
 */
import type { NoteRate, ReverbType, Settings } from '../../types';
import { ImpulseBuilder, presetFor, type ReverbPreset } from './reverb';

/** What the rack needs from a context: Tone's Context and a native (Offline)AudioContext both fit. */
export interface RackContext {
  readonly sampleRate: number;
  readonly currentTime: number;
  createGain(): GainNode;
  createBiquadFilter(): BiquadFilterNode;
  createDelay(maxDelayTime?: number): DelayNode;
  createConvolver(): ConvolverNode;
  createDynamicsCompressor(): DynamicsCompressorNode;
  createWaveShaper(): WaveShaperNode;
  createChannelSplitter(numberOfOutputs?: number): ChannelSplitterNode;
  createChannelMerger(numberOfInputs?: number): ChannelMergerNode;
  createOscillator(): OscillatorNode;
  createBuffer(numberOfChannels: number, length: number, sampleRate: number): AudioBuffer;
}

/** Deferred work: `later` for disconnecting after fades, `slice` for impulse building. */
export interface RackHost {
  later(ms: number, fn: () => void): void;
  /** Runs `fn` soon, outside the current frame (a macrotask). */
  slice(fn: () => void): void;
}

export type RackSettings = Pick<
  Settings,
  'eqLow' | 'eqMid' | 'eqHigh' | 'chorus' | 'delay' | 'delayTime' | 'delayFeedback' | 'reverb' | 'reverbType' | 'compressor' | 'width' | 'lowPower' | 'tempo'
>;

/** Note lengths in beats (quarter notes). */
export const NOTE_BEATS: Record<NoteRate, number> = {
  '1/4': 1,
  '1/8': 0.5,
  '1/8t': 1 / 3,
  '1/8d': 0.75,
  '1/16': 0.25,
  '1/16t': 1 / 6,
};

/** Seconds of a note length at a tempo. */
export function noteSeconds(rate: NoteRate, bpm: number): number {
  return (NOTE_BEATS[rate] ?? 0.5) * (60 / Math.max(1, bpm));
}

/** Crossfade time of inserts and send on/off (s). */
const FADE = 0.04;
/** Parameter smoothing time constant (s). */
const TAU = 0.03;
const MAX_DELAY = 2;

const db = (v: number): number => Math.pow(10, v / 20);

function ramp(p: AudioParam, value: number, t: number, tau = TAU): void {
  p.cancelScheduledValues(t);
  p.setValueAtTime(p.value, t);
  p.setTargetAtTime(value, t, tau);
}

function fade(p: AudioParam, value: number, t: number, seconds = FADE): void {
  p.cancelScheduledValues(t);
  p.setValueAtTime(p.value, t);
  p.linearRampToValueAtTime(value, t + seconds);
}

function gain(ctx: RackContext, value: number): GainNode {
  const g = ctx.createGain();
  g.gain.value = value;
  return g;
}

/** A gain that upmixes mono to stereo, so channel splitters always see two channels. */
function stereo(ctx: RackContext, value = 1): GainNode {
  const g = gain(ctx, value);
  g.channelCount = 2;
  g.channelCountMode = 'explicit';
  g.channelInterpretation = 'speakers';
  return g;
}

function safeDisconnect(a: AudioNode, b?: AudioNode): void {
  try {
    if (b) a.disconnect(b);
    else a.disconnect();
  } catch {
    /* not connected */
  }
}

// ---------------------------------------------------------------------------------------------
// Inserts: dry path crossfades with the effect path, effect disconnected when bypassed
// ---------------------------------------------------------------------------------------------

class Insert {
  readonly input: GainNode;
  readonly output: GainNode;
  private readonly dry: GainNode;
  private readonly wet: GainNode;
  private on = false;
  private wired = false;
  private gen = 0;

  constructor(
    ctx: RackContext,
    private readonly host: RackHost,
    private readonly fxIn: AudioNode,
    private readonly fxOut: AudioNode,
  ) {
    this.input = gain(ctx, 1);
    this.output = gain(ctx, 1);
    this.dry = gain(ctx, 1);
    this.wet = gain(ctx, 0);
    this.input.connect(this.dry);
    this.dry.connect(this.output);
    this.input.connect(this.wet);
  }

  get active(): boolean {
    return this.on;
  }

  /** True while the effect is connected (active or fading out). */
  get processing(): boolean {
    return this.wired;
  }

  set(on: boolean, t: number, immediate = false): void {
    if (on === this.on) return;
    this.on = on;
    const gen = ++this.gen;
    if (on) {
      if (!this.wired) {
        this.wet.connect(this.fxIn);
        this.fxOut.connect(this.output);
        this.wired = true;
      }
      if (immediate) {
        this.wet.gain.value = 1;
        this.dry.gain.value = 0;
      } else {
        fade(this.wet.gain, 1, t);
        fade(this.dry.gain, 0, t);
      }
    } else {
      fade(this.wet.gain, 0, t);
      fade(this.dry.gain, 1, t);
      this.host.later(FADE * 1000 * 3 + 40, () => {
        if (gen !== this.gen || this.on || !this.wired) return;
        safeDisconnect(this.wet, this.fxIn);
        safeDisconnect(this.fxOut, this.output);
        this.wired = false;
      });
    }
  }

  dispose(): void {
    this.gen++;
    for (const n of [this.input, this.output, this.dry, this.wet]) safeDisconnect(n);
    safeDisconnect(this.fxOut);
  }
}

/** Low shelf, mid peak, high shelf. At 0 dB a biquad is an exact identity. */
class Eq3 {
  readonly low: BiquadFilterNode;
  readonly mid: BiquadFilterNode;
  readonly high: BiquadFilterNode;
  readonly insert: Insert;

  constructor(ctx: RackContext, host: RackHost) {
    this.low = ctx.createBiquadFilter();
    this.low.type = 'lowshelf';
    this.low.frequency.value = 220;
    this.mid = ctx.createBiquadFilter();
    this.mid.type = 'peaking';
    this.mid.frequency.value = 1000;
    this.mid.Q.value = 0.7;
    this.high = ctx.createBiquadFilter();
    this.high.type = 'highshelf';
    this.high.frequency.value = 4000;
    for (const f of [this.low, this.mid, this.high]) f.gain.value = 0;
    this.low.connect(this.mid);
    this.mid.connect(this.high);
    this.insert = new Insert(ctx, host, this.low, this.high);
  }

  set(low: number, mid: number, high: number, t: number): void {
    ramp(this.low.gain, low, t);
    ramp(this.mid.gain, mid, t);
    ramp(this.high.gain, high, t);
    this.insert.set(low !== 0 || mid !== 0 || high !== 0, t);
  }

  dispose(): void {
    this.insert.dispose();
    for (const f of [this.low, this.mid, this.high]) safeDisconnect(f);
  }
}

// ---------------------------------------------------------------------------------------------
// Sends: dry passes, the effect is added; disconnected once silent
// ---------------------------------------------------------------------------------------------

/** Stereo chorus: two modulated short delays (LFOs in opposite phase). */
class Chorus {
  readonly send: GainNode;
  private readonly split: ChannelSplitterNode;
  private readonly merge: ChannelMergerNode;
  private readonly dl: DelayNode;
  private readonly dr: DelayNode;
  private readonly depthL: GainNode;
  private readonly depthR: GainNode;
  private lfo: OscillatorNode | null = null;
  private wired = false;
  private gen = 0;
  private amount = 0;

  constructor(
    private readonly ctx: RackContext,
    private readonly host: RackHost,
    private readonly input: AudioNode,
    private readonly output: AudioNode,
    private readonly dry: GainNode,
  ) {
    this.send = stereo(ctx, 0);
    this.split = ctx.createChannelSplitter(2);
    this.merge = ctx.createChannelMerger(2);
    this.dl = ctx.createDelay(0.05);
    this.dr = ctx.createDelay(0.05);
    this.dl.delayTime.value = 0.014;
    this.dr.delayTime.value = 0.019;
    this.depthL = gain(ctx, 0.0025);
    this.depthR = gain(ctx, -0.0025);
    this.send.connect(this.split);
    this.split.connect(this.dl, 0);
    this.split.connect(this.dr, 1);
    this.dl.connect(this.merge, 0, 0);
    this.dr.connect(this.merge, 0, 1);
    this.depthL.connect(this.dl.delayTime);
    this.depthR.connect(this.dr.delayTime);
  }

  get processing(): boolean {
    return this.wired;
  }

  set(amount: number, t: number): void {
    const was = this.amount;
    this.amount = amount;
    if (amount > 0) {
      this.gen++;
      if (!this.wired) {
        const lfo = this.ctx.createOscillator();
        lfo.frequency.value = 0.8;
        lfo.connect(this.depthL);
        lfo.connect(this.depthR);
        lfo.start(t);
        this.lfo = lfo;
        this.input.connect(this.send);
        this.merge.connect(this.output);
        this.wired = true;
      }
      const depth = 0.0012 + 0.0028 * amount;
      ramp(this.depthL.gain, depth, t, 0.08);
      ramp(this.depthR.gain, -depth, t, 0.08);
      (was > 0 ? ramp : fade)(this.send.gain, 0.65 * amount, t);
      fade(this.dry.gain, 1 - 0.3 * amount, t);
    } else if (was > 0) {
      const gen = ++this.gen;
      fade(this.send.gain, 0, t);
      fade(this.dry.gain, 1, t);
      this.host.later(FADE * 1000 * 3 + 60, () => {
        if (gen !== this.gen || this.amount > 0 || !this.wired) return;
        this.unwire();
      });
    }
  }

  private unwire(): void {
    safeDisconnect(this.input, this.send);
    safeDisconnect(this.merge, this.output);
    if (this.lfo) {
      try {
        this.lfo.stop();
      } catch {
        /* not started */
      }
      safeDisconnect(this.lfo);
      this.lfo = null;
    }
    this.wired = false;
  }

  dispose(): void {
    this.gen++;
    this.unwire();
    for (const n of [this.send, this.split, this.merge, this.dl, this.dr, this.depthL, this.depthR]) safeDisconnect(n);
  }
}

/** One delay line with a darkening filter in its feedback loop. */
interface Line {
  delay: DelayNode;
  tone: BiquadFilterNode;
  fb: GainNode;
  out: GainNode;
}

/**
 * Tempo-synced feedback delay. A new delay time never sweeps the line (that bends the pitch of the
 * echoes): two lines listen to the send all the time, the silent one jumps to the new time and the
 * two crossfade.
 */
class Echo {
  readonly send: GainNode;
  private readonly lines: [Line, Line];
  private current = 0;
  private wired = false;
  private gen = 0;
  private amount = 0;
  private seconds = 0.375;
  private feedback = 0.3;

  constructor(
    ctx: RackContext,
    private readonly host: RackHost,
    private readonly input: AudioNode,
    private readonly output: AudioNode,
  ) {
    this.send = gain(ctx, 0);
    const line = (on: boolean): Line => {
      const delay = ctx.createDelay(MAX_DELAY);
      delay.delayTime.value = this.seconds;
      const tone = ctx.createBiquadFilter();
      tone.type = 'lowpass';
      tone.frequency.value = 3200;
      tone.Q.value = 0.5;
      const fb = gain(ctx, on ? this.feedback : 0);
      const out = gain(ctx, on ? 1 : 0);
      this.send.connect(delay);
      delay.connect(tone);
      tone.connect(fb);
      fb.connect(delay);
      tone.connect(out);
      return { delay, tone, fb, out };
    };
    this.lines = [line(true), line(false)];
  }

  get processing(): boolean {
    return this.wired;
  }

  /** Delay time in seconds currently set (tests). */
  get time(): number {
    return this.seconds;
  }

  set(amount: number, seconds: number, feedback: number, t: number): void {
    const was = this.amount;
    this.amount = amount;
    seconds = Math.max(0.02, Math.min(MAX_DELAY - 0.01, seconds));
    if (Math.abs(seconds - this.seconds) > 1e-6) {
      this.seconds = seconds;
      if (this.wired && was > 0) {
        // Swap lines: the silent one already holds the input history, so its first echo is right.
        const old = this.lines[this.current]!;
        this.current = 1 - this.current;
        const next = this.lines[this.current]!;
        next.delay.delayTime.cancelScheduledValues(t);
        next.delay.delayTime.setValueAtTime(seconds, t);
        fade(next.fb.gain, this.feedback, t, 0.08);
        fade(next.out.gain, 1, t, 0.08);
        fade(old.fb.gain, 0, t, 0.08);
        fade(old.out.gain, 0, t, 0.08);
      } else {
        for (const l of this.lines) {
          l.delay.delayTime.cancelScheduledValues(t);
          l.delay.delayTime.setValueAtTime(seconds, t);
        }
      }
    }
    if (feedback !== this.feedback) {
      this.feedback = feedback;
      ramp(this.lines[this.current]!.fb.gain, feedback, t);
    }
    if (amount > 0) {
      this.gen++;
      if (!this.wired) {
        this.input.connect(this.send);
        for (const l of this.lines) l.out.connect(this.output);
        this.wired = true;
      }
      (was > 0 ? ramp : fade)(this.send.gain, 0.55 * amount, t);
    } else if (was > 0) {
      const gen = ++this.gen;
      fade(this.send.gain, 0, t);
      // Disconnect once the echoes have died away (-60 dB).
      const fbk = Math.max(0.05, Math.min(0.9, this.feedback));
      const tail = Math.min(12, this.seconds * (Math.log(0.001) / Math.log(fbk) + 1));
      this.host.later(tail * 1000 + 200, () => {
        if (gen !== this.gen || this.amount > 0 || !this.wired) return;
        this.unwire();
      });
    }
  }

  private unwire(): void {
    safeDisconnect(this.input, this.send);
    for (const l of this.lines) safeDisconnect(l.out, this.output);
    this.wired = false;
  }

  dispose(): void {
    this.gen++;
    this.unwire();
    safeDisconnect(this.send);
    for (const l of this.lines) for (const n of [l.delay, l.tone, l.fb, l.out]) safeDisconnect(n);
  }
}

interface ReverbSlot {
  key: string;
  conv: ConvolverNode;
  level: GainNode;
  seconds: number;
}

/** Convolution reverb with crossfaded impulse switches. */
class Reverb {
  /** Send bus (amount); other sources (the groove) may feed it too. */
  readonly send: GainNode;
  private slot: ReverbSlot | null = null;
  private building: ImpulseBuilder | null = null;
  private buildKey = '';
  private readonly cache = new Map<string, AudioBuffer>();
  private wired = false;
  private gen = 0;
  private amount = 0;
  private disposed = false;
  /** Impulse switches completed (tests). */
  switches = 0;

  constructor(
    private readonly ctx: RackContext,
    private readonly host: RackHost,
    input: AudioNode,
    private readonly output: AudioNode,
  ) {
    this.send = gain(ctx, 0);
    input.connect(this.send);
  }

  get processing(): boolean {
    return this.wired;
  }

  get type(): string {
    return this.slot?.key ?? '';
  }

  setAmount(amount: number, t: number): void {
    const was = this.amount;
    this.amount = amount;
    if (amount > 0) {
      this.gen++;
      this.wire();
      (was > 0 ? ramp : fade)(this.send.gain, amount * 0.9, t, was > 0 ? 0.05 : FADE);
    } else if (was > 0) {
      const gen = ++this.gen;
      fade(this.send.gain, 0, t);
      const tail = this.slot ? this.slot.seconds : 3;
      this.host.later(tail * 1000 + 300, () => {
        if (gen !== this.gen || this.amount > 0) return;
        this.unwire();
      });
    }
  }

  /** Picks the impulse; built now when `sync`, else in slices between frames. */
  setType(type: ReverbType, lowPower: boolean, t: number, sync = false): void {
    const key = `${type}${lowPower ? ':low' : ''}`;
    if (this.slot?.key === key && !this.building) return;
    if (this.building && this.buildKey === key) return;
    const preset = presetFor(type, lowPower);
    const cached = this.cache.get(key);
    if (cached) {
      this.building = null;
      this.install(key, cached, preset, t, sync);
      return;
    }
    const b = new ImpulseBuilder(this.ctx, preset);
    this.building = b;
    this.buildKey = key;
    if (sync) {
      b.finish();
      this.building = null;
      this.remember(key, b.buffer);
      this.install(key, b.buffer, preset, t, true);
      return;
    }
    const run = (): void => {
      if (this.disposed || this.building !== b) return;
      if (!b.step()) {
        this.host.slice(run);
        return;
      }
      this.building = null;
      this.remember(key, b.buffer);
      this.install(key, b.buffer, preset, this.ctx.currentTime, false);
    };
    this.host.slice(run);
  }

  private remember(key: string, buf: AudioBuffer): void {
    this.cache.delete(key);
    this.cache.set(key, buf);
    while (this.cache.size > 2) {
      const first = this.cache.keys().next().value;
      if (first === undefined) break;
      this.cache.delete(first);
    }
  }

  private install(key: string, buffer: AudioBuffer, preset: ReverbPreset, t: number, immediate: boolean): void {
    const conv = this.ctx.createConvolver();
    conv.normalize = true;
    conv.buffer = buffer;
    const level = gain(this.ctx, immediate || !this.slot ? 1 : 0);
    level.connect(conv);
    const next: ReverbSlot = { key, conv, level, seconds: preset.seconds };
    const old = this.slot;
    this.slot = next;
    this.switches++;
    if (this.wired) {
      this.send.connect(level);
      conv.connect(this.output);
      if (!immediate && old) fade(level.gain, 1, t, 0.12);
    }
    if (old) {
      // The old room stops taking sound and rings out on its own (no dropout, no cut tail).
      if (this.wired) fade(old.level.gain, 0, t, 0.12);
      this.host.later(old.seconds * 1000 + 400, () => this.drop(old));
    }
  }

  private drop(s: ReverbSlot): void {
    safeDisconnect(this.send, s.level);
    safeDisconnect(s.level);
    safeDisconnect(s.conv);
  }

  private wire(): void {
    if (this.wired) return;
    this.wired = true;
    const s = this.slot;
    if (!s) return;
    s.level.gain.cancelScheduledValues(0);
    s.level.gain.value = 1;
    this.send.connect(s.level);
    s.conv.connect(this.output);
  }

  private unwire(): void {
    if (!this.wired) return;
    this.wired = false;
    if (this.slot) {
      safeDisconnect(this.send, this.slot.level);
      safeDisconnect(this.slot.conv, this.output);
    }
  }

  dispose(): void {
    this.disposed = true;
    this.gen++;
    this.building = null;
    if (this.slot) this.drop(this.slot);
    this.slot = null;
    this.cache.clear();
    safeDisconnect(this.send);
  }
}

// ---------------------------------------------------------------------------------------------
// Dynamics and image
// ---------------------------------------------------------------------------------------------

/** Mid/side width: L' = aL + bR, R' = aR + bL with a = (1+w)/2, b = (1-w)/2, w = 2 * width. */
class Width {
  readonly in: GainNode;
  readonly out: ChannelMergerNode;
  private readonly ll: GainNode;
  private readonly rr: GainNode;
  private readonly lr: GainNode;
  private readonly rl: GainNode;
  readonly insert: Insert;

  constructor(ctx: RackContext, host: RackHost) {
    this.in = stereo(ctx);
    const split = ctx.createChannelSplitter(2);
    this.out = ctx.createChannelMerger(2);
    this.ll = gain(ctx, 1);
    this.rr = gain(ctx, 1);
    this.lr = gain(ctx, 0);
    this.rl = gain(ctx, 0);
    this.in.connect(split);
    split.connect(this.ll, 0);
    split.connect(this.rl, 0);
    split.connect(this.rr, 1);
    split.connect(this.lr, 1);
    this.ll.connect(this.out, 0, 0);
    this.lr.connect(this.out, 0, 0);
    this.rr.connect(this.out, 0, 1);
    this.rl.connect(this.out, 0, 1);
    this.insert = new Insert(ctx, host, this.in, this.out);
  }

  set(width: number, on: boolean, t: number): void {
    const w = Math.max(0, Math.min(2, width * 2));
    const a = (1 + w) / 2;
    const b = (1 - w) / 2;
    ramp(this.ll.gain, a, t);
    ramp(this.rr.gain, a, t);
    ramp(this.lr.gain, b, t);
    ramp(this.rl.gain, b, t);
    this.insert.set(on && Math.abs(width - 0.5) > 1e-3, t);
  }

  dispose(): void {
    this.insert.dispose();
    for (const n of [this.in, this.out, this.ll, this.rr, this.lr, this.rl]) safeDisconnect(n);
  }
}

/** Soft ceiling: identity below 0.9, a tanh knee above, never past 0.995 (-0.04 dBFS). */
function clipCurve(n = 4097): Float32Array<ArrayBuffer> {
  const c = new Float32Array(n);
  const knee = 0.9;
  const room = 0.995 - knee;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    const ax = Math.abs(x);
    const y = ax <= knee ? ax : knee + room * Math.tanh((ax - knee) / room);
    c[i] = Math.sign(x) * y;
  }
  return c;
}

// ---------------------------------------------------------------------------------------------
// The rack
// ---------------------------------------------------------------------------------------------

export class StudioRack {
  /** Instrument bus in. */
  readonly input: GainNode;
  /** Side input (backing groove): own EQ, joins before the compressor. */
  readonly sideInput: GainNode;
  /** Reverb send bus: other sources may add to it (scaled by the reverb amount). */
  readonly reverbSend: GainNode;
  /** Rack out (feed the master volume). */
  readonly output: GainNode;

  private readonly eq: Eq3;
  private readonly sideEq: Eq3;
  private readonly chorusOut: GainNode;
  private readonly chorusDry: GainNode;
  private readonly chorus: Chorus;
  private readonly delayOut: GainNode;
  private readonly echo: Echo;
  private readonly reverbOut: GainNode;
  private readonly reverb: Reverb;
  private readonly comp: DynamicsCompressorNode;
  private readonly makeup: GainNode;
  private readonly compInsert: Insert;
  private readonly width: Width;
  private readonly limiter: DynamicsCompressorNode;
  private readonly clip: WaveShaperNode;
  private readonly sideSum: GainNode;
  private applied: RackSettings | null = null;

  constructor(
    private readonly ctx: RackContext,
    host: RackHost,
    initial: RackSettings,
  ) {
    this.input = gain(ctx, 1);
    this.sideInput = gain(ctx, 1);
    this.output = gain(ctx, 1);

    this.eq = new Eq3(ctx, host);
    this.input.connect(this.eq.insert.input);

    // Chorus: dry through chorusDry, wet added.
    this.chorusOut = gain(ctx, 1);
    this.chorusDry = gain(ctx, 1);
    this.eq.insert.output.connect(this.chorusDry);
    this.chorusDry.connect(this.chorusOut);
    this.chorus = new Chorus(ctx, host, this.eq.insert.output, this.chorusOut, this.chorusDry);

    // Delay: dry passes, echoes added.
    this.delayOut = gain(ctx, 1);
    this.chorusOut.connect(this.delayOut);
    this.echo = new Echo(ctx, host, this.chorusOut, this.delayOut);

    // Reverb: dry passes, room added.
    this.reverbOut = gain(ctx, 1);
    this.delayOut.connect(this.reverbOut);
    this.reverb = new Reverb(ctx, host, this.delayOut, this.reverbOut);
    this.reverbSend = this.reverb.send;

    this.sideEq = new Eq3(ctx, host);
    this.sideInput.connect(this.sideEq.insert.input);
    this.sideSum = gain(ctx, 1);
    this.reverbOut.connect(this.sideSum);
    this.sideEq.insert.output.connect(this.sideSum);

    // Bus compressor (+ makeup above the default amount).
    this.comp = ctx.createDynamicsCompressor();
    this.comp.knee.value = 8;
    this.comp.attack.value = 0.004;
    this.comp.release.value = 0.2;
    this.makeup = gain(ctx, 1);
    this.comp.connect(this.makeup);
    this.compInsert = new Insert(ctx, host, this.comp, this.makeup);
    this.sideSum.connect(this.compInsert.input);

    this.width = new Width(ctx, host);
    this.compInsert.output.connect(this.width.insert.input);

    // Limiter (the original: -1 dB, ratio 20, wide knee, fast) and a sample-exact safety ceiling.
    this.limiter = ctx.createDynamicsCompressor();
    this.limiter.threshold.value = -1;
    this.limiter.ratio.value = 20;
    this.limiter.knee.value = 30;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.01;
    this.clip = ctx.createWaveShaper();
    this.clip.curve = clipCurve();
    this.clip.oversample = 'none';
    this.width.insert.output.connect(this.limiter);
    this.limiter.connect(this.clip);
    this.clip.connect(this.output);

    this.apply(initial, ctx.currentTime, true);
  }

  configure(s: RackSettings, t = this.ctx.currentTime): void {
    this.apply(s, t, false);
  }

  private apply(s: RackSettings, t: number, first: boolean): void {
    const a = first ? null : this.applied;
    const changed = (...keys: (keyof RackSettings)[]): boolean => !a || keys.some((k) => a[k] !== s[k]);
    const lp = s.lowPower;
    if (changed('eqLow', 'eqMid', 'eqHigh')) {
      this.eq.set(s.eqLow, s.eqMid, s.eqHigh, t);
      this.sideEq.set(s.eqLow, s.eqMid, s.eqHigh, t);
    }
    if (changed('chorus', 'lowPower')) this.chorus.set(lp ? 0 : s.chorus, t);
    if (changed('delay', 'delayTime', 'delayFeedback', 'tempo', 'lowPower')) {
      this.echo.set(lp ? 0 : s.delay, noteSeconds(s.delayTime, s.tempo), s.delayFeedback, t);
    }
    if (changed('reverbType', 'lowPower')) this.reverb.setType(s.reverbType, lp, t, first);
    if (changed('reverb')) this.reverb.setAmount(s.reverb, t);
    if (changed('compressor')) {
      const c = Math.max(0, Math.min(1, s.compressor));
      if (first) {
        this.comp.threshold.value = -40 * c;
        this.comp.ratio.value = 1 + 5 * c;
        this.makeup.gain.value = db(Math.max(0, c - 0.4) * 8);
      } else {
        ramp(this.comp.threshold, -40 * c, t, 0.05);
        ramp(this.comp.ratio, 1 + 5 * c, t, 0.05);
        ramp(this.makeup.gain, db(Math.max(0, c - 0.4) * 8), t, 0.05);
      }
      this.compInsert.set(c > 0, t, first);
    }
    if (changed('width', 'lowPower')) this.width.set(s.width, !lp, t);
    this.applied = { ...s };
  }

  /** Which effects are connected right now (zero-cost bypass check). */
  stats(): Record<string, boolean | string | number> {
    return {
      eq: this.eq.insert.processing,
      sideEq: this.sideEq.insert.processing,
      chorus: this.chorus.processing,
      delay: this.echo.processing,
      delaySeconds: Number(this.echo.time.toFixed(4)),
      reverb: this.reverb.processing,
      reverbType: this.reverb.type,
      reverbSwitches: this.reverb.switches,
      compressor: this.compInsert.processing,
      width: this.width.insert.processing,
      compReduction: Number(this.comp.reduction.toFixed(2)),
      limiterReduction: Number(this.limiter.reduction.toFixed(2)),
    };
  }

  dispose(): void {
    this.eq.dispose();
    this.sideEq.dispose();
    this.chorus.dispose();
    this.echo.dispose();
    this.reverb.dispose();
    this.compInsert.dispose();
    this.width.dispose();
    for (const n of [this.input, this.sideInput, this.output, this.chorusOut, this.chorusDry, this.delayOut, this.reverbOut, this.sideSum, this.comp, this.makeup, this.limiter, this.clip]) {
      safeDisconnect(n);
    }
  }
}

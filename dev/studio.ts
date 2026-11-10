/**
 * Studio harness: measures the FX rack, concert pitch, transpose and timing.
 *
 *   window.__studioSelfTest()      offline rack renders + realtime click sweep + full engine checks
 *   window.__studioSoak(minutes)   the mock tracker plays while every studio setting keeps changing
 *
 * Run headless with dev/music-check.mjs:
 *   node dev/music-check.mjs http://localhost:5195/dev/studio.html "window.__studioSelfTest()"
 */
import { createMusicEngine } from '../src/music';
import { MockTracker } from '../src/dev/mockTracker';
import { DEFAULT_SETTINGS, NOTE_RATES, REVERB_TYPES, TIME_SIGNATURES, VELOCITY_CURVES } from '../src/settings';
import { StudioRack, noteSeconds, type RackHost, type RackSettings } from '../src/music/studio/rack';
import { REVERB_PRESETS } from '../src/music/studio/reverb';
import { METERS, swingSteps } from '../src/music/studio/meter';
import { studioVoice } from '../src/music/studio/voice';
import type { FaceState, FrameQuality, HandState, LooperState, Settings, TimeSignature, TrackingFrame } from '../src/types';

type Report = Record<string, unknown>;
const r2 = (v: number, d = 2): number => Number(v.toFixed(d));
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
const dbfs = (v: number): number => (v > 0 ? 20 * Math.log10(v) : -Infinity);

const errors: string[] = [];
/** Which test is running (tags the first occurrence of a console message). */
let phase = '';
window.addEventListener('error', (e) => errors.push(String(e.message)));
window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
for (const k of ['warn', 'error'] as const) {
  const orig = console[k].bind(console);
  console[k] = (...args: unknown[]) => {
    const msg = `${k}: ${args.map(String).join(' ')}`;
    // First time a message shows up, keep where it came from.
    if (!errors.some((e) => e.startsWith(msg))) errors.push(`${msg} [${phase}] @ ${(new Error().stack ?? '').split('\n').slice(2, 9).join(' | ')}`);
    else errors.push(msg);
    orig(...args);
  };
}

// ---------------------------------------------------------------------------------------------
// Offline rack
// ---------------------------------------------------------------------------------------------

const SR = 48000;
const NEUTRAL: RackSettings = {
  eqLow: 0,
  eqMid: 0,
  eqHigh: 0,
  chorus: 0,
  delay: 0,
  delayTime: '1/8d',
  delayFeedback: 0.3,
  reverb: 0,
  reverbType: 'hall',
  compressor: 0,
  width: 0.5,
  lowPower: false,
  tempo: 120,
};
const host: RackHost = { later: (ms, fn) => void setTimeout(fn, ms), slice: (fn) => void setTimeout(fn, 0) };

type Feed = (ctx: OfflineAudioContext, input: AudioNode) => void;

async function renderRack(s: RackSettings, seconds: number, feed: Feed): Promise<{ buf: AudioBuffer; ms: number; stats: Report }> {
  const ctx = new OfflineAudioContext(2, Math.round(SR * seconds), SR);
  const rack = new StudioRack(ctx, host, s);
  feed(ctx, rack.input);
  rack.output.connect(ctx.destination);
  const t0 = performance.now();
  const buf = await ctx.startRendering();
  const ms = performance.now() - t0;
  const stats = rack.stats();
  rack.dispose();
  return { buf, ms, stats };
}

const impulse = (at: number, amp: number): Feed => (ctx, input) => {
  const b = ctx.createBuffer(1, 4, SR);
  b.getChannelData(0)[0] = amp;
  const src = ctx.createBufferSource();
  src.buffer = b;
  src.connect(input);
  src.start(at);
};

const sine = (hz: number, amp: number): Feed => (ctx, input) => {
  const o = ctx.createOscillator();
  o.frequency.value = hz;
  const g = ctx.createGain();
  g.gain.value = amp;
  o.connect(g);
  g.connect(input);
  o.start(0);
};

const noise = (amp: number): Feed => (ctx, input) => {
  const len = SR * 2;
  const b = ctx.createBuffer(2, len, SR);
  for (let c = 0; c < 2; c++) {
    const d = b.getChannelData(c);
    let s = 12345 + c * 777;
    for (let i = 0; i < len; i++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      d[i] = (s / 0x7fffffff) * 2 - 1;
    }
  }
  const src = ctx.createBufferSource();
  src.buffer = b;
  src.loop = true;
  const g = ctx.createGain();
  g.gain.value = amp;
  src.connect(g);
  g.connect(input);
  src.start(0);
};

function peakOf(buf: AudioBuffer, from = 0, to = buf.length): { peak: number; at: number; nonFinite: number } {
  let peak = 0;
  let at = -1;
  let nonFinite = 0;
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const d = buf.getChannelData(c);
    for (let i = from; i < to; i++) {
      const v = d[i]!;
      if (!Number.isFinite(v)) {
        nonFinite++;
        continue;
      }
      const a = Math.abs(v);
      if (a > peak) {
        peak = a;
        at = i;
      }
    }
  }
  return { peak, at, nonFinite };
}

function rmsOf(d: Float32Array, from: number, to: number): number {
  let e = 0;
  for (let i = from; i < to; i++) e += d[i]! * d[i]!;
  return Math.sqrt(e / Math.max(1, to - from));
}

async function offlineTests(): Promise<Report> {
  const out: Report = {};

  // Neutral rack: what is connected, and its gain at -20 dBFS.
  {
    const { buf, stats } = await renderRack(NEUTRAL, 1, sine(440, 0.1));
    const level = rmsOf(buf.getChannelData(0), SR * 0.5, SR) * Math.SQRT2;
    out.neutral = { gainDb: r2(dbfs(level / 0.1)), connected: stats };
  }

  // Delay time vs tempo: impulse in, first echo position out.
  {
    const rows: Report[] = [];
    let worst = 0;
    for (const bpm of [90, 120, 140]) {
      for (const rate of NOTE_RATES) {
        const expected = noteSeconds(rate, bpm);
        const { buf } = await renderRack({ ...NEUTRAL, delay: 1, delayFeedback: 0, delayTime: rate, tempo: bpm }, expected + 0.4, impulse(0.05, 0.25));
        const dry = peakOf(buf, 0, Math.round(SR * 0.08));
        const echo = peakOf(buf, dry.at + Math.round(SR * 0.01), buf.length);
        const measured = (echo.at - dry.at) / SR;
        const err = Math.abs(measured - expected) * 1000;
        worst = Math.max(worst, err);
        rows.push({ bpm, rate, expectedMs: r2(expected * 1000, 1), measuredMs: r2(measured * 1000, 1), errMs: r2(err, 2) });
      }
    }
    out.delayTiming = { worstErrMs: r2(worst, 2), ok: worst < 1, rows };
  }

  // Everything maxed with a hot input: the limiter + ceiling keep peaks under 0 dBFS, no NaN.
  {
    const hot: RackSettings = { eqLow: 12, eqMid: 12, eqHigh: 12, chorus: 1, delay: 1, delayTime: '1/16', delayFeedback: 0.9, reverb: 1, reverbType: 'cathedral', compressor: 1, width: 1, lowPower: false, tempo: 160 };
    const feed: Feed = (ctx, input) => {
      sine(110, 2)(ctx, input);
      sine(3000, 1)(ctx, input);
      for (let k = 0; k < 6; k++) impulse(0.3 + k * 0.4, 8)(ctx, input);
    };
    const { buf } = await renderRack(hot, 3, feed);
    const p = peakOf(buf);
    out.limiter = { inputPeakDb: r2(dbfs(11)), outputPeakDb: r2(dbfs(p.peak), 3), nonFinite: p.nonFinite, ok: p.peak < 1 && p.nonFinite === 0 };
  }

  // Compression blends: dry and compressed paths are time-aligned (one impulse out, not two).
  {
    const rows: Report = {};
    for (const compressor of [0, 0.2, 0.4, 0.7, 1]) {
      const { buf } = await renderRack({ ...NEUTRAL, compressor }, 0.3, impulse(0.05, 0.02));
      const d = buf.getChannelData(0);
      const p = peakOf(buf);
      let peaks = 0;
      let last = -1e9;
      for (let i = 0; i < d.length; i++) {
        if (Math.abs(d[i]!) > p.peak * 0.2 && i - last > SR * 0.001) {
          peaks++;
          last = i;
        }
      }
      rows[String(compressor)] = { peaks, latencyMs: r2(((p.at - SR * 0.05) / SR) * 1000, 2), gainDb: r2(dbfs(p.peak / 0.02), 2) };
    }
    out.compressorBlend = rows;
  }

  // EQ: gain at the band centres.
  {
    const base = async (hz: number) => rmsOf((await renderRack(NEUTRAL, 0.6, sine(hz, 0.05))).buf.getChannelData(0), SR * 0.3, SR * 0.6);
    const band = async (patch: Partial<RackSettings>, hz: number) => rmsOf((await renderRack({ ...NEUTRAL, ...patch }, 0.6, sine(hz, 0.05))).buf.getChannelData(0), SR * 0.3, SR * 0.6);
    out.eq = {
      lowPlus12At60Hz: r2(dbfs((await band({ eqLow: 12 }, 60)) / (await base(60)))),
      midMinus12At1k: r2(dbfs((await band({ eqMid: -12 }, 1000)) / (await base(1000)))),
      highPlus12At10k: r2(dbfs((await band({ eqHigh: 12 }, 10000)) / (await base(10000)))),
    };
  }

  // Width: side / mid energy for two uncorrelated channels (1 = natural, 0 = mono).
  {
    const stereoIn: Feed = (ctx, input) => {
      const m = ctx.createChannelMerger(2);
      const a = ctx.createOscillator();
      const b = ctx.createOscillator();
      a.frequency.value = 300;
      b.frequency.value = 470;
      const ga = ctx.createGain();
      const gb = ctx.createGain();
      ga.gain.value = gb.gain.value = 0.08;
      a.connect(ga).connect(m, 0, 0);
      b.connect(gb).connect(m, 0, 1);
      m.connect(input);
      a.start();
      b.start();
    };
    const ratio = async (width: number) => {
      const { buf } = await renderRack({ ...NEUTRAL, width }, 0.6, stereoIn);
      const L = buf.getChannelData(0);
      const R = buf.getChannelData(1);
      let mid = 0;
      let side = 0;
      for (let i = SR * 0.3; i < SR * 0.6; i++) {
        mid += ((L[i]! + R[i]!) / 2) ** 2;
        side += ((L[i]! - R[i]!) / 2) ** 2;
      }
      return r2(side / mid, 3);
    };
    out.width = { sideOverMid_0: await ratio(0), sideOverMid_05: await ratio(0.5), sideOverMid_1: await ratio(1) };
  }

  // Reverb types: RT60 from the Schroeder decay of an impulse.
  {
    const rows: Report = {};
    for (const type of [...REVERB_TYPES, 'hall:lowPower'] as const) {
      const lp = type === 'hall:lowPower';
      const rt = lp ? 'hall' : type;
      const seconds = (lp ? 1.3 : REVERB_PRESETS[rt].seconds) + 0.6;
      const { buf } = await renderRack({ ...NEUTRAL, reverb: 1, reverbType: rt, lowPower: lp }, seconds, impulse(0.05, 0.05));
      const dry = peakOf(buf, 0, Math.round(SR * 0.08));
      const d = buf.getChannelData(0);
      const start = dry.at + 3;
      const e = new Float64Array(d.length - start);
      let acc = 0;
      for (let i = d.length - 1; i >= start; i--) {
        acc += d[i]! * d[i]!;
        e[i - start] = acc;
      }
      const total = e[0]!;
      const at = (dbDown: number) => {
        const th = total * Math.pow(10, -dbDown / 10);
        for (let i = 0; i < e.length; i++) if (e[i]! <= th) return i / SR;
        return NaN;
      };
      rows[type] = { rt60s: r2(2 * (at(35) - at(5)), 2), irSeconds: lp ? 1.3 : REVERB_PRESETS[rt].seconds, preDelayMs: REVERB_PRESETS[rt].preDelay * 1000 };
    }
    out.reverbDecay = rows;
  }

  // CPU: seconds of audio rendered per second of compute (offline, one core).
  {
    const allOn: RackSettings = { eqLow: 4, eqMid: -3, eqHigh: 5, chorus: 0.6, delay: 0.5, delayTime: '1/8d', delayFeedback: 0.5, reverb: 0.6, reverbType: 'cathedral', compressor: 0.7, width: 0.8, lowPower: false, tempo: 120 };
    const configs: Record<string, RackSettings> = {
      bypassed: NEUTRAL,
      defaults: { ...NEUTRAL, reverb: DEFAULT_SETTINGS.reverb, compressor: DEFAULT_SETTINGS.compressor },
      allOn,
      allOnLowPower: { ...allOn, lowPower: true },
    };
    const rows: Report = {};
    for (const [name, s] of Object.entries(configs)) {
      const { ms, stats } = await renderRack(s, 20, noise(0.1));
      rows[name] = { renderMsFor20s: Math.round(ms), xRealtime: r2(20000 / ms, 1), connected: Object.entries(stats).filter(([k, v]) => v === true && !k.startsWith('side')).map(([k]) => k).join(',') };
    }
    out.cpu = rows;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Realtime: clicks and dropouts while every rack parameter keeps changing
// ---------------------------------------------------------------------------------------------

async function realtimeSweep(seconds: number, mutate: ((s: RackSettings, i: number) => RackSettings) | null, intervalMs: number, hz = 220) {
  const ctx = new AudioContext({ latencyHint: 'interactive' });
  await ctx.resume();
  const sr = ctx.sampleRate;
  let s: RackSettings = { ...NEUTRAL };
  const rack = new StudioRack(ctx, host, s);
  const osc = ctx.createOscillator();
  osc.frequency.value = hz;
  const g = ctx.createGain();
  g.gain.value = 0.06;
  osc.connect(g).connect(rack.input);
  osc.start();
  // Capture in an AudioWorklet: sample-exact, no dropped blocks when the main thread is busy.
  const code = `registerProcessor('cap', class extends AudioWorkletProcessor {
    constructor() { super(); this.buf = new Float32Array(4096); this.n = 0; }
    process(inputs) {
      const x = inputs[0] && inputs[0][0];
      const len = x ? x.length : 128;
      for (let i = 0; i < len; i++) {
        this.buf[this.n++] = x ? x[i] : 0;
        if (this.n === this.buf.length) { this.port.postMessage(this.buf); this.buf = new Float32Array(4096); this.n = 0; }
      }
      return true;
    }
  });`;
  const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
  await ctx.audioWorklet.addModule(url);
  URL.revokeObjectURL(url);
  const cap = new AudioWorkletNode(ctx, 'cap', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit' });
  rack.output.connect(cap);
  const N = Math.round(seconds * sr);
  const L = new Float32Array(N);
  let w = 0;
  let skip = Math.round(sr * 0.4);
  const done = new Promise<void>((res) => {
    cap.port.onmessage = (e: MessageEvent<Float32Array>) => {
      const x = e.data;
      for (let i = 0; i < x.length; i++) {
        if (skip > 0) {
          skip--;
          continue;
        }
        if (w < N) L[w++] = x[i]!;
      }
      if (w >= N) res();
    };
  });
  let i = 0;
  const timer = mutate
    ? window.setInterval(() => {
        s = mutate(s, i++);
        rack.configure(s);
      }, intervalMs)
    : 0;
  await done;
  window.clearInterval(timer);
  cap.port.onmessage = null;
  cap.disconnect();
  osc.stop();
  rack.dispose();
  await ctx.close();

  // Clicks: second difference against what a sine of the local amplitude can do.
  const w2 = Math.pow((2 * Math.PI * hz) / sr, 2);
  const B = 256;
  const blocks = Math.floor(N / B);
  const amp = new Float32Array(blocks);
  for (let b = 0; b < blocks; b++) {
    let m = 0;
    for (let k = b * B; k < (b + 1) * B; k++) m = Math.max(m, Math.abs(L[k]!));
    amp[b] = m;
  }
  // Where echoes nearly cancel the signal the local level is tiny and any residue looks huge:
  // never normalize by less than -20 dB under the run's median level.
  const sorted = Array.from(amp).sort((x, y) => x - y);
  const floor = 0.1 * (sorted[Math.floor(sorted.length / 2)] ?? 0);
  let maxRatio = 0;
  let worstStep = 0;
  let clicks = 0;
  let nonFinite = 0;
  for (let k = 1; k < N - 1; k++) {
    if (!Number.isFinite(L[k]!)) {
      nonFinite++;
      continue;
    }
    const b = Math.floor(k / B);
    const a = Math.max(amp[b]!, amp[Math.max(0, b - 1)]!, amp[Math.min(blocks - 1, b + 1)]!, floor, 1e-4);
    const d2 = Math.abs(L[k + 1]! - 2 * L[k]! + L[k - 1]!);
    const ratio = d2 / (a * w2);
    if (ratio > maxRatio) {
      maxRatio = ratio;
      worstStep = d2;
    }
    if (ratio > 6) clicks++;
  }
  // Dropouts / jumps: 10 ms RMS envelope.
  const W = Math.round(sr * 0.01);
  let minStep = Infinity;
  let maxStep = 0;
  let minRms = Infinity;
  let prev = -1;
  for (let k = 0; k + W <= N; k += W) {
    const r = rmsOf(L, k, k + W);
    minRms = Math.min(minRms, r);
    if (prev > 0) {
      minStep = Math.min(minStep, r / prev);
      maxStep = Math.max(maxStep, r / prev);
    }
    prev = r;
  }
  return { changes: i, maxClickRatio: r2(maxRatio, 2), worstStepDbfs: r2(dbfs(worstStep), 1), samplesOverClickThreshold: clicks, nonFinite, rmsMinDb: r2(dbfs(minRms)), envStepMinDb: r2(dbfs(minStep)), envStepMaxDb: r2(dbfs(maxStep)) };
}

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const pickOf = <T>(list: readonly T[]): T => list[Math.floor(Math.random() * list.length)]!;
const maybe = (p: number, v: number, off: number) => (Math.random() < p ? off : v);

async function realtimeTests(): Promise<Report> {
  const control = await realtimeSweep(6, null, 1000);
  // Every rack parameter except the reverb (a reverb tail is broadband by nature, see below).
  const sweep = await realtimeSweep(
    10,
    (s, i) => ({
      ...s,
      eqLow: maybe(0.3, r2(rnd(-12, 12), 1), 0),
      eqMid: maybe(0.3, r2(rnd(-12, 12), 1), 0),
      eqHigh: maybe(0.3, r2(rnd(-12, 12), 1), 0),
      chorus: maybe(0.35, r2(rnd(0, 1)), 0),
      delay: maybe(0.35, r2(rnd(0, 1)), 0),
      delayTime: pickOf(NOTE_RATES),
      delayFeedback: r2(rnd(0, 0.9)),
      compressor: maybe(0.25, r2(rnd(0, 1)), 0),
      width: maybe(0.3, r2(rnd(0, 1)), 0.5),
      lowPower: i % 23 === 22 ? !s.lowPower : s.lowPower,
      tempo: Math.round(rnd(60, 160)),
    }),
    70,
  );
  // The same with the compressor left at its default (separates compressor pumping from clicks).
  const sweepFixedComp = await realtimeSweep(
    10,
    (s, i) => ({
      ...s,
      eqLow: maybe(0.3, r2(rnd(-12, 12), 1), 0),
      eqMid: maybe(0.3, r2(rnd(-12, 12), 1), 0),
      eqHigh: maybe(0.3, r2(rnd(-12, 12), 1), 0),
      chorus: maybe(0.35, r2(rnd(0, 1)), 0),
      delay: maybe(0.35, r2(rnd(0, 1)), 0),
      delayTime: pickOf(NOTE_RATES),
      delayFeedback: r2(rnd(0, 0.9)),
      compressor: 0.4,
      width: maybe(0.3, r2(rnd(0, 1)), 0.5),
      lowPower: i % 23 === 22 ? !s.lowPower : s.lowPower,
      tempo: Math.round(rnd(60, 160)),
    }),
    70,
  );
  // With the reverb: type switches and amounts. Checks the level never drops out or jumps.
  const reverb = await realtimeSweep(
    10,
    (s, i) => ({
      ...s,
      reverb: i % 5 === 4 ? 0 : r2(rnd(0.2, 1)),
      reverbType: i % 2 ? pickOf(REVERB_TYPES) : s.reverbType,
      lowPower: i % 11 === 10 ? !s.lowPower : s.lowPower,
      compressor: 0.4,
    }),
    300,
  );
  // One parameter at a time (localizes any click).
  const per: Report = {};
  const one: Record<string, (s: RackSettings, i: number) => RackSettings> = {
    eq: (s) => ({ ...s, eqLow: maybe(0.3, r2(rnd(-12, 12), 1), 0), eqMid: maybe(0.3, r2(rnd(-12, 12), 1), 0), eqHigh: maybe(0.3, r2(rnd(-12, 12), 1), 0) }),
    chorus: (s) => ({ ...s, chorus: maybe(0.35, r2(rnd(0, 1)), 0) }),
    delay: (s) => ({ ...s, delay: maybe(0.35, r2(rnd(0, 1)), 0), delayFeedback: r2(rnd(0, 0.9)) }),
    delayTime: (s) => ({ ...s, delay: 0.6, delayTime: pickOf(NOTE_RATES), tempo: Math.round(rnd(60, 160)) }),
    compressor: (s) => ({ ...s, compressor: maybe(0.25, r2(rnd(0, 1)), 0) }),
    width: (s) => ({ ...s, width: maybe(0.3, r2(rnd(0, 1)), 0.5) }),
    lowPower: (s) => ({ ...s, chorus: 0.5, delay: 0.5, width: 0.8, lowPower: !s.lowPower }),
  };
  for (const [name, fn] of Object.entries(one)) {
    const r = await realtimeSweep(3.5, fn, name === 'lowPower' ? 400 : 70);
    per[name] = { maxClickRatio: r.maxClickRatio, over: r.samplesOverClickThreshold, envStepMinDb: r.envStepMinDb, envStepMaxDb: r.envStepMaxDb };
  }
  return {
    perParameter: per,
    note: 'clickRatio = |2nd difference| / (local amplitude * w^2); a pure sine is <= 1, a click is >> 6',
    control,
    // Everything changing at once every 70 ms: no step above 2 % of the local level (ratio 24).
    allButReverb: { ...sweep, ok: sweep.maxClickRatio < 24 && sweep.nonFinite === 0 },
    allButReverbCompAtDefault: { ...sweepFixedComp, ok: sweepFixedComp.maxClickRatio < 24 && sweepFixedComp.nonFinite === 0 },
    reverbSwitching: { ...reverb, ok: reverb.nonFinite === 0 && reverb.envStepMinDb > -6 && reverb.envStepMaxDb < 6 },
  };
}

// ---------------------------------------------------------------------------------------------
// Full engine
// ---------------------------------------------------------------------------------------------

const engine = createMusicEngine();
interface Inner {
  ctx: { sampleRate: number; currentTime: number; createAnalyser(): AnalyserNode; transport: { PPQ: number } };
  master: { connect(n: unknown): unknown };
  rack: StudioRack;
  groove: { schedule(s: number, time: number, six: number, offset: number): void };
  lead: { part: { onGrid(step: number, time: number, ...rest: unknown[]): void } };
  mouthDynamics(face: FaceState | null, closeTh: number): number;
}
const inner = engine as unknown as Inner;

const QUALITY: FrameQuality = { score: 1, verdict: 'great', ideal: true, brightness: 0.5, handScale: 0.3 };
const OPEN: HandState['fingers'] = [true, true, true, true, true];
function hand(id: number, side: 'left' | 'right', x: number, y: number, fingers: HandState['fingers'] = OPEN): HandState {
  return {
    id,
    side,
    landmarks: Array.from({ length: 21 }, () => ({ x, y, z: 0 })),
    box: { x: x - 0.08, y: y - 0.05, w: 0.16, h: 0.3 },
    indexTip: { x, y },
    thumbTip: { x: x - 0.04, y: y + 0.05 },
    pinch: 0,
    pinching: false,
    fingersUp: fingers.filter(Boolean).length,
    fingers,
    roll: 0,
    thumbOut: false,
    gesture: 'open',
    score: 0.95,
    age: 1000,
  };
}
function face(mouthOpen: number): FaceState {
  return { box: { x: 0.4, y: 0.2, w: 0.2, h: 0.35 }, mouthOpen, mouthIsOpen: mouthOpen > 0.22, pucker: 0, smile: 0, browUp: 0, outerLips: [], innerLips: [], mouthCenter: { x: 0.5, y: 0.47 } };
}
function frame(hands: HandState[], f: FaceState | null = null): TrackingFrame {
  return { t: performance.now(), hands, face: f, fps: 30, quality: QUALITY, video: { width: 1280, height: 720 } };
}

let settings: Settings = { ...DEFAULT_SETTINGS, gestures: { ...DEFAULT_SETTINGS.gestures } };
function configure(patch: Partial<Settings>): void {
  settings = { ...settings, ...patch };
  engine.configure(settings);
}

let probe: AnalyserNode | null = null;
let probeBuf: Float32Array<ArrayBuffer> | null = null;
/** Peak and finiteness of the master output since the last call (2048 samples > one frame). */
function readPeak(): { peak: number; nonFinite: number } {
  if (!probe) {
    probe = inner.ctx.createAnalyser();
    probe.fftSize = 2048;
    inner.master.connect(probe);
    probeBuf = new Float32Array(probe.fftSize);
  }
  probe.getFloatTimeDomainData(probeBuf!);
  let peak = 0;
  let nonFinite = 0;
  for (const v of probeBuf!) {
    if (!Number.isFinite(v)) nonFinite++;
    else peak = Math.max(peak, Math.abs(v));
  }
  return { peak, nonFinite };
}

async function drive(make: (k: number) => TrackingFrame, ms: number) {
  const end = performance.now() + ms;
  let peak = 0;
  let nonFinite = 0;
  let k = 0;
  let voices = engine.update(make(k++));
  while (performance.now() < end) {
    voices = engine.update(make(k++));
    const p = readPeak();
    peak = Math.max(peak, p.peak);
    nonFinite += p.nonFinite;
    if (!Number.isFinite(engine.level())) nonFinite++;
    await sleep(33);
  }
  return { peak, nonFinite, voices: voices.map((v) => ({ ...v })) };
}

/** Pitch of the master output: FFT peak (parabolic) near `expected`, and zero crossings. */
async function measurePitch(expected: number): Promise<{ fft: number; zc: number }> {
  const an = inner.ctx.createAnalyser();
  an.fftSize = 32768;
  an.smoothingTimeConstant = 0;
  inner.master.connect(an);
  await sleep(800);
  const sr = inner.ctx.sampleRate;
  const fd = new Float32Array(an.frequencyBinCount);
  an.getFloatFrequencyData(fd);
  const binHz = sr / an.fftSize;
  const lo = Math.floor((expected * 0.9) / binHz);
  const hi = Math.ceil((expected * 1.1) / binHz);
  let best = lo;
  for (let i = lo; i <= hi; i++) if (fd[i]! > fd[best]!) best = i;
  const a = fd[best - 1]!;
  const b = fd[best]!;
  const c = fd[best + 1]!;
  const fft = (best + (0.5 * (a - c)) / (a - 2 * b + c)) * binHz;
  const td = new Float32Array(an.fftSize);
  an.getFloatTimeDomainData(td);
  let first = -1;
  let last = -1;
  let n = 0;
  for (let i = 1; i < td.length; i++) {
    if (td[i - 1]! < 0 && td[i]! >= 0) {
      const x = i - 1 + td[i - 1]! / (td[i - 1]! - td[i]!);
      if (first < 0) first = x;
      last = x;
      n++;
    }
  }
  (an as AudioNode).disconnect();
  return { fft, zc: n > 1 ? ((n - 1) * sr) / (last - first) : NaN };
}

const cents = (f: number, ref: number) => 1200 * Math.log2(f / ref);

function waitLoaded(id: string): Promise<void> {
  return new Promise((res) => {
    let unsub: (() => void) | null = null;
    unsub = engine.onLoadState((s) => {
      if (s.id === id && !s.loading && s.progress >= 1) {
        queueMicrotask(() => unsub?.());
        res();
      }
    });
    setTimeout(res, 20000);
  });
}

async function setLead(id: string): Promise<void> {
  const w = waitLoaded(id);
  configure({ lead: id });
  await w;
}

async function engineTests(): Promise<Report> {
  const out: Report = {};
  await engine.unlock();
  configure({ ...DEFAULT_SETTINGS, gestures: { ...DEFAULT_SETTINGS.gestures }, mode: 'melody', trigger: 'always', leftHand: 'off', groove: false });
  engine.setPlayZone({ y0: 0.1, y1: 0.86 });

  // 1. Tuning and transpose: measured pitch of a synth and a sampled instrument.
  phase = 'engine 1';
  {
    const dry: Partial<Settings> = { reverb: 0, delay: 0, chorus: 0 };
    configure(dry);
    const rows: Report[] = [];
    let worst = 0;
    const cases: [string, number, number][] = [
      ['square-lead', 440, 0],
      ['square-lead', 432, 0],
      ['square-lead', 415, 0],
      ['square-lead', 466, 0],
      ['square-lead', 440, 7],
      ['square-lead', 432, -12],
      ['flute', 440, 0],
      ['flute', 432, 0],
      ['flute', 440, -5],
      ['flute', 452, 3],
    ];
    for (const [id, tuning, transpose] of cases) {
      await setLead(id);
      configure({ tuning, transpose });
      const r = await drive(() => frame([hand(0, 'right', 0.7, 0.5)]), 400);
      const written = r.voices[0]!.midi!;
      const expected = tuning * Math.pow(2, (written + transpose - 69) / 12);
      const p = await measurePitch(expected);
      await drive(() => frame([hand(0, 'right', 0.7, 0.5)]), 50);
      const errFft = cents(p.fft, expected);
      worst = Math.max(worst, Math.abs(errFft));
      rows.push({ id, tuning, transpose, written, note: r.voices[0]!.note, expectedHz: r2(expected, 2), fftHz: r2(p.fft, 2), errCentsFft: r2(errFft, 2) });
      await drive(() => frame([]), 300);
    }
    // Retune while holding: the note glides to the new concert pitch.
    await setLead('square-lead');
    configure({ tuning: 440, transpose: 0 });
    const held = await drive(() => frame([hand(0, 'right', 0.7, 0.5)]), 400);
    configure({ tuning: 432 });
    await drive(() => frame([hand(0, 'right', 0.7, 0.5)]), 300);
    const w = held.voices[0]!.midi!;
    const expHeld = 432 * Math.pow(2, (w - 69) / 12);
    const ph = await measurePitch(expHeld);
    const heldErr = cents(ph.fft, expHeld);
    out.tuning = {
      worstErrCents: r2(worst, 2),
      cents432vs440: r2(cents(432, 440), 2),
      heldNoteRetunedTo432: { expectedHz: r2(expHeld, 2), measuredHz: r2(ph.fft, 2), errCents: r2(heldErr, 2) },
      // The flute's samples sit a few cents sharp of themselves; what matters is the change.
      fluteShift432vs440Cents: r2(cents(rows[7]!.fftHz as number, rows[6]!.fftHz as number), 2),
      fluteShiftTranspose5DownCents: r2(cents(rows[8]!.fftHz as number, rows[6]!.fftHz as number), 2),
      synthWorstErrCents: r2(Math.max(...rows.slice(0, 6).map((r) => Math.abs(r.errCentsFft as number))), 3),
      ok: Math.max(...rows.slice(0, 6).map((r) => Math.abs(r.errCentsFft as number))) < 1 && Math.abs(heldErr) < 1 && Math.abs(cents(rows[7]!.fftHz as number, rows[6]!.fftHz as number) - cents(432, 440)) < 1,
      rows,
    };
    configure({ tuning: 440, transpose: 0 });
    await drive(() => frame([]), 400);
  }

  // 2. MIDI out / looper see the written note; the sound is transposed (tap check).
  phase = 'engine 2';
  {
    const notes: number[] = [];
    configure({ transpose: 5 });
    const player = (engine as unknown as { lead: { player: { tap: { on: (...a: unknown[]) => void } | null } } }).lead.player!;
    const orig = player.tap!.on;
    player.tap!.on = (...a: unknown[]) => {
      notes.push(a[2] as number);
      orig(...a);
    };
    const seen = new Set<number>();
    await drive(() => {
      const st = engine.update(frame([hand(0, 'right', 0.7, 0.3)]));
      if (st[0]!.midi !== null) seen.add(st[0]!.midi);
      return frame([hand(0, 'right', 0.7, 0.3)]);
    }, 300);
    player.tap!.on = orig;
    out.transposeTap = { voiceNotes: [...seen], tapNotes: notes, midiOutNotes: notes.map((n) => n + studioVoice.transpose), ok: notes.length > 0 && notes.every((n) => seen.has(n)) };
    configure({ transpose: 0 });
    await drive(() => frame([]), 300);
  }

  // 3. Time signatures: bar:beat readout and the beat's bar length.
  phase = 'engine 3';
  {
    const rows: Report = {};
    const calls: { s: number; off: number }[] = [];
    const g = inner.groove;
    const orig = g.schedule.bind(g);
    g.schedule = (s, time, six, off) => {
      calls.push({ s, off });
      orig(s, time, six, off);
    };
    for (const ts of TIME_SIGNATURES) {
      configure({ groove: false });
      await drive(() => frame([]), 800);
      configure({ timeSignature: ts, tempo: 160, groove: true, beat: 'pop' });
      calls.length = 0;
      const seen: string[] = [];
      let maxBeat = 0;
      let maxBar = 0;
      await drive(() => {
        const m = engine.metrics();
        const key = `${m.bar}:${m.beat}`;
        if (m.bar && seen[seen.length - 1] !== key) seen.push(key);
        maxBeat = Math.max(maxBeat, m.beat);
        maxBar = Math.max(maxBar, m.bar);
        return frame([]);
      }, 4200);
      const meter = METERS[ts];
      const stepsPerBar = Math.max(...calls.map((c) => c.s)) + 1;
      // Every beat is seen in order within the first complete bars.
      const expectSeq = Array.from({ length: meter.beats }, (_, i) => `2:${i + 1}`).join(' ');
      const bar2 = seen.filter((x) => x.startsWith('2:')).join(' ');
      rows[ts] = { beatsPerBar: maxBeat, expected: meter.beats, sixteenthsPerBar: stepsPerBar, expectedSteps: meter.steps, bars: maxBar, bar2, ok: maxBeat === meter.beats && stepsPerBar === meter.steps && bar2 === expectSeq };
    }
    // Switch while playing: 4/4 -> 7/8 lands on a bar line.
    configure({ groove: false });
    await drive(() => frame([]), 800);
    configure({ timeSignature: '4/4', groove: true });
    await drive(() => frame([]), 1000);
    calls.length = 0;
    await drive(() => frame([]), 1600);
    configure({ timeSignature: '7/8' });
    await drive(() => frame([]), 4000);
    // Bar lengths (sixteenths between downbeats): complete 4/4 bars, then complete 7/8 bars.
    const lens: number[] = [];
    let since = -1;
    let contiguous = true;
    for (let i = 0; i < calls.length; i++) {
      if (i > 0 && calls[i]!.s !== 0 && calls[i]!.s !== calls[i - 1]!.s + 1) contiguous = false;
      if (calls[i]!.s === 0) {
        if (since >= 0) lens.push(i - since);
        since = i;
      }
    }
    const firstSeven = lens.indexOf(14);
    const ok = contiguous && firstSeven > 0 && lens.slice(0, firstSeven).every((n) => n === 16) && lens.slice(firstSeven).every((n) => n === 14);
    rows.switch4to7 = { barLengths: lens.join(','), calls: calls.length, head: calls.slice(0, 20).map((c) => c.s).join(','), contiguous, ok };
    g.schedule = orig;
    out.meters = rows;
    configure({ groove: false, timeSignature: '4/4' });
    await drive(() => frame([]), 800);
  }

  // 4. Swing: offsets the beat and the arpeggiator get (in sixteenths and ms at 120 BPM).
  phase = 'engine 4';
  {
    const rows: Report[] = [];
    const g = inner.groove;
    const origG = g.schedule.bind(g);
    const part = inner.lead.part;
    const origP = part.onGrid.bind(part);
    for (const [beat, ts, swing] of [
      ['pop', '4/4', 0],
      ['pop', '4/4', 0.3],
      ['pop', '4/4', 0.6],
      ['house', '4/4', 0.6],
      ['rock', '6/8', 0.6],
    ] as const) {
      configure({ groove: false, mode: 'chords', chordPlay: 'arp', lead: 'grand-piano' });
      await waitLoaded('grand-piano');
      await drive(() => frame([]), 800);
      const grid = new Map<number, number>();
      const got: Record<number, number> = {};
      const count: Record<number, number> = {};
      const arp: Record<number, number> = {};
      g.schedule = (s, time, six, off) => {
        got[s] = off;
        count[s] = (count[s] ?? 0) + 1;
        grid.set(Math.round(time * 1000), s);
        origG(s, time, six, off);
      };
      part.onGrid = (step, time, ...rest) => {
        arp[step % 4] = time;
        origP(step, time, ...rest);
      };
      configure({ groove: true, beat, timeSignature: ts as TimeSignature, swing, tempo: 120 });
      // More than a bar (2 s at 120 BPM) so every sixteenth of the bar is seen.
      await drive(() => frame([hand(1, 'left', 0.25, 0.5, [false, true, false, false, false])]), 2600);
      g.schedule = origG;
      part.onGrid = origP;
      const six = 15 / 120;
      const expected = [0, 1, 2, 3].map((s) => (swing > 0 ? swingSteps(s, swing, beat === 'house' || METERS[ts as TimeSignature].eighths) : s % 2 ? ({ pop: 0.08, house: 0.04, rock: 0 } as Record<string, number>)[beat]! : 0));
      const measured = [0, 1, 2, 3].map((s) => got[s] ?? NaN);
      rows.push({ beat, ts, swing, offsetsSixteenths: measured.map((v) => r2(v, 3)), expected: expected.map((v) => r2(v, 3)), offsetsMs: measured.map((v) => r2(v * six * 1000, 1)), stepsSeen: JSON.stringify(count), ok: measured.every((v, i) => Math.abs(v - expected[i]!) < 1e-6) });
    }
    out.swing = rows;
    configure({ groove: false, mode: 'melody', swing: 0, timeSignature: '4/4' });
    await drive(() => frame([]), 600);
  }

  // 5. Delay time follows the tempo.
  phase = 'engine 5';
  {
    const rows: Report[] = [];
    for (const [tempo, delayTime] of [[100, '1/4'], [120, '1/8d'], [150, '1/16t']] as const) {
      configure({ tempo, delayTime, delay: 0.4 });
      await sleep(50);
      const got = inner.rack.stats().delaySeconds as number;
      rows.push({ tempo, delayTime, expectedS: r2(noteSeconds(delayTime, tempo), 4), rackS: got, ok: Math.abs(got - noteSeconds(delayTime, tempo)) < 1e-3 });
    }
    out.delayVsTempo = rows;
    configure({ delay: 0, tempo: 120 });
  }

  // 6. Velocity curves: mouth openness -> dynamics.
  phase = 'engine 6';
  {
    const rows: Report = {};
    for (const curve of VELOCITY_CURVES) {
      configure({ velocityCurve: curve });
      rows[curve] = [0.25, 0.4, 0.55, 0.85].map((m) => r2(inner.mouthDynamics(face(m), 0.15), 3));
    }
    out.velocityCurve = rows;
    configure({ velocityCurve: 'linear' });
  }

  // 7. Attack and release scaling (grand piano): level 60 ms after the onset, time to -40 dB after release.
  phase = 'engine 7';
  {
    configure({ reverb: 0, delay: 0, trigger: 'mouth' });
    await setLead('grand-piano');
    const rows: Report[] = [];
    for (const [attack, release] of [[0, 0.5], [1, 0.5], [0, 0], [0, 1]] as const) {
      configure({ attack, release });
      await drive(() => frame([hand(0, 'right', 0.7, 0.5)], face(0)), 600);
      const t0 = performance.now();
      let early = 0;
      let held = 0;
      await drive(() => {
        const dt = performance.now() - t0;
        const l = engine.level();
        if (dt > 40 && dt < 90) early = Math.max(early, l);
        held = Math.max(held, l);
        return frame([hand(0, 'right', 0.7, 0.5)], face(0.7));
      }, 700);
      const t1 = performance.now();
      let fall = NaN;
      await drive(() => {
        const l = engine.level();
        if (Number.isNaN(fall) && l < held * 0.01) fall = performance.now() - t1;
        return frame([hand(0, 'right', 0.7, 0.5)], face(0));
      }, 2500);
      rows.push({ attack, release, earlyOverPeak: r2(early / Math.max(1e-6, held), 3), msToMinus40dB: Math.round(fall) });
    }
    out.envelope = rows;
    configure({ attack: 0, release: 0.5, trigger: 'always' });
  }

  // 8. Count-in: looper take from silence, with and without the bar of clicks (3/4).
  phase = 'engine 8';
  {
    const rows: Report = {};
    for (const countIn of [true, false]) {
      configure({ countIn, timeSignature: '3/4', tempo: 120, groove: false, mode: 'melody' });
      await drive(() => frame([]), 1000);
      engine.loop({ type: 'reset' });
      engine.loop({ type: 'record', track: 0 });
      await drive(() => frame([]), 120);
      const st: LooperState = engine.looper();
      const phase = st.phase;
      const beats = st.countIn;
      await drive(() => frame([]), 1700);
      rows[countIn ? 'on' : 'off'] = { phaseAt120ms: phase, countInBeats: beats, phaseAt1820ms: engine.looper().phase };
      engine.loop({ type: 'stop' });
      engine.loop({ type: 'reset' });
    }
    const on = rows.on as Report;
    const off = rows.off as Report;
    out.countIn = { ...rows, ok: on.phaseAt120ms === 'count-in' && on.countInBeats === 3 && on.phaseAt1820ms === 'recording' && off.phaseAt120ms === 'recording' };
    configure({ timeSignature: '4/4' });
    await drive(() => frame([]), 1000);
  }

  // 9. Click volume on the metronome beat.
  phase = 'engine 9';
  {
    const rows: Report = {};
    for (const clickVolume of [0, 0.3, 0.6, 1]) {
      configure({ groove: true, beat: 'metronome', clickVolume, reverb: 0 });
      const r = await drive(() => frame([]), 1600);
      rows[String(clickVolume)] = r2(dbfs(r.peak), 1);
    }
    out.clickVolumePeakDb = rows;
    configure({ groove: false, clickVolume: 0.6, beat: 'pop' });
    await drive(() => frame([]), 800);
  }

  // 10. Sweep every studio setting through its range while lead, bass, chords and the beat play.
  phase = 'engine 10';
  {
    await setLead('grand-piano');
    configure({ trigger: 'mouth', leftHand: 'bass', bass: 'electric-bass', groove: true, beat: 'pop', reverb: 0.35 });
    await waitLoaded('electric-bass');
    const SWEEP: [keyof Settings, readonly unknown[]][] = [
      ['tuning', [415, 432, 452, 466, 440]],
      ['transpose', [-12, -5, 7, 12, 0]],
      ['timeSignature', [...TIME_SIGNATURES, '4/4']],
      ['swing', [0.2, 0.4, 0.6, 0]],
      ['countIn', [false, true]],
      ['clickVolume', [0, 1, 0.6]],
      ['velocityCurve', [...VELOCITY_CURVES, 'linear']],
      ['attack', [0.5, 1, 0]],
      ['release', [0, 1, 0.5]],
      ['reverbType', [...REVERB_TYPES, 'hall']],
      ['reverb', [0, 1, 0.35]],
      ['delay', [0.5, 1, 0]],
      ['delayTime', [...NOTE_RATES, '1/8d']],
      ['delayFeedback', [0, 0.9, 0.3]],
      ['chorus', [0.5, 1, 0]],
      ['eqLow', [-12, 12, 0]],
      ['eqMid', [-12, 12, 0]],
      ['eqHigh', [-12, 12, 0]],
      ['compressor', [0, 1, 0.4]],
      ['width', [0, 1, 0.5]],
      ['lowPower', [true, false]],
      ['tempo', [60, 160, 120]],
    ];
    let peak = 0;
    let nonFinite = 0;
    let steps = 0;
    const play = (k: number) => {
      const y = 0.25 + 0.5 * (0.5 + 0.5 * Math.sin(k / 9));
      return frame([hand(1, 'left', 0.25, 0.8 - y / 2), hand(0, 'right', 0.7, y)], face(k % 24 < 18 ? 0.65 : 0.05));
    };
    const runSweep = async () => {
      for (const [key, values] of SWEEP) {
        for (const v of values) {
          configure({ [key]: v } as Partial<Settings>);
          const r = await drive(play, 260);
          peak = Math.max(peak, r.peak);
          nonFinite += r.nonFinite;
          steps++;
        }
      }
    };
    await runSweep();
    // Again in chords mode with a strummed / arpeggiated part.
    configure({ mode: 'chords', chordPlay: 'arp' });
    await runSweep();
    configure({ chordPlay: 'strum' });
    await runSweep();
    out.sweep = { settingChanges: steps, peakDbfs: r2(dbfs(peak), 2), nonFinite, ok: peak < 1 && nonFinite === 0 };
    configure({ mode: 'melody', leftHand: 'off', groove: false, trigger: 'always' });
    await drive(() => frame([]), 600);
  }

  // 11. Low power forces chorus / delay / width off; neutral settings disconnect everything.
  phase = 'engine 11';
  {
    configure({ chorus: 0.6, delay: 0.5, width: 0.9, eqLow: 3, lowPower: true });
    await sleep(400);
    const lp = inner.rack.stats();
    configure({ chorus: 0, delay: 0, width: 0.5, eqLow: 0, lowPower: false, reverb: 0, compressor: 0 });
    await sleep(4500);
    const idle = inner.rack.stats();
    configure({ reverb: DEFAULT_SETTINGS.reverb, compressor: DEFAULT_SETTINGS.compressor });
    out.bypass = {
      lowPower: { chorus: lp.chorus, delay: lp.delay, width: lp.width, eq: lp.eq, ok: !lp.chorus && !lp.width },
      neutral: { ...idle, ok: !idle.eq && !idle.chorus && !idle.delay && !idle.reverb && !idle.compressor && !idle.width },
    };
  }
  out.studioMembers = studioVoice.memberCount;
  return out;
}

async function selfTest(parts: string[] = ['offline', 'realtime', 'engine']): Promise<Report> {
  errors.length = 0;
  const report: Report = {};
  const t0 = performance.now();
  if (parts.includes('offline')) report.offline = await offlineTests();
  if (parts.includes('realtime')) report.realtime = await realtimeTests();
  if (parts.includes('engine')) report.engine = await engineTests();
  report.seconds = Math.round((performance.now() - t0) / 1000);
  report.errors = [...new Set(errors)].slice(0, 20);
  return report;
}

// ---------------------------------------------------------------------------------------------
// Soak
// ---------------------------------------------------------------------------------------------

async function soak(minutes = 5): Promise<Report> {
  errors.length = 0;
  await engine.unlock();
  configure({ ...DEFAULT_SETTINGS, gestures: { ...DEFAULT_SETTINGS.gestures }, trigger: 'mouth', groove: true });
  const tracker = new MockTracker();
  await tracker.init();
  let frames = 0;
  let updateMs = 0;
  let windowMs = 0;
  let windowFrames = 0;
  let worstUpdate = 0;
  let peak = 0;
  let nonFinite = 0;
  tracker.start(document.createElement('video'), (f) => {
    frames++;
    const t = performance.now();
    engine.update(f);
    const d = performance.now() - t;
    updateMs += d;
    windowMs += d;
    windowFrames++;
    worstUpdate = Math.max(worstUpdate, d);
    const p = readPeak();
    peak = Math.max(peak, p.peak);
    nonFinite += p.nonFinite;
  });
  let raf = true;
  const loop = () => {
    engine.level();
    engine.spectrum();
    engine.metrics();
    if (raf) requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  const gc = (window as unknown as { gc?: () => void }).gc;
  const heap = () => {
    gc?.();
    return Math.round(((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 1024);
  };
  const ids = ['grand-piano', 'violin', 'theremin', 'acoustic-guitar', 'warm-pad', 'flute', 'square-lead'];
  const samples: Report[] = [];
  const t0 = performance.now();
  const end = t0 + minutes * 60_000;
  let changes = 0;
  let nextSample = t0 + 15_000;
  samples.push({ t: 0, heapKB: heap(), members: studioVoice.memberCount });
  while (performance.now() < end) {
    await sleep(1500);
    changes++;
    configure({
      tuning: Math.round(rnd(415, 466)),
      transpose: Math.round(rnd(-12, 12)),
      timeSignature: pickOf(TIME_SIGNATURES),
      swing: maybe(0.4, r2(rnd(0, 0.6)), 0),
      clickVolume: r2(rnd(0, 1)),
      velocityCurve: pickOf(VELOCITY_CURVES),
      attack: maybe(0.5, r2(rnd(0, 1)), 0),
      release: r2(rnd(0, 1)),
      reverbType: pickOf(REVERB_TYPES),
      reverb: r2(rnd(0, 1)),
      delay: maybe(0.4, r2(rnd(0, 1)), 0),
      delayTime: pickOf(NOTE_RATES),
      delayFeedback: r2(rnd(0, 0.9)),
      chorus: maybe(0.4, r2(rnd(0, 1)), 0),
      eqLow: maybe(0.4, Math.round(rnd(-12, 12)), 0),
      eqMid: maybe(0.4, Math.round(rnd(-12, 12)), 0),
      eqHigh: maybe(0.4, Math.round(rnd(-12, 12)), 0),
      compressor: r2(rnd(0, 1)),
      width: r2(rnd(0, 1)),
      lowPower: changes % 20 === 19,
      tempo: Math.round(rnd(70, 150)),
      beat: pickOf(['pop', 'lofi', 'rock', 'house', 'metronome'] as const),
      ...(changes % 6 === 0 ? { lead: pickOf(ids), mode: pickOf(['melody', 'chords'] as const), chordPlay: pickOf(['block', 'strum', 'arp'] as const), leftHand: pickOf(['volume', 'bass', 'chords'] as const) } : {}),
    });
    if (performance.now() >= nextSample) {
      nextSample += 15_000;
      samples.push({ t: Math.round((performance.now() - t0) / 1000), heapKB: heap(), members: studioVoice.memberCount, mode: settings.mode, updateMsLast15s: r2(windowMs / Math.max(1, windowFrames), 3), peakDb: r2(dbfs(peak), 2) });
      windowMs = 0;
      windowFrames = 0;
    }
  }
  tracker.dispose();
  raf = false;
  engine.panic();
  await sleep(3000);
  samples.push({ t: minutes * 60, heapKB: heap(), members: studioVoice.memberCount });
  const heaps = samples.map((s) => s.heapKB as number);
  const firstHalf = heaps.slice(1, Math.ceil(heaps.length / 2));
  const secondHalf = heaps.slice(Math.ceil(heaps.length / 2), -1);
  const avg = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  return {
    minutes,
    frames,
    settingChanges: changes,
    updateAvgMs: r2(updateMs / Math.max(1, frames), 3),
    updateWorstMs: r2(worstUpdate, 2),
    peakDbfs: r2(dbfs(peak), 2),
    nonFinite,
    heapFirstHalfAvgKB: Math.round(avg(firstHalf)),
    heapSecondHalfAvgKB: Math.round(avg(secondHalf)),
    samples,
    errors: errors.slice(0, 20),
  };
}

declare global {
  interface Window {
    __studioSelfTest?: (parts?: string[]) => Promise<Report>;
    __studioSoak?: (minutes?: number) => Promise<Report>;
  }
}
window.__studioSelfTest = selfTest;
window.__studioSoak = soak;
const out = document.getElementById('out')!;
document.getElementById('run')!.addEventListener('click', () => {
  out.textContent = 'running…';
  void selfTest().then((r) => (out.textContent = JSON.stringify(r, null, 1)));
});

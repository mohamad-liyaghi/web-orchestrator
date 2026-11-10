/**
 * The music engine: Tone.js audio graph + gesture -> note mapping.
 *
 *   lead/bass voice: player -> filter (brightness) -> vibrato -> gain (expression)
 *     -> instrument bus -> studio rack (EQ, chorus, delay, reverb, compressor, width, limiter)
 *     -> master volume -> destination (+ analyser, + recorder tap)
 *   groove -> the rack's side input (EQ + compressor, under the instruments) + reverb send
 *   looper tracks: own players -> loop bus -> instrument bus (so reverb, master and recorder get them)
 *   MIDI out mirrors the live voices (players' note taps)
 *
 * Tone is imported through deep module paths only: the package index creates an AudioContext
 * at import time, which browsers refuse (and warn about) before a user gesture. The context is
 * created in unlock(), inside the Start tap.
 */
import { Filter, Gain, Vibrato } from 'tone/build/esm/classes.js';
import { Context } from 'tone/build/esm/core/context/Context.js';
import { setContext } from 'tone/build/esm/core/Global.js';
import './toneFixes';
import './automationFix';
import type {
  ActionGesture,
  ChordPlay,
  LoopCommand,
  LooperState,
  MidiStatus,
  FaceState,
  HandState,
  InstrumentLoadState,
  Lane,
  MusicEngine,
  MusicMetrics,
  PlayZone,
  Recording,
  Settings,
  TrackingFrame,
  VoiceId,
  VoiceState,
} from '../types';
import { DEFAULT_SETTINGS, mouthThresholds } from '../settings';
import { ASSETS } from '../config';
import { INSTRUMENTS, instrumentSpec, type InstrumentSpec } from './instruments';
import { SampleLibrary } from './samples';
import { SamplePlayer, SynthPlayer, type NoteTap, type Player, type VoiceLimits } from './players';
import { Looper } from './looper';
import { MidiOut } from './midi';
import { Groove, type GrooveChord } from './groove';
import { ChordPart, STYLE_BY_FINGERS, STYLE_LABEL, chordVoicing, degreeChord, degreeFromFingers, type ChordStyle, type PartClock, type PartContext } from './chords';
import { MelodyPerformer, harmonyNote, resolveTechnique, soundingChord, voiceFor, type Technique } from './technique';
import { MasterRecorder } from './recorder';
import { MobileAudioUnlock } from './unlock';
import { StudioRack } from './studio/rack';
import { MeterClock, swingSteps } from './studio/meter';
import { studioVoice } from './studio/voice';
import {
  SCALES,
  bassNotes,
  chordName,
  detectChord,
  diatonicTriad,
  leadNotes,
  mod12,
  noteName,
  pcName,
  romanForDegree,
  romanNumeral,
  scaleDef,
  usesFlats,
  type Chord,
} from './theory';

const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);
/** One-pole smoothing factor for a time step and time constant (ms). */
const follow = (dtMs: number, tauMs: number): number => 1 - Math.exp(-dtMs / Math.max(1, tauMs));

/** Lane hysteresis in lane heights: the pointer must move this far past a boundary. */
const LANE_HYSTERESIS = 0.2;
const DEBOUNCE_MS = 120;
const VOLUME_HOLD_MS = 2000;
const RECENT_WINDOW_S = 1.5;
const NPM_WINDOW_MS = 10_000;
/** Wrist roll that swaps major/minor (enter / leave), radians (~25 / ~20 degrees). */
const TILT_ON = 0.44;
const TILT_OFF = 0.35;
const COMFORT_VOLUME = 0.75;
const ACTION_GESTURES: ReadonlySet<string> = new Set<ActionGesture>(['fist', 'peace', 'thumbs-up', 'rock']);

/**
 * Tone keeps up to 1000 past automation events per Param (for getValueAtTime). The voice channel's
 * params are re-targeted on every tracking frame and nothing reads that history, so a full one
 * only made each new event more expensive: per-frame update time crept from ~0.2 ms to ~0.9 ms
 * over a few minutes. Keeping a short history holds it flat.
 */
function shortHistory(param: unknown, events = 16): void {
  const timeline = (param as { _events?: { memory?: number } })._events;
  if (timeline && typeof timeline.memory === 'number') timeline.memory = events;
}

/** filter -> vibrato -> gain for one voice. */
class Channel {
  readonly filter = new Filter({ type: 'lowpass', frequency: 12000, rolloff: -12, Q: 0.5 });
  readonly vibrato = new Vibrato({ frequency: 5.4, depth: 0, maxDelay: 0.004 });
  readonly gain = new Gain(0);
  private cutoff = 12000;
  private depth = 0;
  private level = 0;

  constructor(dest: Gain) {
    this.filter.chain(this.vibrato, this.gain, dest);
    for (const p of [this.filter.frequency, this.vibrato.depth, this.gain.gain]) shortHistory(p);
  }

  /** Gain the channel is heading to (the voice's loudness, squared). */
  get out(): number {
    return this.level;
  }

  set(time: number, brightness: number, vibrato: number, level: number): void {
    const cutoff = 260 * Math.pow(2, clamp01(brightness) * 5.9);
    if (Math.abs(cutoff - this.cutoff) / this.cutoff > 0.01) {
      this.cutoff = cutoff;
      this.filter.frequency.setTargetAtTime(cutoff, time, 0.04);
    }
    if (Math.abs(vibrato - this.depth) > 0.004) {
      this.depth = vibrato;
      this.vibrato.depth.setTargetAtTime(vibrato, time, 0.12);
    }
    if (Math.abs(level - this.level) > 0.002 || (level === 0 && this.level !== 0)) {
      this.level = level;
      this.gain.gain.setTargetAtTime(level, time, 0.025);
    }
  }

  dispose(): void {
    this.filter.dispose();
    this.vibrato.dispose();
    this.gain.dispose();
  }
}

/** A value that only changes after it has been stable for DEBOUNCE_MS. */
class Debounced {
  value = 0;
  private candidate = -1;
  private since = 0;

  push(v: number, now: number): number {
    if (v !== this.candidate) {
      this.candidate = v;
      this.since = now;
    } else if (now - this.since >= DEBOUNCE_MS) {
      this.value = v;
    }
    return this.value;
  }

  reset(): number {
    this.value = 0;
    this.candidate = -1;
    return 0;
  }
}

interface Voice {
  id: VoiceId;
  state: VoiceState;
  channel: Channel | null;
  player: Player | null;
  /** Instrument the settings ask for (may still be loading). */
  wanted: string;
  /** Ascending notes of the lanes. */
  notes: number[];
  lanes: Lane[];
  lanesDirty: boolean;
  /** Hysteresis state: lane index under the pointer, -1 when none. */
  lane: number;
  /** Sounding melody note handle and pitch. */
  handle: number;
  midi: number | null;
  /** Force a fresh attack on the next update (instrument changed while playing). */
  retrigger: boolean;
  /** Smoothed dynamics applied to the channel. */
  dyn: number;
  /** Chords (and the chord-mode bass root) played by this voice. */
  part: ChordPart;
  /** Identity of the chord the part plays ('' when none). */
  chordId: string;
  /** Last chord voicing (before any octave shift), kept for voice leading into the next chord. */
  lastVoicing: number[];
  /** Melody line played the instrument's way (slides, legato, pedal, harmony). */
  mel: MelodyPerformer;
  /** Technique cache: valid for this instrument under this settings object. */
  tech: Technique | null;
  techFor: string;
  techSettings: Settings | null;
  /** Context handed to the chord part (reused, no per-frame allocation). */
  partCtx: PartContext;
}

function makeVoiceState(voice: VoiceId, instrument: string): VoiceState {
  return {
    voice,
    handId: null,
    instrument,
    active: false,
    gate: false,
    midi: null,
    note: '',
    laneIndex: -1,
    velocity: 0,
    brightness: 0.8,
    onset: false,
  };
}

class Engine implements MusicEngine {
  readonly instruments = INSTRUMENTS;
  readonly scales = SCALES;

  private settings: Settings = { ...DEFAULT_SETTINGS };
  private applied: Settings | null = null;
  private zone: PlayZone = { y0: 0.1, y1: 0.86 };

  private ctx: Context | null = null;
  private lib: SampleLibrary | null = null;
  private bus: Gain | null = null;
  /** Live voices -> bus (muted for MIDI-only playing). */
  private liveBus: Gain | null = null;
  private liveMuted = false;
  /** Looper players -> bus. */
  private loopBus: Gain | null = null;
  /** Count-in clicks -> speakers (not into the recording). */
  private clickBus: Gain | null = null;
  private looperImpl: Looper | null = null;
  private readonly midi = new MidiOut();
  /** Dynamics target of the current frame (MIDI note-on velocity of sustained instruments). */
  private frameDyn = 0;
  private rack: StudioRack | null = null;
  /** Time signature of the grid (bars counted from a downbeat step). */
  private readonly meterClock = new MeterClock();
  private readonly pos = { bar: 0, beat: 0 };
  /** Bar length (ticks) the looper's loops are made with; 0 before the graph exists. */
  private loopBarTicks = 0;
  private master: Gain | null = null;
  private groove: Groove | null = null;
  private grooveSend: Gain | null = null;
  private analyser: AnalyserNode | null = null;
  private recordTap: MediaStreamAudioDestinationNode | null = null;
  private recorder: MasterRecorder | null = null;
  private readonly mobile = new MobileAudioUnlock();
  private readonly limits: VoiceLimits = { sample: 10, synth: 6 };
  private readonly timers = new Set<number>();
  private clockId: number | null = null;
  private clockStopTimer = 0;
  private disposed = false;

  private readonly lead: Voice;
  private readonly bass: Voice;
  private readonly voiceStates: VoiceState[];
  private readonly loadListeners = new Set<(s: InstrumentLoadState) => void>();
  private readonly loadStates = new Map<string, InstrumentLoadState>();

  // Gesture state
  private mouthGate = false;
  private lastFrameT = 0;
  private lastUpdateAt = 0;
  private handVolume = 1;
  private volumeHandSeenAt = -Infinity;
  private volumeHeld = 1;
  private expression = 0;
  private readonly degree = new Debounced();
  private readonly styleFingers = new Debounced();
  private borrowed = false;
  /** The chord a hand is playing (chords mode / chord role) this frame, for the metrics. */
  private playedChord: Chord | null = null;
  private playedDegree = 0;
  /** Bumped when settings change how chords are voiced (forces a re-voice of a held chord). */
  private techRev = 0;

  // Metrics
  private readonly m: MusicMetrics = {
    keyName: 'C',
    scaleName: '',
    chord: '',
    roman: '',
    degree: 0,
    chordStyle: '',
    borrowed: false,
    diatonic: [],
    degreeHandId: null,
    styleHandId: null,
    activeMidi: [],
    expression: 0,
    handVolume: 1,
    volumeHandId: null,
    levelDb: -Infinity,
    bpm: DEFAULT_SETTINGS.tempo,
    bar: 0,
    beat: 0,
    notesPlayed: 0,
    notesPerMinute: 0,
    sessionMs: 0,
  };
  private unlockedAt = 0;
  private readonly onsetTimes = new Float64Array(512);
  private onsetHead = 0;
  private readonly recentMidi = new Int16Array(48);
  private readonly recentAt = new Float64Array(48);
  private recentHead = 0;
  private readonly pcWeights = new Float32Array(12);
  private readonly detected: Chord = { root: 0, type: diatonicTriad(0, 'major', 0).type };
  private lastChord: Chord | null = null;
  private readonly grooveChord: { root: number; intervals: readonly number[] } = { root: 0, intervals: [0, 4, 7] };

  // Analysis
  private readonly spec = new Float32Array(64);
  private freqData: Float32Array<ArrayBuffer> | null = null;
  private timeData: Float32Array<ArrayBuffer> | null = null;
  private binEdges: Uint16Array | null = null;
  private rms = 0;
  private analysedAt = -1;

  private readonly onGesture = (): void => this.resumeIfNeeded();
  /** The Transport as the chord parts see it. */
  private readonly partClock: PartClock = {
    now: () => this.now(),
    stepAt: (time) => {
      const ctx = this.ctx;
      if (!ctx || this.clockId === null || ctx.transport.state !== 'started') return NaN;
      const t = ctx.transport;
      return t.getTicksAtTime(time) / (t.PPQ / 4);
    },
    locked: () => !!this.groove?.isRunning || !!this.looperImpl?.needsClock,
  };
  private readonly emptyLooper: LooperState = {
    bars: DEFAULT_SETTINGS.loopBars,
    phase: 'idle',
    recordTrack: -1,
    countIn: 0,
    progress: 0,
    takeProgress: 0,
    seconds: 0,
    tracks: [],
    canUndo: false,
    version: 0,
  };

  constructor() {
    this.lead = this.makeVoice('lead', DEFAULT_SETTINGS.lead);
    this.bass = this.makeVoice('bass', DEFAULT_SETTINGS.bass);
    this.voiceStates = [this.lead.state, this.bass.state];
    this.refreshDiatonic(DEFAULT_SETTINGS);
  }

  private makeVoice(id: VoiceId, instrument: string): Voice {
    const holder: { v: Voice | null } = { v: null };
    const v: Voice = {
      id,
      state: makeVoiceState(id, instrument),
      channel: null,
      player: null,
      wanted: instrument,
      notes: [],
      lanes: [],
      lanesDirty: true,
      lane: -1,
      handle: -1,
      midi: null,
      retrigger: false,
      dyn: 0,
      part: new ChordPart(
        () => holder.v?.player ?? null,
        (midi) => this.countOnset(midi),
        this.partClock,
      ),
      chordId: '',
      lastVoicing: [],
      mel: new MelodyPerformer(
        () => holder.v?.player ?? null,
        (midi) => this.countOnset(midi),
      ),
      tech: null,
      techFor: '',
      techSettings: null,
      partCtx: { play: 'block', tech: null as unknown as Technique, settings: DEFAULT_SETTINGS, bass: false, chord: null },
    };
    holder.v = v;
    return v;
  }

  // -------------------------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------------------------

  unlock(): Promise<void> {
    if (this.disposed) return Promise.reject(new Error('music engine disposed'));
    // Everything up to resume() runs synchronously inside the user gesture.
    this.mobile.engage();
    if (!this.ctx) this.buildGraph();
    const raw = this.ctx!.rawContext as unknown as { state: string; resume(): Promise<void> };
    const resumed = raw.state === 'running' ? Promise.resolve() : raw.resume();
    if (!this.unlockedAt) this.unlockedAt = performance.now();
    for (const ev of ['pointerdown', 'touchend', 'keydown'] as const) {
      window.addEventListener(ev, this.onGesture, { capture: true, passive: true });
    }
    document.addEventListener('visibilitychange', this.onGesture);
    return resumed.then(() => {
      if (this.disposed) return;
      this.buildChannels();
      this.apply(this.settings, true);
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.panic();
    this.disposed = true;
    for (const ev of ['pointerdown', 'touchend', 'keydown'] as const) {
      window.removeEventListener(ev, this.onGesture, { capture: true });
    }
    document.removeEventListener('visibilitychange', this.onGesture);
    for (const t of this.timers) window.clearTimeout(t);
    this.timers.clear();
    this.stopClock();
    this.recorder?.dispose();
    this.looperImpl?.dispose();
    this.looperImpl = null;
    this.midi.dispose();
    this.groove?.dispose();
    for (const v of [this.lead, this.bass]) {
      v.part.reset();
      v.player?.dispose();
      v.player = null;
      v.channel?.dispose();
      v.channel = null;
    }
    this.rack?.dispose();
    this.rack = null;
    for (const n of [this.bus, this.liveBus, this.loopBus, this.clickBus, this.master, this.grooveSend]) {
      n?.dispose();
    }
    this.analyser?.disconnect();
    this.recordTap?.disconnect();
    this.lib?.dispose();
    this.mobile.dispose();
    this.loadListeners.clear();
    const ctx = this.ctx;
    this.ctx = null;
    if (ctx) void ctx.close().catch(() => undefined);
  }

  private resumeIfNeeded(): void {
    const ctx = this.ctx;
    if (!ctx || this.disposed || document.hidden) return;
    const raw = ctx.rawContext as unknown as { state: string; resume(): Promise<void> };
    if (raw.state !== 'running' && raw.state !== 'closed') {
      this.mobile.engage();
      raw.resume().catch(() => undefined);
    }
  }

  private buildGraph(): void {
    const ctx = new Context({ latencyHint: 'interactive', lookAhead: 0.02 });
    setContext(ctx);
    this.ctx = ctx;
    this.lib = new SampleLibrary(ctx, ASSETS.samples, 6);

    this.master = new Gain(0).toDestination();
    this.rack = new StudioRack(
      ctx,
      {
        later: (ms, fn) => {
          this.later(ms, () => {
            if (!this.disposed) fn();
          });
        },
        slice: (fn) => {
          this.later(0, () => {
            if (!this.disposed) fn();
          });
        },
      },
      this.settings,
    );
    this.rack.output.connect(this.master.input);
    this.bus = new Gain(0.9);
    this.bus.connect(this.rack.input);
    this.liveBus = new Gain(1).connect(this.bus);
    this.loopBus = new Gain(1).connect(this.bus);
    this.clickBus = new Gain(0).toDestination();
    this.loopBarTicks = (ctx.transport.PPQ / 4) * this.meterClock.meter.steps;

    this.grooveSend = new Gain(0.12);
    this.grooveSend.connect(this.rack.reverbSend);
    this.groove = new Groove(ctx, () => this.currentGrooveChord(), this.rack.sideInput);
    this.groove.output.connect(this.grooveSend);
    this.looperImpl = new Looper({
      ctx,
      output: this.loopBus,
      clickOutput: this.clickBus,
      makePlayer: (id) => this.makeLoopPlayer(id),
      retirePlayer: (p) => {
        p.stopAll(this.now(), 0.08);
        this.later(800, () => p.dispose());
      },
      clockChanged: () => this.syncClock(),
      clockRunning: () => this.clockId !== null,
      grooveRunning: () => !!this.groove?.isRunning,
      gridOffset: (barStep) => this.swingAt(barStep, !!this.groove?.isRunning),
      meter: () => this.meterClock.meter,
      meterOrigin: () => this.meterClock.origin * (ctx.transport.PPQ / 4),
      countIn: () => this.settings.countIn,
    });

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    analyser.smoothingTimeConstant = 0.72;
    this.master.connect(analyser);
    this.analyser = analyser;
    this.freqData = new Float32Array(analyser.frequencyBinCount);
    this.timeData = new Float32Array(analyser.fftSize);
    // 64 log-spaced bands from 40 Hz to 16 kHz.
    const edges = new Uint16Array(65);
    const hz = ctx.sampleRate / analyser.fftSize;
    for (let i = 0; i <= 64; i++) {
      const f = 40 * Math.pow(16000 / 40, i / 64);
      edges[i] = Math.min(analyser.frequencyBinCount - 1, Math.max(1, Math.round(f / hz)));
    }
    this.binEdges = edges;
  }

  /** Voice channels hold a vibrato LFO, which must only start once the context runs. */
  private buildChannels(): void {
    for (const v of [this.lead, this.bass]) v.channel ??= new Channel(this.liveBus!);
  }

  private later(ms: number, fn: () => void): number {
    const t = window.setTimeout(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
    return t;
  }

  private now(): number {
    return this.ctx ? this.ctx.currentTime : 0;
  }

  // -------------------------------------------------------------------------------------------
  // Transport clock (groove, arpeggios, on-the-beat strums)
  // -------------------------------------------------------------------------------------------

  private syncClock(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const s = this.settings;
    const chords = s.mode === 'chords' || s.leftHand === 'chords';
    // Nothing plays in a background tab: the clock (beat, arpeggios, loops) waits for the page.
    const need = !document.hidden && (s.groove || (chords && s.chordPlay === 'arp') || this.techniqueNeedsClock(s) || !!this.looperImpl?.needsClock);
    const t = ctx.transport;
    if (Math.abs(t.bpm.value - s.tempo) > 0.01) t.bpm.setValueAtTime(s.tempo, ctx.currentTime);
    if (need) {
      if (this.clockStopTimer) {
        window.clearTimeout(this.clockStopTimer);
        this.timers.delete(this.clockStopTimer);
        this.clockStopTimer = 0;
      }
      if (this.clockId === null) {
        const at = ctx.currentTime + 0.05;
        this.meterClock.restart();
        this.meterApplied(0);
        t.position = 0;
        this.clockId = t.scheduleRepeat((time) => this.onClock(time), '16n', 0);
        t.start(at);
        this.looperImpl?.onClockStart();
        this.onGrid(0, at); // the Transport callback for step 0 schedules step 1
      }
    } else if (this.clockId !== null && !this.clockStopTimer) {
      // Let the groove fade out before the clock stops.
      this.clockStopTimer = this.later(700, () => {
        this.clockStopTimer = 0;
        this.stopClock();
      });
    }
  }

  /** Strum patterns and moving bass lines play in time even without the beat. */
  private techniqueNeedsClock(s: Settings): boolean {
    const chords = s.mode === 'chords' || s.leftHand === 'chords';
    if (!chords) return false;
    const strum = s.chordPlay === 'strum';
    const bassLine = s.mode === 'chords' && (s.bassPattern === 'root-fifth' || s.bassPattern === 'octave' || s.bassPattern === 'walking');
    return strum || bassLine;
  }

  /** The technique a voice plays with (cached per instrument and settings object). */
  private techFor(v: Voice): Technique {
    const spec = this.specFor(v);
    if (!v.tech || v.techFor !== spec.id || v.techSettings !== this.settings) {
      v.tech = resolveTechnique(spec, this.settings);
      v.techFor = spec.id;
      v.techSettings = this.settings;
    }
    return v.tech;
  }

  /** Context for a voice's chord part this frame. */
  private partContext(v: Voice, play: ChordPlay, bass: boolean, chord: Chord | null): PartContext {
    const c = v.partCtx;
    c.play = play;
    c.tech = this.techFor(v);
    c.settings = this.settings;
    c.bass = bass;
    c.chord = chord;
    return c;
  }

  private stopClock(): void {
    const ctx = this.ctx;
    if (!ctx) return;
    if (this.clockStopTimer) {
      window.clearTimeout(this.clockStopTimer);
      this.timers.delete(this.clockStopTimer);
      this.clockStopTimer = 0;
    }
    const t = ctx.transport;
    if (this.clockId !== null) t.clear(this.clockId);
    this.clockId = null;
    if (t.state !== 'stopped') t.stop();
  }

  private sixteenth(): number {
    return 15 / Math.max(1, this.ctx!.transport.bpm.value);
  }

  /** The Transport's time signature follows the grid's meter (for anything reading Tone bars). */
  private syncTimeSignature(): void {
    const t = this.ctx?.transport;
    if (!t) return;
    const [n, d] = this.meterClock.meter.signature;
    t.timeSignature = [n, d];
  }

  /**
   * Swing of bar sixteenth `barStep`, in sixteenths: the user's swing (eighths; sixteenths for
   * house and eighth-based meters), else the beat's own feel while it plays.
   */
  private swingAt(barStep: number, grooveRunning: boolean): number {
    const g = this.groove;
    if (grooveRunning && g) return g.offset(barStep, this.settings.swing);
    const sw = this.settings.swing;
    return sw > 0 ? swingSteps(barStep, sw, this.meterClock.meter.eighths) : 0;
  }

  /** Transport callback for a sixteenth: schedule the NEXT one, ahead of time. */
  private onClock(time: number): void {
    if (this.disposed || !this.ctx) return;
    const t = this.ctx.transport;
    const step = Math.round(t.getTicksAtTime(time) / (t.PPQ / 4));
    this.onGrid(step + 1, time + this.sixteenth());
  }

  private onGrid(step: number, time: number): void {
    const sixteenth = this.sixteenth();
    const mc = this.meterClock;
    if (mc.advance(step)) this.meterApplied(step);
    const barStep = mc.barStep(step);
    const groove = this.groove!;
    groove.schedule(barStep, time, sixteenth, groove.offset(barStep, this.settings.swing));
    const s = this.settings;
    // Technique parts get the straight grid and apply the swing setting themselves.
    if (s.mode === 'chords') {
      this.lead.part.onGrid(step, time, sixteenth);
      this.bass.part.onGrid(step, time, sixteenth);
    } else if (s.leftHand === 'chords') {
      this.bass.part.onGrid(step, time, sixteenth);
    }
    this.looperImpl?.onGrid(step, time, sixteenth);
  }

  /** The grid's time signature is now in force from grid step `originStep` (a bar line). */
  private meterApplied(originStep: number): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const meter = this.meterClock.meter;
    const six = ctx.transport.PPQ / 4;
    this.groove?.setMeter(meter);
    this.syncTimeSignature();
    const barTicks = six * meter.steps;
    if (barTicks !== this.loopBarTicks) {
      const old = this.loopBarTicks;
      this.loopBarTicks = barTicks;
      if (old > 0) this.looperImpl?.meterChanged(old, originStep * six);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Settings
  // -------------------------------------------------------------------------------------------

  configure(settings: Settings): void {
    this.settings = settings;
    if (!this.ctx || this.disposed) {
      // Before unlock: only the lane layout and labels can change.
      this.lead.wanted = settings.lead;
      this.bass.wanted = settings.bass;
      this.lead.lanesDirty = this.bass.lanesDirty = true;
      this.refreshDiatonic(settings);
      return;
    }
    this.apply(settings, false);
  }

  private needBass(s: Settings): boolean {
    return s.mode === 'chords' || s.leftHand === 'bass' || s.leftHand === 'chords';
  }

  private apply(s: Settings, force: boolean): void {
    const a = force ? null : this.applied;
    const changed = <K extends keyof Settings>(k: K): boolean => !a || a[k] !== s[k];
    const t = this.now();
    this.settings = s;

    if (changed('lowPower')) {
      this.limits.sample = s.lowPower ? 6 : 10;
      this.limits.synth = s.lowPower ? 4 : 6;
      this.groove!.setLowPower(s.lowPower);
    }
    this.applyStudio(s, a, t);
    if (changed('mode') || changed('leftHand') || changed('chordPlay')) {
      for (const v of [this.lead, this.bass]) this.silenceVoice(v, t, 0.15);
      this.degree.reset();
      this.styleFingers.reset();
      this.borrowed = false;
      this.lead.lanesDirty = this.bass.lanesDirty = true;
    }
    if (changed('key') || changed('scale') || changed('octave') || changed('span')) {
      this.lead.lanesDirty = this.bass.lanesDirty = true;
      this.refreshDiatonic(s);
    }
    if (changed('trigger')) this.mouthGate = false;
    if (changed('playStyle') || changed('voicing')) this.techRev++;
    if (changed('lead')) this.setInstrument(this.lead, s.lead);
    if (changed('bass') || changed('leftHand') || changed('mode')) {
      this.bass.wanted = s.bass;
      if (this.needBass(s)) this.setInstrument(this.bass, s.bass);
      else this.bass.state.instrument = s.bass;
    }
    if (changed('volume') || changed('clickVolume')) {
      this.master!.gain.setTargetAtTime(s.volume * s.volume, t, 0.03);
      this.clickBus!.gain.setTargetAtTime(Math.max(0.15, s.volume * s.volume) * this.clickLevel(s), t, 0.03);
      this.groove!.setClickLevel(this.clickLevel(s));
    }
    if (changed('loopBars')) this.looperImpl!.setBars(s.loopBars);
    if (changed('midiOut') || changed('midiChannel')) this.midi.configure(s.midiOut, s.midiChannel);
    this.syncLiveMute();
    this.groove!.setStyle(s.beat);
    this.groove!.setHarmony(s.mode !== 'chords');
    if (s.groove) this.groove!.start();
    else this.groove!.stop();
    this.syncClock();
    this.m.keyName = pcName(s.key, usesFlats(s.key, s.scale));
    this.m.scaleName = scaleDef(s.scale).name;
    this.m.bpm = s.tempo;
    this.applied = { ...s, gestures: { ...s.gestures } };
  }

  /** Click level relative to the default click volume (0.6). */
  private clickLevel(s: Settings): number {
    return s.clickVolume / 0.6;
  }

  /** Studio settings: FX rack, concert pitch / transpose / envelopes, time signature. */
  private applyStudio(s: Settings, a: Settings | null, t: number): void {
    this.rack!.configure(s, t);
    studioVoice.set(s.tuning, s.transpose, s.attack, s.release, s.velocityCurve, t);
    // A running clock switches on its next bar line (onGrid); an idle one at once.
    if ((!a || a.timeSignature !== s.timeSignature) && this.meterClock.request(s.timeSignature, this.clockId !== null)) this.meterApplied(0);
  }

  private refreshDiatonic(s: Settings): void {
    const flats = usesFlats(s.key, s.scale);
    const d = this.m.diatonic;
    d.length = 0;
    for (let i = 0; i < 7; i++) d.push(chordName(diatonicTriad(s.key, s.scale, i), flats));
    this.m.keyName = pcName(s.key, flats);
    this.m.scaleName = scaleDef(s.scale).name;
  }

  setPlayZone(zone: PlayZone): void {
    if (zone.y1 - zone.y0 < 0.05) return;
    if (zone.y0 === this.zone.y0 && zone.y1 === this.zone.y1) return;
    this.zone = { y0: zone.y0, y1: zone.y1 };
    this.lead.lanesDirty = this.bass.lanesDirty = true;
  }

  onLoadState(cb: (s: InstrumentLoadState) => void): () => void {
    this.loadListeners.add(cb);
    for (const s of this.loadStates.values()) cb({ ...s });
    return () => this.loadListeners.delete(cb);
  }

  private emitLoad(id: string, loading: boolean, progress: number, error?: string): void {
    const s: InstrumentLoadState = error ? { id, loading, progress, error } : { id, loading, progress };
    this.loadStates.delete(id);
    this.loadStates.set(id, s);
    if (this.loadStates.size > 12) {
      const first = this.loadStates.keys().next().value;
      if (first !== undefined) this.loadStates.delete(first);
    }
    for (const cb of this.loadListeners) cb({ ...s });
  }

  private wantedIds(): Set<string> {
    const ids = new Set([this.lead.wanted]);
    if (this.needBass(this.settings)) ids.add(this.bass.wanted);
    return ids;
  }

  private setInstrument(v: Voice, id: string): void {
    v.wanted = id;
    v.lanesDirty = true;
    const spec = instrumentSpec(id);
    const lib = this.lib!;
    lib.cancelExcept(this.wantedIds());
    if (v.player?.spec.id === id) {
      this.emitLoad(id, false, 1);
      return;
    }
    if (spec.kind === 'synth') {
      this.swapPlayer(v, new SynthPlayer(spec, this.limits));
      this.emitLoad(id, false, 1);
      return;
    }
    const cached = lib.get(id);
    if (cached) {
      this.swapPlayer(v, new SamplePlayer(spec, cached, this.ctx!, this.limits));
      this.emitLoad(id, false, 1);
      return;
    }
    // Keep playing the previous instrument while this one loads.
    this.emitLoad(id, true, 0);
    lib
      .load(id, (p) => this.emitLoad(id, true, p))
      .then((set) => {
        if (this.disposed) return;
        this.emitLoad(id, false, 1);
        for (const voice of [this.lead, this.bass]) {
          if (voice.wanted === id && voice.player?.spec.id !== id && this.wantedIds().has(id)) {
            this.swapPlayer(voice, new SamplePlayer(spec, set, this.ctx!, this.limits));
          }
        }
      })
      .catch((e: unknown) => {
        if (this.disposed) return;
        const aborted = e instanceof DOMException && e.name === 'AbortError';
        if (aborted) {
          this.emitLoad(id, false, 0);
          return;
        }
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[music] could not load ${id}: ${msg}`);
        this.emitLoad(id, false, 0, `Could not load ${spec.name}. Check your connection and try again.`);
        // Stay on the instrument that is still playing.
        for (const voice of [this.lead, this.bass]) {
          if (voice.wanted === id) voice.wanted = voice.player?.spec.id ?? id;
        }
      });
  }

  private swapPlayer(v: Voice, next: Player): void {
    const t = this.now();
    const old = v.player;
    const wasSounding = v.handle >= 0 || v.part.active;
    if (old) {
      old.stopAll(t, 0.08);
      old.tap = null;
      this.later(600, () => old.dispose());
      this.midi.allNotesOff(v.id === 'lead' ? 0 : 1);
    }
    next.tap = this.tapFor(v);
    next.output.connect(v.channel!.filter);
    v.player = next;
    v.handle = -1;
    v.midi = null;
    v.mel.reset();
    v.part.reset();
    v.chordId = '';
    v.retrigger = wasSounding;
    v.lanesDirty = true;
    v.state.instrument = next.spec.id;
    const inUse = new Set<string>();
    for (const voice of [this.lead, this.bass]) if (voice.player) inUse.add(voice.player.spec.id);
    for (const id of this.wantedIds()) inUse.add(id);
    this.looperImpl?.instrumentsInUse(inUse);
    this.lib!.trim(inUse);
  }

  /** A player for a looper track: same instrument, its own voices, no tap. */
  private makeLoopPlayer(id: string): Player | null {
    const spec = instrumentSpec(id);
    if (spec.kind === 'synth') return new SynthPlayer(spec, this.limits);
    const set = this.lib?.get(id);
    return set ? new SamplePlayer(spec, set, this.ctx!, this.limits) : null;
  }

  /** Note observer of a live voice's player: feeds the looper and MIDI out. */
  private tapFor(v: Voice): NoteTap {
    const ch: 0 | 1 = v.id === 'lead' ? 0 : 1;
    return {
      on: (player, handle, midi, velocity, time) => {
        const gain = v.channel ? v.channel.out : 1;
        this.looperImpl?.noteOn(v.id, player.spec.id, handle, midi, velocity, gain, time);
        if (this.midi.active) {
          const expr = player.spec.sustained ? this.frameDyn * this.handVolume : velocity * this.handVolume;
          // MIDI out sends what sounds: the transposed note.
          this.midi.noteOn(handle, ch, midi + studioVoice.transpose, clamp01(Math.max(0.08, expr)), this.perfAt(time));
        }
      },
      glide: (_player, handle, midi, time) => {
        this.looperImpl?.noteGlide(handle, midi, time);
        if (this.midi.active) this.midi.glide(handle, midi + studioVoice.transpose, this.perfAt(time));
      },
      off: (_player, handle, time) => {
        this.looperImpl?.noteOff(handle, time);
        this.midi.noteOff(handle, this.perfAt(time));
      },
      cancel: (_player, handle, time) => {
        this.looperImpl?.noteCancel(handle);
        // The note-on already went out time-stamped: its note-off must not arrive first.
        this.midi.noteOff(handle, this.perfAt(time + 0.001));
      },
    };
  }

  /** performance.now() timestamp of an audio-context time (for MIDI message timestamps). */
  private perfAt(time: number): number {
    return performance.now() + Math.max(0, time - this.now()) * 1000;
  }

  /** Internal sound of the live voices is off while MIDI-only playing reaches a device. */
  private syncLiveMute(): void {
    const mute = this.settings.midiOnly && this.midi.active;
    if (mute === this.liveMuted || !this.liveBus) return;
    this.liveMuted = mute;
    this.liveBus.gain.setTargetAtTime(mute ? 0 : 1, this.now(), 0.02);
  }

  // -------------------------------------------------------------------------------------------
  // Lanes
  // -------------------------------------------------------------------------------------------

  private specFor(v: Voice): InstrumentSpec {
    return instrumentSpec(v.player?.spec.id ?? v.wanted);
  }

  private refreshLanes(v: Voice): void {
    if (!v.lanesDirty) return;
    v.lanesDirty = false;
    const s = this.settings;
    const spec = this.specFor(v);
    if (s.mode === 'chords' || (v.id === 'bass' && s.leftHand !== 'bass')) {
      v.notes = [];
      v.lanes = [];
      v.lane = -1;
      return;
    }
    v.notes = v.id === 'lead' ? leadNotes(s.key, s.scale, s.octave, s.span, spec.range) : bassNotes(s.key, s.scale, spec.range);
    const flats = usesFlats(s.key, s.scale);
    const n = v.notes.length;
    const h = (this.zone.y1 - this.zone.y0) / Math.max(1, n);
    const lanes: Lane[] = [];
    for (let i = 0; i < n; i++) {
      const midi = v.notes[n - 1 - i]!;
      lanes.push({ midi, note: noteName(midi, flats), y: this.zone.y0 + (i + 0.5) * h, h, isRoot: mod12(midi - s.key) === 0 });
    }
    v.lanes = lanes;
    if (v.lane >= n) v.lane = -1;
  }

  lanes(voice: VoiceId): Lane[] {
    const v = voice === 'lead' ? this.lead : this.bass;
    this.refreshLanes(v);
    return v.lanes;
  }

  private laneWithHysteresis(v: Voice, pos: number): number {
    const n = v.notes.length;
    if (!n) return -1;
    const cur = v.lane;
    if (cur >= 0 && cur < n && pos >= cur - LANE_HYSTERESIS && pos < cur + 1 + LANE_HYSTERESIS) return cur;
    return Math.max(0, Math.min(n - 1, Math.floor(pos)));
  }

  /** 0..1 height inside the play zone (1 = top), with a small dead zone at both ends. */
  private height(hand: HandState): number {
    const u = (this.zone.y1 - hand.indexTip.y) / (this.zone.y1 - this.zone.y0);
    return clamp01((u - 0.1) / 0.8);
  }

  // -------------------------------------------------------------------------------------------
  // Per frame
  // -------------------------------------------------------------------------------------------

  update(frame: TrackingFrame): VoiceState[] {
    const s = this.settings;
    const now = frame.t;
    const dt = this.lastFrameT ? Math.min(200, Math.max(1, now - this.lastFrameT)) : 33;
    this.lastFrameT = now;
    this.lastUpdateAt = performance.now();
    this.lead.state.onset = false;
    this.bass.state.onset = false;
    this.refreshLanes(this.lead);
    this.refreshLanes(this.bass);
    if (!this.ctx || this.disposed || !this.lead.channel) return this.voiceStates;
    const t = this.now();

    const hands = frame.hands;
    const face = frame.face;
    // Mouth gate with the user's sensitivity (our own hysteresis, not face.mouthIsOpen).
    const [openTh, closeTh] = mouthThresholds(s.sensitivity);
    if (s.trigger === 'mouth') {
      const mo = face ? face.mouthOpen : 0;
      this.mouthGate = face ? (this.mouthGate ? mo > closeTh : mo > openTh) : false;
    }
    const dynTarget = s.trigger === 'mouth' ? this.mouthDynamics(face, closeTh) : 0.8;
    this.frameDyn = dynTarget;
    this.playedChord = null;
    this.playedDegree = 0;

    if (s.mode === 'chords') {
      this.driveChordMode(hands, face, dynTarget, dt, now, t);
    } else {
      // Hands arrive sorted left -> right. The rightmost leads; a second hand takes the left role.
      const leadHand = hands.length ? hands[hands.length - 1]! : null;
      const leftHand = hands.length >= 2 ? hands[0]! : null;
      this.updateHandVolume(s.leftHand === 'volume' ? leftHand : null, dt, now);
      this.driveMelodic(this.lead, leadHand, this.gateFor(leadHand), dynTarget, face, dt, t);
      if (s.leftHand === 'bass') {
        this.driveMelodic(this.bass, leftHand, this.gateFor(leftHand), dynTarget, face, dt, t);
      } else if (s.leftHand === 'chords') {
        this.driveChordRole(this.bass, leftHand, leadHand, dynTarget, dt, now, t);
      } else {
        this.silenceVoice(this.bass, t, this.specFor(this.bass).release);
        const st = this.bass.state;
        st.handId = null;
        st.active = false;
        st.laneIndex = -1;
      }
    }

    this.feedTaps();
    this.updateMetrics(t);
    return this.voiceStates;
  }

  /** Per frame: the loudness of each live voice for notes being recorded and for MIDI CC 11. */
  private feedTaps(): void {
    const looper = this.looperImpl;
    const midi = this.midi.active;
    if (midi) this.syncLiveMute();
    if (!midi && !looper?.capturing) return;
    for (const v of [this.lead, this.bass]) {
      const out = v.channel ? v.channel.out : 0;
      looper?.voiceLevel(v.id, out);
      if (midi && (v.handle >= 0 || v.part.active)) this.midi.expression(v.id === 'lead' ? 0 : 1, Math.sqrt(out));
    }
  }

  private isMuted(hand: HandState | null): boolean {
    const s = this.settings;
    if (!hand || !s.gesturesEnabled || !ACTION_GESTURES.has(hand.gesture)) return false;
    return s.gestures[hand.gesture as ActionGesture] === 'mute';
  }

  private gateFor(hand: HandState | null): boolean {
    if (!hand || this.isMuted(hand)) return false;
    switch (this.settings.trigger) {
      case 'mouth':
        return this.mouthGate;
      case 'pinch':
        return hand.pinching;
      default:
        return true;
    }
  }

  /** Mouth openness -> 0..1 dynamics, like a breath controller (through the velocity curve). */
  private mouthDynamics(face: FaceState | null, closeTh: number): number {
    if (!face) return 0;
    const x = clamp01((face.mouthOpen - closeTh) / Math.max(0.1, 0.85 - closeTh));
    return studioVoice.velocity(x);
  }

  private updateHandVolume(hand: HandState | null, dt: number, now: number): void {
    const m = this.m;
    if (this.settings.leftHand !== 'volume') {
      this.handVolume = 1;
      this.volumeHandSeenAt = -Infinity;
      m.volumeHandId = null;
      return;
    }
    let target: number;
    let tau: number;
    if (hand) {
      // Top of the play zone = loud, bottom = silent. A held 'mute' gesture silences.
      target = this.isMuted(hand) ? 0 : this.height(hand);
      tau = 45;
      this.volumeHandSeenAt = now;
      m.volumeHandId = hand.id;
    } else if (now - this.volumeHandSeenAt < VOLUME_HOLD_MS) {
      target = this.volumeHeld; // hold the last value for a moment (hand briefly lost)
      tau = 45;
      m.volumeHandId = null;
    } else {
      target = 1; // then ease back to full so one-handed play works
      tau = 330;
      m.volumeHandId = null;
    }
    this.handVolume += (target - this.handVolume) * follow(dt, tau);
    if (Math.abs(this.handVolume - target) < 1e-3) this.handVolume = target;
    if (hand) this.volumeHeld = this.handVolume;
  }

  private driveMelodic(v: Voice, hand: HandState | null, gateIn: boolean, dynTarget: number, face: FaceState | null, dt: number, t: number): void {
    const s = this.settings;
    const st = v.state;
    const player = v.player;
    const spec = this.specFor(v);
    st.handId = hand ? hand.id : null;
    st.active = !!hand;
    st.instrument = player ? player.spec.id : v.wanted;

    // Pointer: the index fingertip, or the thumb-index midpoint in pinch mode.
    let pos = -1;
    const n = v.notes.length;
    if (hand && n) {
      const y = s.trigger === 'pinch' ? (hand.indexTip.y + hand.thumbTip.y) / 2 : hand.indexTip.y;
      pos = ((y - this.zone.y0) / (this.zone.y1 - this.zone.y0)) * n;
      v.lane = this.laneWithHysteresis(v, pos);
    } else {
      v.lane = -1;
    }
    st.laneIndex = v.lane;

    const gate = gateIn && !!player && v.lane >= 0;
    v.dyn += ((gate ? dynTarget : 0) - v.dyn) * follow(dt, 40);
    const pucker = s.trigger === 'mouth' && face ? face.pucker : 0;
    const vibrato = spec.sustained ? Math.min(0.4, (spec.vibrato ?? 0) + (face ? face.browUp * 0.22 : 0)) : 0;
    const bright = s.trigger === 'mouth' ? 1 - 0.7 * pucker : 0.85;
    const hv = this.handVolume;

    if (!gate) {
      if (v.handle >= 0 || v.mel.extraCount) this.releaseNote(v, t, spec.release);
      st.gate = false;
      st.midi = null;
      st.note = '';
      st.velocity = 0;
      st.brightness = bright;
      v.channel?.set(t, bright, vibrato, spec.sustained ? 0 : hv * hv);
      if (v === this.lead) this.expression = 0;
      return;
    }

    // Target pitch: lane note, or a smooth glide between lanes in the continuous scale (synths).
    let target = v.notes[n - 1 - v.lane]!;
    const glideScale = s.scale === 'continuous' && spec.kind === 'synth';
    if (glideScale) {
      const f = Math.max(0, Math.min(n - 1, pos - 0.5));
      const i0 = Math.floor(f);
      const a = v.notes[n - 1 - i0]!;
      const b = v.notes[Math.max(0, n - 2 - i0)]!;
      target = a + (b - a) * (f - i0);
    }

    const velocity = spec.sustained ? 1 : clamp01(dynTarget);
    if (v.handle < 0 || v.retrigger) {
      v.retrigger = false;
      if (v.handle >= 0) this.releaseNote(v, t, 0.06);
      this.startNote(v, target, velocity, t);
    } else if (glideScale) {
      if (v.midi === null || Math.abs(target - v.midi) > 0.005) {
        v.mel.glide(target, t, this.harmonyFor(v));
        if (v.midi !== null && Math.round(target) !== Math.round(v.midi)) this.countOnset(target, st);
        v.midi = target;
      }
    } else if (target !== v.midi) {
      // The instrument's way from note to note: synth glide, slide / hammer-on, legato bend, or a
      // fresh attack (the pedal may keep the old note ringing).
      if (v.mel.change(target, velocity, t, this.techFor(v), this.harmonyFor(v))) this.countOnset(target, st);
      v.handle = v.mel.handle;
      v.midi = v.mel.midi;
    }

    const level = spec.sustained ? v.dyn * hv : hv;
    st.brightness = spec.sustained ? bright : bright * (0.6 + 0.4 * velocity);
    v.channel!.set(t, st.brightness, vibrato, level * level);
    st.gate = v.handle >= 0;
    st.midi = v.midi;
    st.note = v.midi === null ? '' : noteName(v.midi, usesFlats(s.key, s.scale));
    st.velocity = spec.sustained ? v.dyn : velocity;
    if (v === this.lead) this.expression = clamp01((spec.sustained ? v.dyn : dynTarget) * hv);
  }

  private startNote(v: Voice, midi: number, velocity: number, t: number): void {
    const started = v.mel.start(midi, velocity, t, this.techFor(v), this.harmonyFor(v));
    v.handle = v.mel.handle;
    v.midi = v.mel.midi;
    if (started) this.countOnset(midi, v.state);
  }

  private releaseNote(v: Voice, t: number, release: number): void {
    v.mel.release(t, release);
    v.handle = -1;
    v.midi = null;
  }

  /** Harmony notes for the lead's melody (diatonic, in the key), none for the bass voice. */
  private harmonyFor(v: Voice): (midi: number) => number | null {
    return v === this.lead && this.settings.harmony !== 'off' ? this.harmonyNote : this.noHarmony;
  }
  private readonly harmonyNote = (midi: number): number | null => harmonyNote(midi, this.settings.harmony, this.settings.key, this.settings.scale);
  private readonly noHarmony = (): null => null;

  private countOnset(midi: number, state?: VoiceState): void {
    if (state) state.onset = true;
    this.m.notesPlayed++;
    this.onsetTimes[this.onsetHead] = performance.now();
    this.onsetHead = (this.onsetHead + 1) % this.onsetTimes.length;
    this.recentMidi[this.recentHead] = Math.round(midi);
    this.recentAt[this.recentHead] = this.now();
    this.recentHead = (this.recentHead + 1) % this.recentMidi.length;
  }

  /** Releases whatever a voice is playing (melody note and chord). */
  private silenceVoice(v: Voice, t: number, release: number): void {
    if (v.handle >= 0 || v.mel.extraCount) this.releaseNote(v, t, release);
    if (v.part.active) v.part.stop(t, release);
    v.chordId = '';
    const st = v.state;
    st.gate = false;
    st.midi = null;
    st.note = '';
    st.velocity = 0;
  }

  /** Plays a chord (id + voicing) on a voice, or stops it (id = ''). `bass`: a bass line on the
   *  chord root (notes = [root]) following the bass pattern. */
  private playChord(v: Voice, id: string, notes: readonly number[], velocity: number, t: number, play: ChordPlay, bass = false, chord: Chord | null = null): void {
    const force = v.retrigger;
    v.retrigger = false;
    v.chordId = id;
    if (v.part.update(id || null, notes, velocity, t, force, this.partContext(v, play, bass, chord))) v.state.onset = true;
    if (!v.part.active) v.chordId = '';
  }

  /** Chord notes for a voice, played the instrument's way (guitar shapes, open strings...). */
  private voiceChordFor(v: Voice, chord: Chord, style: ChordStyle, center: number, lo: number, hi: number): number[] {
    const tech = this.techFor(v);
    // The 'open' chord style (five fingers) keeps its own wide shape, except on a guitar.
    if (style === 'open' && tech.voicing !== 'guitar' && tech.voicing !== 'power') return chordVoicing(chord, style, v.lastVoicing, center, lo, hi);
    if (tech.voicing === 'close' && style !== 'open') return chordVoicing(chord, style, v.lastVoicing, center, lo, hi);
    return voiceFor({ chord, kind: tech.voicing, prev: v.lastVoicing, center, lo, hi, preferOpen: tech.openShapes });
  }

  private rootIn(notes: readonly number[], root: number): number {
    for (const m of notes) if (mod12(m) === root) return m;
    return 48 + root;
  }

  /** Melody mode, left hand = 'chords': finger pattern picks the degree, triads on the bass instrument. */
  private driveChordRole(v: Voice, hand: HandState | null, leadHand: HandState | null, dynTarget: number, dt: number, now: number, t: number): void {
    const s = this.settings;
    const st = v.state;
    const player = v.player;
    const spec = this.specFor(v);
    st.handId = hand ? hand.id : null;
    st.active = !!hand;
    st.instrument = player ? player.spec.id : v.wanted;
    st.laneIndex = -1;

    const degree = hand ? this.degree.push(degreeFromFingers(hand), now) : this.degree.reset();
    this.m.degreeHandId = hand ? hand.id : null;
    // Same trigger as the lead: mouth, the lead hand's pinch (the chord hand is busy), or always.
    const trig = s.trigger === 'mouth' ? this.mouthGate : s.trigger === 'pinch' ? !!leadHand?.pinching && leadHand !== hand : true;
    const gate = !!hand && !!player && trig && degree >= 1;
    v.dyn += ((gate ? dynTarget : 0) - v.dyn) * follow(dt, 40);
    if (!gate) {
      this.playChord(v, '', [], 0, t, s.chordPlay);
      st.gate = false;
      st.midi = null;
      st.note = '';
      st.velocity = 0;
      v.channel?.set(t, 0.8, 0, spec.sustained ? 0 : 1);
      return;
    }
    const picked = degreeChord(s.key, s.scale, degree - 1, 'triad', false);
    const id = `${picked.root}${picked.type.suffix}:${this.techRev}`;
    let notes: readonly number[] = v.part.voicing;
    if (id !== v.chordId || !notes.length) {
      const lo = Math.max(spec.range[0], 40);
      const hi = Math.max(lo + 12, Math.min(spec.range[1], 69));
      // Guitar shapes and wide voicings need the instrument's real register.
      const wide = this.techFor(v).voicing !== 'close';
      notes = this.voiceChordFor(v, picked, 'triad', 52, wide ? spec.range[0] : lo, wide ? Math.min(spec.range[1], 84) : hi);
      v.lastVoicing = notes.slice();
    }
    const chord = soundingChord(picked, notes);
    const velocity = spec.sustained ? 1 : clamp01(dynTarget) * 0.85;
    this.playChord(v, id, notes, velocity, t, s.chordPlay, false, chord);
    this.playedChord = chord;
    this.playedDegree = degree;

    st.gate = true;
    st.midi = this.rootIn(notes, chord.root);
    st.note = chordName(chord, usesFlats(s.key, s.scale));
    st.velocity = spec.sustained ? v.dyn : velocity;
    st.brightness = 0.75;
    const level = spec.sustained ? v.dyn : 1;
    v.channel!.set(t, 0.75, 0, level * level);
  }

  /**
   * Chords mode. Left hand (or the only hand): finger pattern = degree, wrist tilt = major/minor
   * swap. Right hand: height = volume, finger count = chord style, tilt = filter, thumb out =
   * octave down, fist = mute. Chords on the lead instrument, root on the bass instrument.
   */
  private driveChordMode(hands: readonly HandState[], face: FaceState | null, dynTarget: number, dt: number, now: number, t: number): void {
    const s = this.settings;
    const lead = this.lead;
    const bass = this.bass;
    const left = hands.length ? hands[0]! : null;
    const right = hands.length >= 2 ? hands[hands.length - 1]! : null;
    const leadSpec = this.specFor(lead);
    const bassSpec = this.specFor(bass);

    const degree = left ? this.degree.push(degreeFromFingers(left), now) : this.degree.reset();
    this.m.degreeHandId = left ? left.id : null;
    this.m.styleHandId = right ? right.id : null;
    if (s.tiltControls && left) {
      const r = Math.abs(left.roll);
      this.borrowed = this.borrowed ? r > TILT_OFF : r > TILT_ON;
    } else {
      this.borrowed = false;
    }

    // Right hand: style from the finger count (a thumb stretched out means "octave down", so it
    // does not count), volume from height, filter from tilt, fist = mute.
    let mute = false;
    let octaveDown = false;
    let bright = 0.85;
    let volTarget = COMFORT_VOLUME;
    let volTau = 250;
    let styleCount = 1;
    if (right) {
      const f = right.fingers;
      const count = (f[1] ? 1 : 0) + (f[2] ? 1 : 0) + (f[3] ? 1 : 0) + (f[4] ? 1 : 0) + (f[0] && !right.thumbOut ? 1 : 0);
      mute = right.fingersUp === 0 && !f[0] && count === 0;
      styleCount = this.styleFingers.push(Math.max(1, count), now) || 1;
      octaveDown = right.thumbOut;
      if (s.tiltControls) bright = clamp01(0.8 + right.roll * 0.75);
      volTarget = mute ? 0 : this.height(right);
      volTau = 45;
      this.m.volumeHandId = right.id;
    } else {
      this.styleFingers.reset();
      this.m.volumeHandId = null;
    }
    this.handVolume += (volTarget - this.handVolume) * follow(dt, volTau);
    if (s.trigger === 'mouth' && face) bright *= 1 - 0.6 * face.pucker;
    const style: ChordStyle = STYLE_BY_FINGERS[styleCount] ?? 'triad';
    this.m.chordStyle = STYLE_LABEL[style];

    const trig = s.trigger === 'mouth' ? this.mouthGate : s.trigger === 'pinch' ? !!right?.pinching : true;
    const gate = !!left && !!lead.player && trig && degree >= 1 && !mute;
    lead.dyn += ((gate ? dynTarget : 0) - lead.dyn) * follow(dt, 40);
    bass.dyn = lead.dyn;

    lead.state.handId = right ? right.id : left ? left.id : null;
    bass.state.handId = left ? left.id : null;
    for (const v of [lead, bass]) {
      v.state.active = !!left;
      v.state.instrument = v.player ? v.player.spec.id : v.wanted;
      v.state.laneIndex = -1;
    }

    const hv = this.handVolume;
    if (!gate) {
      this.playChord(lead, '', [], 0, t, s.chordPlay);
      this.playChord(bass, '', [], 0, t, 'block');
      for (const v of [lead, bass]) {
        const st = v.state;
        st.gate = false;
        st.midi = null;
        st.note = '';
        st.velocity = 0;
        st.brightness = bright;
        v.channel?.set(t, bright, 0, this.specFor(v).sustained ? 0 : hv * hv);
      }
      this.expression = 0;
      return;
    }

    const picked = degreeChord(s.key, s.scale, degree - 1, style, this.borrowed);
    const flats = usesFlats(s.key, s.scale);
    const shift = octaveDown ? -12 : 0;
    const id = `${picked.root}${picked.type.suffix}:${style}:${shift}:${this.techRev}`;
    let notes: readonly number[] = lead.part.voicing;
    if (id !== lead.chordId || !notes.length) {
      const lo = Math.max(leadSpec.range[0], 36);
      const hi = Math.max(lo + 14, Math.min(leadSpec.range[1], 88));
      const base = this.voiceChordFor(lead, picked, style, 60 + 12 * s.octave, lo, hi);
      lead.lastVoicing = base;
      const shifted = base.map((n) => n + shift).filter((n) => n >= leadSpec.range[0] && n <= leadSpec.range[1]);
      notes = shifted.length >= Math.min(2, base.length) ? shifted : base;
    }
    // What actually sounds (a distortion guitar plays the power chord).
    const chord = soundingChord(picked, notes);
    const velocity = leadSpec.sustained ? 1 : clamp01(dynTarget);
    this.playChord(lead, id, notes, velocity, t, s.chordPlay, false, chord);

    // Bass: the chord root an octave or two below the chord, played per the bass pattern.
    const low = Math.min(...notes);
    let root = low - mod12(low - chord.root) - 12;
    while (root > 47) root -= 12;
    while (root < bassSpec.range[0]) root += 12;
    while (root > bassSpec.range[1]) root -= 12;
    if (s.bassPattern === 'off') this.playChord(bass, '', [], 0, t, 'block', true);
    else this.playChord(bass, `${root}:${s.bassPattern}`, [root], bassSpec.sustained ? 1 : clamp01(dynTarget) * 0.9, t, 'block', true, chord);

    this.playedChord = chord;
    this.playedDegree = degree;
    // Palm mute: damped strings are darker.
    if (this.techFor(lead).palmMute) bright *= 0.62;
    const leadLevel = leadSpec.sustained ? lead.dyn * hv : hv;
    const bassLevel = bassSpec.sustained ? lead.dyn * hv : hv;
    lead.channel!.set(t, bright, 0, leadLevel * leadLevel);
    bass.channel!.set(t, Math.min(1, bright + 0.1), 0, bassLevel * bassLevel * 0.9);

    const ls = lead.state;
    ls.gate = true;
    ls.midi = this.rootIn(notes, chord.root);
    ls.note = chordName(chord, flats);
    ls.velocity = leadSpec.sustained ? lead.dyn : velocity;
    ls.brightness = bright;
    const bs = bass.state;
    const bassMidi = bass.part.active ? (bass.part.bassMidi ?? root) : null;
    bs.gate = bassMidi !== null;
    bs.midi = bassMidi;
    bs.note = bassMidi === null ? '' : noteName(bassMidi, flats);
    bs.velocity = bassMidi === null ? 0 : ls.velocity;
    bs.brightness = bright;
    this.expression = clamp01((leadSpec.sustained ? lead.dyn : dynTarget) * hv);
  }

  // -------------------------------------------------------------------------------------------
  // Metrics
  // -------------------------------------------------------------------------------------------

  private updateMetrics(t: number): void {
    const m = this.m;
    const s = this.settings;
    // Sounding notes, ascending, unique.
    const active = m.activeMidi;
    active.length = 0;
    const push = (n: number): void => {
      const r = Math.round(n);
      if (!active.includes(r)) active.push(r);
    };
    for (const v of [this.lead, this.bass]) {
      if (v.handle >= 0 && v.midi !== null) push(v.midi);
      v.mel.forEachExtra(t, push);
      v.part.forEachSounding(push);
    }
    active.sort((a, b) => a - b);

    const flats = usesFlats(s.key, s.scale);
    if (this.playedChord) {
      // A hand picks the chord: show exactly that.
      const c = this.lastChord ?? (this.lastChord = { root: 0, type: this.playedChord.type });
      c.root = this.playedChord.root;
      c.type = this.playedChord.type;
      m.chord = chordName(c, flats);
      m.roman = romanForDegree(this.playedDegree - 1, c.type);
    } else {
      // Otherwise infer it: sounding notes weigh 1, recent notes fade out over ~1.5 s.
      const w = this.pcWeights;
      w.fill(0);
      let low = 128;
      for (const n of active) {
        w[mod12(n)]! += 1;
        low = Math.min(low, n);
      }
      for (let i = 0; i < this.recentMidi.length; i++) {
        const age = t - this.recentAt[i]!;
        if (this.recentAt[i]! <= 0 || age < 0 || age > RECENT_WINDOW_S) continue;
        const n = this.recentMidi[i]!;
        w[mod12(n)]! += 0.75 * (1 - age / RECENT_WINDOW_S) + 0.1;
        if (!active.length) low = Math.min(low, n);
      }
      if (detectChord(w, low < 128 ? mod12(low) : -1, s.key, s.scale, this.detected)) {
        const c = this.lastChord ?? (this.lastChord = { root: 0, type: this.detected.type });
        c.root = this.detected.root;
        c.type = this.detected.type;
        m.chord = chordName(c, flats);
        m.roman = romanNumeral(c, s.key, s.scale);
      }
    }
    const chordMode = s.mode === 'chords';
    m.degree = chordMode || s.leftHand === 'chords' ? this.degree.value : 0;
    if (!chordMode && s.leftHand !== 'chords') m.degreeHandId = null;
    if (!chordMode) m.styleHandId = null;
    m.borrowed = chordMode && this.borrowed;
    if (!chordMode) m.chordStyle = '';

    m.expression = this.expression;
    m.handVolume = this.handVolume;
    if (!chordMode && s.leftHand !== 'volume') m.volumeHandId = null;
    m.bpm = s.tempo;
    this.position();

    const nowMs = performance.now();
    let count = 0;
    for (let i = 0; i < this.onsetTimes.length; i++) {
      const ts = this.onsetTimes[i]!;
      if (ts > 0 && nowMs - ts <= NPM_WINDOW_MS) count++;
    }
    m.notesPerMinute = Math.round(count * (60_000 / NPM_WINDOW_MS));
    m.sessionMs = this.unlockedAt ? nowMs - this.unlockedAt : 0;
  }

  /** Bar and beat (1-based) sounding now: in the loop while loops run, else from the Transport
   *  while the groove runs; zeros otherwise. */
  private position(): void {
    const m = this.m;
    const ctx = this.ctx;
    const beats = this.meterClock.meter.beats;
    const loopBeat = this.looperImpl ? this.looperImpl.loopBeat() : -1;
    if (loopBeat >= 0) {
      m.bar = Math.floor(loopBeat / beats) + 1;
      m.beat = (loopBeat % beats) + 1;
      return;
    }
    if (!ctx || !this.groove?.isRunning || this.clockId === null || ctx.transport.state !== 'started') {
      m.bar = 0;
      m.beat = 0;
      return;
    }
    const t = ctx.transport;
    const ticks = Math.max(0, t.getTicksAtTime(ctx.currentTime));
    this.meterClock.position(ticks / (t.PPQ / 4), this.pos);
    m.bar = this.pos.bar;
    m.beat = this.pos.beat;
  }

  private currentGrooveChord(): GrooveChord {
    const s = this.settings;
    const c = this.lastChord ?? diatonicTriad(s.key, s.scale, 0);
    this.grooveChord.root = c.root;
    this.grooveChord.intervals = c.type.intervals;
    return this.grooveChord;
  }

  metrics(): MusicMetrics {
    this.analyse();
    const m = this.m;
    m.levelDb = this.rms > 1e-6 ? Math.max(-100, 20 * Math.log10(this.rms)) : -Infinity;
    if (this.ctx) {
      this.position();
      m.sessionMs = this.unlockedAt ? performance.now() - this.unlockedAt : 0;
    }
    return m;
  }

  // -------------------------------------------------------------------------------------------
  // Analysis
  // -------------------------------------------------------------------------------------------

  /** Reads the analyser at most once per ~8 ms (level, spectrum and metrics share it). */
  private analyse(): void {
    const a = this.analyser;
    if (!a || !this.freqData || !this.timeData || !this.binEdges) return;
    const now = performance.now();
    if (now - this.analysedAt < 8) return;
    this.analysedAt = now;
    this.watchdog(now);

    a.getFloatTimeDomainData(this.timeData);
    let e = 0;
    const td = this.timeData;
    for (let i = 0; i < td.length; i++) e += td[i]! * td[i]!;
    this.rms = Math.sqrt(e / td.length);

    a.getFloatFrequencyData(this.freqData);
    const fd = this.freqData;
    const edges = this.binEdges;
    for (let b = 0; b < 64; b++) {
      const lo = edges[b]!;
      const hi = Math.max(lo + 1, edges[b + 1]!);
      let peak = -Infinity;
      for (let i = lo; i < hi; i++) if (fd[i]! > peak) peak = fd[i]!;
      this.spec[b] = clamp01((peak + 95) / 70);
    }
  }

  /** No tracking frames for a second while notes hold (camera stalled): let go. */
  private watchdog(now: number): void {
    if (!this.lastUpdateAt || now - this.lastUpdateAt < 1000) return;
    const t = this.now();
    for (const v of [this.lead, this.bass]) {
      if (v.handle >= 0 || v.part.active) this.silenceVoice(v, t, this.specFor(v).release);
    }
  }

  level(): number {
    this.analyse();
    return clamp01(this.rms);
  }

  spectrum(): Float32Array {
    this.analyse();
    return this.spec;
  }

  // -------------------------------------------------------------------------------------------
  // Recording / panic
  // -------------------------------------------------------------------------------------------

  get isRecording(): boolean {
    return !!this.recorder?.isRecording;
  }

  startRecording(): void {
    const ctx = this.ctx;
    if (!ctx || !this.master) throw new Error('audio is not running');
    if (this.recorder?.isRecording) return;
    if (!this.recordTap) {
      this.recordTap = ctx.createMediaStreamDestination();
      this.master.connect(this.recordTap);
    }
    this.recorder ??= new MasterRecorder(this.recordTap.stream, (data) => ctx.decodeAudioData(data));
    this.recorder.start();
  }

  stopRecording(): Promise<Recording> {
    if (!this.recorder?.isRecording) return Promise.reject(new Error('not recording'));
    return this.recorder.stop();
  }

  panic(): void {
    if (!this.ctx) return;
    const t = this.now();
    for (const v of [this.lead, this.bass]) {
      this.silenceVoice(v, t, 0.03);
      v.player?.stopAll(t, 0.03);
      v.retrigger = false;
      v.lane = -1;
      v.dyn = 0;
      v.state.onset = false;
      v.state.laneIndex = -1;
      v.state.active = false;
      v.state.handId = null;
      v.channel?.set(t, 0.8, 0, 0);
    }
    this.mouthGate = false;
    this.expression = 0;
    this.m.degreeHandId = null;
    this.m.styleHandId = null;
    this.degree.reset();
    this.styleFingers.reset();
    this.groove?.silence();
    this.looperImpl?.panic();
    this.midi.allNotesOff();
    this.stopClock();
    this.m.activeMidi.length = 0;
  }

  // -------------------------------------------------------------------------------------------
  // Looper / MIDI
  // -------------------------------------------------------------------------------------------

  looper(): LooperState {
    return this.looperImpl ? this.looperImpl.state() : this.emptyLooper;
  }

  loop(cmd: LoopCommand): string {
    if (!this.looperImpl || this.disposed) return '';
    this.resumeIfNeeded();
    return this.looperImpl.run(cmd);
  }

  async enableMidi(): Promise<MidiStatus> {
    await this.midi.enable();
    this.midi.configure(this.settings.midiOut, this.settings.midiChannel);
    this.syncLiveMute();
    return this.midiStatus();
  }

  midiStatus(): MidiStatus {
    const s = this.midi.status;
    return { ...s, outputs: s.outputs.slice() };
  }

  onMidiStatus(cb: (s: MidiStatus) => void): () => void {
    return this.midi.onChange((s) => {
      this.syncLiveMute();
      cb(s);
    });
  }
}

export function createEngine(): MusicEngine {
  return new Engine();
}

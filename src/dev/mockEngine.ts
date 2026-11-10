import type {
  HandState,
  LoopCommand,
  LooperState,
  LoopNoteView,
  MidiStatus,
  InstrumentDef,
  InstrumentLoadState,
  Lane,
  MusicEngine,
  MusicMetrics,
  PlayZone,
  Recording,
  ScaleDef,
  Settings,
  TrackingFrame,
  VoiceId,
  VoiceState,
} from '../types';
import { DEFAULT_SETTINGS } from '../settings';

/**
 * Silent MusicEngine for UI development and screenshots (dev/ui.html). Produces plausible voices,
 * lanes and metrics from tracking frames without Web Audio. Not shipped in the app bundle.
 */

const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const noteName = (m: number): string => `${NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;

const I = (
  id: string,
  name: string,
  family: InstrumentDef['family'],
  color: string,
  glyph: string,
  blurb: string,
  sustained: boolean,
  range: [number, number],
  sizeKB: number,
): InstrumentDef => ({ id, name, family, kind: sizeKB ? 'sampled' : 'synth', sustained, range, sizeKB, color, glyph, blurb });

export const MOCK_INSTRUMENTS: readonly InstrumentDef[] = [
  I('grand-piano', 'Grand Piano', 'keys', '#7cc4ff', '🎹', 'Concert grand, warm and bright', false, [21, 108], 2400),
  I('electric-piano', 'Electric Piano', 'keys', '#5fb2ff', '🎹', 'Vintage tines, soft bell', false, [28, 103], 1300),
  I('acoustic-guitar', 'Acoustic Guitar', 'guitar', '#ffb547', '🎸', 'Steel strings, bright strum', false, [40, 84], 1100),
  I('nylon-guitar', 'Nylon Guitar', 'guitar', '#ffc46b', '🎸', 'Classical, soft and round', false, [40, 84], 1000),
  I('clean-guitar', 'Clean Electric', 'guitar', '#ff9a3c', '🎸', 'Clean amp, round tone', false, [40, 86], 1200),
  I('electric-bass', 'Electric Bass', 'bass', '#ff6b8b', '🎸', 'Fingered, punchy low end', false, [28, 67], 900),
  I('upright-bass', 'Upright Bass', 'bass', '#ff8aa2', '🎻', 'Jazz pizzicato', false, [28, 67], 800),
  I('violin', 'Violin', 'strings', '#ff8a5c', '🎻', 'Expressive solo bow', true, [55, 100], 1500),
  I('cello', 'Cello', 'strings', '#ff7a48', '🎻', 'Deep, singing bow', true, [36, 76], 1400),
  I('string-ensemble', 'String Ensemble', 'strings', '#ff9a70', '🎻', 'Lush section', true, [28, 96], 1600),
  I('harp', 'Concert Harp', 'strings', '#ffb08a', '🪉', 'Glassy plucked strings', false, [24, 103], 1200),
  I('opera-choir', 'Opera Choir', 'voice', '#ff3dcb', '🎭', 'Soaring “aah” ensemble', true, [48, 84], 1800),
  I('trumpet', 'Trumpet', 'brass', '#ffd23f', '🎺', 'Bright and bold', true, [54, 86], 900),
  I('flute', 'Flute', 'woodwind', '#6bffb8', '🪈', 'Airy and pure', true, [60, 96], 700),
  I('marimba', 'Marimba', 'mallet', '#3cf2ff', '🪘', 'Rosewood bars, mellow', false, [45, 96], 600),
  I('vibraphone', 'Vibraphone', 'mallet', '#5ff5ff', '🪘', 'Metal bars, motor shimmer', false, [53, 89], 700),
  I('sitar', 'Sitar', 'world', '#ff9f43', '🪕', 'Buzzing sympathetic strings', false, [48, 84], 800),
  I('banjo', 'Banjo', 'world', '#ffb36b', '🪕', 'Bright bluegrass twang', false, [48, 84], 700),
  I('church-organ', 'Church Organ', 'organ', '#b48cff', '⛪', 'Full pipe registration', true, [36, 96], 1000),
  I('theremin', 'Theremin', 'synth', '#8b5cf6', '〰', 'Eerie continuous pitch', true, [48, 96], 0),
  I('analog-lead', 'Analog Lead', 'synth', '#9b6bff', '◢', 'Fat saw lead', true, [36, 96], 0),
  I('warm-pad', 'Warm Pad', 'synth', '#a78bfa', '✦', 'Soft evolving pad', true, [36, 96], 0),
  I('pluck', 'Pluck', 'synth', '#c4a5ff', '◆', 'Short synth pluck', false, [36, 96], 0),
  I('sub-bass', 'Sub Bass', 'synth', '#7c4dff', '▼', 'Deep sine bass', true, [24, 60], 0),
];

export const MOCK_SCALES: readonly ScaleDef[] = [
  { id: 'major', name: 'Major', intervals: [0, 2, 4, 5, 7, 9, 11] },
  { id: 'minor', name: 'Minor', intervals: [0, 2, 3, 5, 7, 8, 10] },
  { id: 'major-pentatonic', name: 'Major pentatonic', intervals: [0, 2, 4, 7, 9] },
  { id: 'minor-pentatonic', name: 'Minor pentatonic', intervals: [0, 3, 5, 7, 10] },
  { id: 'blues', name: 'Blues', intervals: [0, 3, 5, 6, 7, 10] },
  { id: 'dorian', name: 'Dorian', intervals: [0, 2, 3, 5, 7, 9, 10] },
  { id: 'mixolydian', name: 'Mixolydian', intervals: [0, 2, 4, 5, 7, 9, 10] },
  { id: 'harmonic-minor', name: 'Harmonic minor', intervals: [0, 2, 3, 5, 7, 8, 11] },
  { id: 'japanese', name: 'Japanese', intervals: [0, 1, 5, 7, 8] },
  { id: 'chromatic', name: 'Chromatic', intervals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
  { id: 'continuous', name: 'Continuous', intervals: [] },
];

const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];
const STYLES = ['Triad', '7th', 'add9', 'sus4', 'Open'];

function idleVoice(voice: VoiceId, instrument: string): VoiceState {
  return { voice, handId: null, instrument, active: false, gate: false, midi: null, note: '', laneIndex: -1, velocity: 0, brightness: 0.5, onset: false };
}

export class MockEngine implements MusicEngine {
  readonly instruments = MOCK_INSTRUMENTS;
  readonly scales = MOCK_SCALES;
  isRecording = false;
  private s: Settings = { ...DEFAULT_SETTINGS };
  private zone: PlayZone = { y0: 0.12, y1: 0.86 };
  private leadLanes: Lane[] = [];
  private bassLanes: Lane[] = [];
  private lanesKey = '';
  private readonly voices: [VoiceState, VoiceState] = [idleVoice('lead', 'grand-piano'), idleVoice('bass', 'electric-bass')];
  private readonly listeners = new Set<(s: InstrumentLoadState) => void>();
  private readonly loaded = new Set<string>();
  private readonly timers = new Set<number>();
  private readonly onsets = new Float64Array(64);
  private onsetIx = 0;
  private t0 = 0;
  private lvl = 0;
  private recStart = 0;
  private readonly spec = new Float32Array(64);
  private readonly m: MusicMetrics = {
    keyName: 'C',
    scaleName: 'Major pentatonic',
    chord: '',
    roman: '',
    degree: 0,
    chordStyle: '',
    borrowed: false,
    diatonic: [],
    activeMidi: [],
    expression: 0,
    handVolume: 1,
    volumeHandId: null,
    degreeHandId: null,
    styleHandId: null,
    levelDb: -Infinity,
    bpm: 96,
    bar: 0,
    beat: 0,
    notesPlayed: 0,
    notesPerMinute: 0,
    sessionMs: 0,
  };

  async unlock(): Promise<void> {
    this.t0 = performance.now();
  }

  configure(settings: Settings): void {
    const prev = this.s;
    this.s = settings;
    for (const id of [settings.lead, settings.bass]) this.load(id);
    if (prev.key !== settings.key || prev.scale !== settings.scale || prev.octave !== settings.octave || prev.span !== settings.span) this.lanesKey = '';
    this.voices[0].instrument = settings.lead;
    this.voices[1].instrument = settings.bass;
    this.m.keyName = NAMES[settings.key]!;
    this.m.scaleName = this.scales.find((x) => x.id === settings.scale)?.name ?? '';
    this.m.bpm = settings.tempo;
    this.m.diatonic = this.diatonic();
  }

  setPlayZone(zone: PlayZone): void {
    this.zone = zone;
    this.lanesKey = '';
  }

  lanes(voice: VoiceId): Lane[] {
    this.buildLanes();
    return voice === 'lead' ? this.leadLanes : this.bassLanes;
  }

  update(frame: TrackingFrame): VoiceState[] {
    this.buildLanes();
    const s = this.s;
    const [lead, bass] = this.voices;
    const hands = frame.hands;
    const now = frame.t;
    const right = hands[hands.length - 1] ?? null;
    const left = hands.length === 2 ? hands[0]! : null;
    const mouth = frame.face?.mouthOpen ?? 0;
    const gateOpen = (h: HandState): boolean =>
      s.trigger === 'mouth' ? !!frame.face?.mouthIsOpen : s.trigger === 'pinch' ? h.pinching : true;
    const vel = (): number => (s.trigger === 'mouth' ? Math.min(1, 0.3 + mouth) : 0.8);

    this.m.volumeHandId = null;
    this.m.degreeHandId = null;
    this.m.styleHandId = null;
    this.m.handVolume = 1;
    this.m.degree = 0;
    this.m.chordStyle = '';
    this.m.borrowed = false;
    const active: number[] = [];

    if (s.mode === 'chords') {
      const picker = left ?? right;
      const styler = left ? right : null;
      if (styler) {
        this.m.handVolume = this.heightTo01(styler.indexTip.y);
        this.m.volumeHandId = styler.id;
        this.m.styleHandId = styler.id;
        this.m.chordStyle = STYLES[Math.max(1, Math.min(5, styler.fingersUp)) - 1]!;
      }
      if (picker) {
        const f = picker.fingers;
        const deg = f[0] && f[1] && f[4] && !f[2] ? 7 : f[1] && f[4] && !f[2] ? 6 : Math.max(1, Math.min(5, picker.fingersUp));
        this.m.degree = deg;
        this.m.degreeHandId = picker.id;
        this.m.borrowed = Math.abs(picker.roll) > 0.5 && s.tiltControls;
        const chord = this.m.diatonic[deg - 1] ?? '';
        const g = gateOpen(picker);
        this.setVoice(lead, picker.id, g, 48 + s.key + (this.scaleIv()[deg - 1] ?? 0), chord, -1, vel() * this.m.handVolume, now);
        this.m.chord = chord;
        this.m.roman = ROMAN[deg - 1]!;
        if (lead.gate && lead.midi !== null) active.push(lead.midi, lead.midi + 4, lead.midi + 7);
      } else this.setVoice(lead, null, false, null, '', -1, 0, now);
      this.setVoice(bass, null, false, null, '', -1, 0, now);
    } else {
      if (right) {
        const ix = this.laneAt(this.leadLanes, right.indexTip.y);
        const lane = this.leadLanes[ix];
        this.setVoice(lead, right.id, gateOpen(right), lane?.midi ?? null, lane?.note ?? '', ix, vel(), now);
      } else this.setVoice(lead, null, false, null, '', -1, 0, now);

      if (left && s.leftHand === 'volume') {
        this.m.handVolume = this.heightTo01(left.indexTip.y);
        this.m.volumeHandId = left.id;
        this.setVoice(bass, null, false, null, '', -1, 0, now);
      } else if (left && s.leftHand === 'bass') {
        const ix = this.laneAt(this.bassLanes, left.indexTip.y);
        const lane = this.bassLanes[ix];
        this.setVoice(bass, left.id, lead.gate, lane?.midi ?? null, lane?.note ?? '', ix, vel(), now);
      } else if (left && s.leftHand === 'chords') {
        const deg = Math.max(1, Math.min(5, left.fingersUp));
        const chord = this.m.diatonic[deg - 1] ?? '';
        this.m.degree = deg;
        this.setVoice(bass, left.id, lead.gate, 48 + s.key + (this.scaleIv()[deg - 1] ?? 0), chord, -1, vel(), now);
      } else this.setVoice(bass, null, false, null, '', -1, 0, now);

      if (lead.gate && lead.midi !== null) active.push(Math.round(lead.midi));
      if (bass.gate && bass.midi !== null) {
        active.push(bass.midi);
        if (s.leftHand === 'chords') active.push(bass.midi + 3, bass.midi + 7);
      }
      // Implied chord from the lead note: the diatonic triad on its degree.
      if (lead.midi !== null) {
        const iv = this.scaleIv();
        const pc = (((Math.round(lead.midi) - s.key) % 12) + 12) % 12;
        const d = iv.indexOf(pc);
        if (s.leftHand === 'chords' && bass.active && this.m.degree) {
          this.m.chord = this.m.diatonic[this.m.degree - 1] ?? '';
          this.m.roman = ROMAN[this.m.degree - 1]!;
        } else if (d >= 0 && d < 7) {
          this.m.chord = this.m.diatonic[d] ?? '';
          this.m.roman = ROMAN[d]!;
        }
      }
    }
    for (const v of this.voices) v.velocity *= this.m.handVolume;
    active.sort((a, b) => a - b);
    this.m.activeMidi = active;
    this.m.expression = lead.gate ? lead.velocity : 0;
    const target = lead.gate || bass.gate ? 0.25 + 0.6 * Math.max(lead.velocity, bass.velocity) : 0;
    this.lvl += (target - this.lvl) * (target > this.lvl ? 0.5 : 0.08);
    this.m.levelDb = this.lvl > 0.001 ? 20 * Math.log10(this.lvl) : -Infinity;
    this.m.sessionMs = now - this.t0;
    if (s.groove) {
      const beats = Math.floor(((now - this.t0) / 60000) * s.tempo);
      const perBar = Number(s.timeSignature.split('/')[0]) || 4;
      this.m.bar = Math.floor(beats / perBar) + 1;
      this.m.beat = (beats % perBar) + 1;
    } else {
      this.m.bar = 0;
      this.m.beat = 0;
    }
    let recent = 0;
    for (const t of this.onsets) if (t && now - t < 10_000) recent++;
    this.m.notesPerMinute = recent * 6;
    for (let i = 0; i < 64; i++) this.spec[i] = Math.max(0, this.lvl * (1 - i / 64) * (0.6 + 0.4 * Math.sin(now / 90 + i)));
    return this.voices;
  }

  metrics(): MusicMetrics {
    return this.m;
  }

  onLoadState(cb: (s: InstrumentLoadState) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  level(): number {
    return this.lvl;
  }

  spectrum(): Float32Array {
    return this.spec;
  }

  startRecording(): void {
    this.isRecording = true;
    this.recStart = performance.now();
  }

  async stopRecording(): Promise<Recording> {
    this.isRecording = false;
    return { blob: new Blob([]), mimeType: 'audio/wav', extension: 'wav', durationMs: performance.now() - this.recStart };
  }

  panic(): void {
    for (const v of this.voices) v.gate = false;
  }

  // Looper / MIDI: a pretend looper so the panel can be designed without audio.
  private readonly loopState: LooperState = {
    bars: 2,
    phase: 'idle',
    recordTrack: -1,
    countIn: 0,
    progress: 0,
    takeProgress: 0,
    seconds: 5,
    tracks: [0, 1, 2, 3].map((index) => ({ index, notes: 0, muted: false, solo: false, audible: false, recording: false, instruments: [], view: [], pulse: 0 })),
    canUndo: false,
    version: 0,
  };
  private loopT0 = 0;
  private recAt = 0;

  looper(): LooperState {
    const st = this.loopState;
    const now = performance.now();
    st.bars = this.s.loopBars;
    st.seconds = (st.bars * 4 * 60) / this.s.tempo;
    const loopMs = st.seconds * 1000;
    const has = st.tracks.some((t) => t.notes > 0);
    if (st.recordTrack >= 0) {
      const el = now - this.recAt;
      const countMs = (4 * 60_000) / this.s.tempo;
      st.phase = el < countMs ? 'count-in' : 'recording';
      st.countIn = el < countMs ? Math.max(1, 4 - Math.floor(el / (countMs / 4))) : 0;
      st.takeProgress = el < countMs ? 0 : Math.min(1, (el - countMs) / loopMs);
      if (st.takeProgress >= 1) this.loop({ type: 'record' });
    } else {
      st.phase = has ? 'playing' : 'idle';
      st.countIn = 0;
      st.takeProgress = 0;
    }
    st.progress = has || st.phase === 'recording' ? ((now - this.loopT0) % loopMs) / loopMs : 0;
    const soloing = st.tracks.some((t) => t.solo && t.notes);
    for (const t of st.tracks) {
      t.audible = t.notes > 0 && !t.muted && (!soloing || t.solo);
      t.recording = st.recordTrack === t.index;
      let pulse = 0;
      for (const n of t.view) {
        const d = st.progress - n.start;
        if (d >= 0 && d < 0.03) pulse = 1 - d / 0.03;
      }
      t.pulse = t.audible ? pulse : 0;
    }
    return st;
  }

  loop(cmd: LoopCommand): string {
    const st = this.loopState;
    st.version++;
    switch (cmd.type) {
      case 'record': {
        if (st.recordTrack >= 0 && (cmd.track === undefined || cmd.track === st.recordTrack)) {
          const t = st.tracks[st.recordTrack]!;
          const view: LoopNoteView[] = [...t.view];
          const n = 6 + Math.floor(Math.random() * 10);
          for (let i = 0; i < n; i++) {
            view.push({ start: Math.floor(Math.random() * 32) / 32, length: (1 + Math.floor(Math.random() * 3)) / 32, midi: 55 + Math.floor(Math.random() * 20), voice: 'lead', instrument: this.s.lead });
          }
          t.view = view;
          t.notes = view.length;
          if (!t.instruments.includes(this.s.lead)) t.instruments = [...t.instruments, this.s.lead];
          st.recordTrack = -1;
          st.canUndo = true;
          return `Loop ${t.index + 1}: ${n} notes saved`;
        }
        const free = cmd.track ?? st.tracks.findIndex((t) => !t.notes);
        if (free < 0) return 'All 4 loop tracks are full: clear one first';
        if (!st.tracks.some((t) => t.notes)) this.loopT0 = performance.now() + (4 * 60_000) / this.s.tempo;
        st.recordTrack = free;
        this.recAt = performance.now();
        return `Loop ${free + 1}: count-in…`;
      }
      case 'stop':
        return st.recordTrack >= 0 ? this.loop({ type: 'record' }) : '';
      case 'clear':
      case 'clear-all':
        for (const t of st.tracks) {
          if (cmd.type === 'clear' && t.index !== cmd.track) continue;
          t.view = [];
          t.notes = 0;
          t.instruments = [];
          t.muted = t.solo = false;
        }
        return cmd.type === 'clear' ? `Loop ${cmd.track + 1} cleared` : 'All loops cleared';
      case 'mute':
      case 'solo': {
        const t = st.tracks[cmd.track];
        if (!t) return '';
        if (cmd.type === 'mute') t.muted = !t.muted;
        else t.solo = !t.solo;
        return `Loop ${cmd.track + 1} ${cmd.type === 'mute' ? (t.muted ? 'muted' : 'unmuted') : t.solo ? 'solo' : 'solo off'}`;
      }
      case 'undo':
        return 'Nothing to undo';
      default:
        return '';
    }
  }

  private readonly midiSt: MidiStatus = { supported: true, enabled: false, pending: false, error: '', outputs: [], connected: false };

  async enableMidi(): Promise<MidiStatus> {
    this.midiSt.enabled = true;
    this.midiSt.outputs = [
      { id: 'mock-1', name: 'IAC Driver Bus 1' },
      { id: 'mock-2', name: 'USB MIDI Interface' },
    ];
    this.midiSt.connected = this.s.midiOut !== '';
    return { ...this.midiSt };
  }

  midiStatus(): MidiStatus {
    return { ...this.midiSt };
  }

  onMidiStatus(): () => void {
    return () => undefined;
  }

  dispose(): void {
    for (const t of this.timers) window.clearTimeout(t);
    this.timers.clear();
    this.listeners.clear();
  }

  // -------------------------------------------------------------------------------------------

  private setVoice(v: VoiceState, handId: number | null, gate: boolean, midi: number | null, note: string, lane: number, vel: number, now: number): void {
    const was = v.gate;
    const prevMidi = v.midi;
    v.handId = handId;
    v.active = handId !== null;
    v.gate = v.active && gate && midi !== null;
    v.midi = v.active ? midi : null;
    v.note = v.active ? note : '';
    v.laneIndex = v.active ? lane : -1;
    v.velocity = v.gate ? vel : 0;
    v.onset = v.gate && (!was || prevMidi !== midi);
    if (v.onset) {
      this.m.notesPlayed++;
      this.onsets[this.onsetIx] = now;
      this.onsetIx = (this.onsetIx + 1) % this.onsets.length;
    }
  }

  private heightTo01(y: number): number {
    const { y0, y1 } = this.zone;
    return Math.max(0, Math.min(1, 1 - (y - y0) / (y1 - y0)));
  }

  private laneAt(lanes: Lane[], y: number): number {
    if (!lanes.length) return -1;
    const { y0, y1 } = this.zone;
    const t = Math.max(0, Math.min(0.9999, (y - y0) / (y1 - y0)));
    return Math.floor(t * lanes.length);
  }

  private scaleIv(): number[] {
    const iv = this.scales.find((x) => x.id === this.s.scale)?.intervals ?? [];
    return iv.length === 7 ? iv : [0, 2, 4, 5, 7, 9, 11];
  }

  private diatonic(): string[] {
    const iv = this.scaleIv();
    return iv.map((root, i) => {
      const third = (iv[(i + 2) % 7]! - root + 12) % 12;
      const fifth = (iv[(i + 4) % 7]! - root + 12) % 12;
      const name = NAMES[(this.s.key + root) % 12]!;
      return fifth === 6 ? `${name}dim` : third === 3 ? `${name}m` : name;
    });
  }

  private buildLanes(): void {
    const key = `${this.s.key}|${this.s.scale}|${this.s.octave}|${this.s.span}|${this.zone.y0}|${this.zone.y1}`;
    if (key === this.lanesKey) return;
    this.lanesKey = key;
    const make = (count: number, base: number, y0: number, y1: number): Lane[] => {
      const iv = this.scales.find((x) => x.id === this.s.scale)?.intervals ?? [];
      const steps = iv.length ? iv : [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
      const notes: number[] = [];
      for (let o = 0; notes.length < count; o++) for (const st of steps) if (notes.length < count) notes.push(base + o * 12 + st);
      notes.reverse();
      const hh = (y1 - y0) / count;
      return notes.map((midi, i) => ({ midi, note: noteName(midi), y: y0 + hh * (i + 0.5), h: hh, isRoot: (((midi - this.s.key) % 12) + 12) % 12 === 0 }));
    };
    // Same layout as the real engine: root in octave 4 + octave (3 when the span covers > ~2 octaves).
    const ivLen = this.scales.find((x) => x.id === this.s.scale)?.intervals.length || 12;
    const baseOctave = (this.s.span / ivLen) * 12 > 26 ? 3 : 4;
    this.leadLanes = make(this.s.span, 12 * (baseOctave + 1 + this.s.octave) + this.s.key, this.zone.y0, this.zone.y1);
    this.bassLanes = make(8, 36 + this.s.key, this.zone.y0, this.zone.y1);
  }

  private load(id: string): void {
    if (this.loaded.has(id)) return;
    this.loaded.add(id);
    const def = this.instruments.find((x) => x.id === id);
    if (!def || !def.sizeKB) return;
    let p = 0;
    const step = (): void => {
      p = Math.min(1, p + 0.18);
      for (const cb of this.listeners) cb({ id, loading: p < 1, progress: p });
      if (p < 1) {
        const t = window.setTimeout(() => {
          this.timers.delete(t);
          step();
        }, 140);
        this.timers.add(t);
      }
    };
    step();
  }
}

export function createMockEngine(): MusicEngine {
  return new MockEngine();
}

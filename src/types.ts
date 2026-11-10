/**
 * Shared contract between the three feature modules:
 *
 *   tracking/  camera + MediaPipe  ->  TrackingFrame
 *   music/     TrackingFrame + Settings  ->  sound (Tone.js) + VoiceState[] for the HUD
 *   ui/        landing page, stage, HUD overlay, controls
 *
 * app.ts wires them together. Change this file only in coordination with every module.
 *
 * COORDINATES
 * Every point and box in this file is normalized to the camera frame (0..1 on both axes) and is
 * ALREADY MIRRORED for the selfie view: x = 0 is the left edge of what the user sees on screen,
 * y = 0 is the top. The <video> element is displayed mirrored (CSS scaleX(-1)) with
 * object-fit: cover, so the UI maps these points to pixels with `coverMap` / `toScreen` from
 * geometry.ts and they line up with the picture.
 */

export interface Vec2 {
  x: number;
  y: number;
}

export interface Vec3 extends Vec2 {
  z: number;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

export type AppErrorCode =
  | 'insecure-context' // page is not served over HTTPS / localhost, camera API unavailable
  | 'no-camera-api' // browser has no navigator.mediaDevices.getUserMedia
  | 'camera-denied' // user or OS blocked camera permission
  | 'camera-not-found' // no video input device
  | 'camera-in-use' // device busy (another app / tab)
  | 'model-load-failed' // MediaPipe wasm or model could not load
  | 'audio-failed' // Web Audio could not start
  | 'unknown';

export class AppError extends Error {
  readonly code: AppErrorCode;
  constructor(code: AppErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AppError';
    this.code = code;
  }
}

/** Boot / asset loading progress, shown by the UI. `total` is 0 when unknown. */
export interface LoadProgress {
  stage: 'runtime' | 'hands' | 'face' | 'camera' | 'audio';
  label: string;
  loaded: number;
  total: number;
  done: boolean;
}

// ---------------------------------------------------------------------------------------------
// Tracking (src/tracking)
// ---------------------------------------------------------------------------------------------

/** The user's anatomical hand. In the mirrored view the right hand appears on the right. */
export type HandSide = 'left' | 'right';

/** Static hand pose, recognized every frame and debounced (stable for ~120 ms before it changes). */
export type HandGesture = 'none' | 'open' | 'fist' | 'point' | 'peace' | 'thumbs-up' | 'rock';

export interface HandState {
  /** Stable slot id (0 or 1), kept while the hand stays tracked. Key animations on it. */
  id: number;
  side: HandSide;
  /** 21 smoothed landmarks in MediaPipe order (0 wrist, 4 thumb tip, 8 index tip, ...). */
  landmarks: Vec3[];
  /** Tight bounding box around the landmarks. */
  box: Box;
  /** Smoothed index fingertip (landmark 8): the pitch pointer. */
  indexTip: Vec2;
  /** Smoothed thumb tip (landmark 4). */
  thumbTip: Vec2;
  /** 0..1, 1 = thumb and index tips touching (normalized by palm size). */
  pinch: number;
  /** Pinch with hysteresis, safe to use as a gate. */
  pinching: boolean;
  /** Number of extended fingers, 0..5. */
  fingersUp: number;
  /** Which fingers are extended [thumb, index, middle, ring, pinky], debounced like `gesture`. */
  fingers: [boolean, boolean, boolean, boolean, boolean];
  /** Wrist roll in radians as seen on screen: 0 = fingers pointing up, positive = tilted clockwise
   *  (toward the right of the screen), smoothed. */
  roll: number;
  /** Thumb stretched out sideways, away from the palm (not just "extended"). */
  thumbOut: boolean;
  /** Debounced pose: fist (0 fingers), open (5), point (index), peace (index+middle),
   *  thumbs-up (only the thumb, pointing up), rock (index+pinky), none otherwise. */
  gesture: HandGesture;
  /** Detection confidence 0..1. */
  score: number;
  /** Milliseconds this hand has been continuously tracked (for fade-in animations). */
  age: number;
}

export interface FaceState {
  box: Box;
  /** 0..1 smoothed mouth opening (jawOpen blendshape with a lip-gap fallback), calibrated so a
   *  relaxed closed mouth is ~0 and a wide-open mouth is ~1. */
  mouthOpen: number;
  /** Gate with hysteresis derived from mouthOpen (opens above ~0.22, closes below ~0.12). */
  mouthIsOpen: boolean;
  /** 0..1 "oo" mouth shape (mouthPucker / mouthFunnel). */
  pucker: number;
  /** 0..1 smile. */
  smile: number;
  /** 0..1 eyebrows raised (browInnerUp). */
  browUp: number;
  /** Closed polygons for drawing the lips. */
  outerLips: Vec2[];
  innerLips: Vec2[];
  mouthCenter: Vec2;
}

/** Why the picture is (not) ideal for tracking, most important problem first. */
export type FrameVerdict =
  | 'great'
  | 'good'
  | 'no-hands'
  | 'too-dark'
  | 'too-bright'
  | 'too-far'
  | 'too-close'
  | 'hand-cut-off'
  | 'unstable'
  | 'low-fps';

/** Live framing / tracking quality, the "is this the best frame?" flag for the HUD. */
export interface FrameQuality {
  /** 0..1 overall quality. */
  score: number;
  verdict: FrameVerdict;
  /** True when the framing is ideal for playing (verdict 'great'). The UI also requires a face in mouth mode. */
  ideal: boolean;
  /** 0..1 brightness, sampled a few times per second on a tiny canvas: 70% the face and hand
   *  regions + 30% the whole picture (whole picture only when nobody is tracked), so a well-lit
   *  player in front of a dark wall does not read as "too dark". */
  brightness: number;
  /** Average hand box height / frame height (0 when no hands): distance cue. */
  handScale: number;
}

export interface TrackingFrame {
  /** performance.now() when this frame was processed. */
  t: number;
  /** 0..2 hands, sorted by box center x ascending (screen left -> right). */
  hands: HandState[];
  face: FaceState | null;
  /** Tracking throughput (frames per second), smoothed. */
  fps: number;
  quality: FrameQuality;
  /** Intrinsic camera frame size in pixels. */
  video: { width: number; height: number };
}

export interface Tracker {
  /** Which MediaPipe delegate ended up running, null before init. */
  readonly delegate: 'GPU' | 'CPU' | null;
  /** Loads the wasm runtime and both models (GPU delegate, CPU fallback). Throws AppError('model-load-failed'). */
  init(onProgress?: (p: LoadProgress) => void): Promise<void>;
  /** Starts the per-video-frame loop. Calls onFrame once per processed frame. */
  start(video: HTMLVideoElement, onFrame: (frame: TrackingFrame) => void): void;
  /** Low-power mode: cap tracking around 15-20 fps and run the face model less often. */
  setLowPower(on: boolean): void;
  stop(): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------------------------
// Music (src/music)
// ---------------------------------------------------------------------------------------------

/** lead = the right hand (or the only hand); bass = the left hand when leftHand = 'bass'. */
export type VoiceId = 'lead' | 'bass';

/**
 * What a second (left) hand does:
 *  - 'volume': theremin style, its height sets the loudness (top = loud, bottom = silent)
 *  - 'bass':   it plays the bass voice (its height picks the note) with the `bass` instrument
 *  - 'chords': its raised finger count 1..5 picks the diatonic chord I..V of the key, played by
 *              the `bass` instrument under the melody (0 fingers / fist = no chord)
 *  - 'off':    ignored, only the rightmost hand plays
 */
export type LeftHandRole = 'volume' | 'bass' | 'chords' | 'off';

export type InstrumentFamily =
  | 'keys'
  | 'guitar'
  | 'bass'
  | 'strings'
  | 'voice'
  | 'brass'
  | 'woodwind'
  | 'mallet'
  | 'organ'
  | 'world'
  | 'synth';

export interface InstrumentDef {
  id: string;
  name: string;
  family: InstrumentFamily;
  kind: 'sampled' | 'synth';
  /** true: holds while the gate is open (bowed, blown, sung, synth pads).
   *  false: struck/plucked, decays naturally and re-triggers on each new note. */
  sustained: boolean;
  /** Playable MIDI range, inclusive. */
  range: [number, number];
  /** Approximate download size in KB (0 for synths). */
  sizeKB: number;
  /** Accent color (#rrggbb) used by the UI for glows and trails. */
  color: string;
  /** Short glyph the UI may show on the instrument card (1-2 chars or an emoji). */
  glyph: string;
  /** One-line description, e.g. "Concert grand, warm and bright". */
  blurb: string;
}

export type ScaleId =
  | 'major'
  | 'minor'
  | 'major-pentatonic'
  | 'minor-pentatonic'
  | 'blues'
  | 'dorian'
  | 'mixolydian'
  | 'harmonic-minor'
  | 'japanese'
  | 'chromatic'
  | 'continuous';

export interface ScaleDef {
  id: ScaleId;
  name: string;
  /** Semitone offsets from the root inside one octave; empty for 'continuous'. */
  intervals: number[];
}

/**
 * melody: the right hand's height picks single notes on the lanes (default).
 * chords: gesture chord player. The LEFT hand's finger pattern picks the scale degree
 *   (1 finger I, 2 ii, 3 iii, 4 IV, 5 V, index+pinky vi, thumb+index+pinky vii); left wrist tilt
 *   swaps major/minor (when tiltControls). The RIGHT hand's height = volume, finger count = chord
 *   style (1 triad, 2 seventh, 3 add9, 4 sus4, 5 big open voicing), wrist tilt = filter, thumb out =
 *   octave down, fist = mute. One hand only: it picks the degree.
 */
export type PlayMode = 'melody' | 'chords';

/** How chords are played: all at once, strummed low to high, or arpeggiated in time with the tempo. */
export type ChordPlay = 'block' | 'strum' | 'arp';

/** Backing beat pattern. */
export type BeatStyle = 'pop' | 'lofi' | 'rock' | 'house' | 'metronome';

/** What opens the "gate" (makes sound): mouth open, thumb-index pinch, or any visible hand. */
export type TriggerMode = 'mouth' | 'pinch' | 'always';

/** Gestures the user can bind to an action in the settings. */
export type ActionGesture = 'fist' | 'peace' | 'thumbs-up' | 'rock';

/**
 * What a bound gesture does. 'mute' is held: the voice of the hand making the gesture is silent
 * while the gesture lasts (handled by the music engine). Every other action fires once when the
 * gesture has been held ~0.5 s, then waits for a cooldown (handled by app.ts).
 */
export type GestureAction =
  | 'none'
  | 'mute'
  | 'octave-up'
  | 'octave-down'
  | 'next-instrument'
  | 'prev-instrument'
  | 'next-preset'
  | 'next-scale'
  | 'toggle-groove'
  | 'toggle-record';

export interface Settings {
  mode: PlayMode;
  /** How chords sound (chords mode and the left-hand 'chords' role). */
  chordPlay: ChordPlay;
  /** Wrist tilt controls (major/minor swap on the left hand, filter on the right) in chords mode. */
  tiltControls: boolean;
  /** InstrumentDef id played by the lead voice (right hand / only hand; the chords in chords mode). */
  lead: string;
  /** InstrumentDef id for the left hand's voice (leftHand = 'bass' or 'chords'). */
  bass: string;
  /** Role of a second hand on the left. */
  leftHand: LeftHandRole;
  /** Root key 0..11 (0 = C). */
  key: number;
  scale: ScaleId;
  /** Octave shift for the lead voice, -2..2. */
  octave: number;
  /** Number of notes spread across the play zone for the lead voice, 8..24. */
  span: number;
  trigger: TriggerMode;
  /** Mouth gate sensitivity 0..1 (0.5 = default). Higher opens the gate with a smaller mouth. */
  sensitivity: number;
  /** Backing beat on/off. */
  groove: boolean;
  /** Backing beat pattern. */
  beat: BeatStyle;
  /** Beat tempo in BPM, 60..160. */
  tempo: number;
  /** Reverb wet amount 0..1. */
  reverb: number;
  /** Master volume 0..1. */
  volume: number;
  /** Draw the hand skeleton. */
  skeleton: boolean;
  /** Draw note lanes. */
  lanes: boolean;
  /** Low-power mode for weak devices: fewer tracking frames, no particles, lower canvas resolution. */
  lowPower: boolean;
  /** Master switch for gesture actions. */
  gesturesEnabled: boolean;
  /** Action bound to each gesture. Left-hand gestures are ignored in 'chords' mode (finger counts pick chords). */
  gestures: Record<ActionGesture, GestureAction>;
}

export interface VoiceState {
  voice: VoiceId;
  /** HandState.id driving this voice, null when no hand is assigned. */
  handId: number | null;
  /** InstrumentDef id. */
  instrument: string;
  /** A hand is assigned to this voice. */
  active: boolean;
  /** Sounding right now. */
  gate: boolean;
  /** Current MIDI note (fractional in 'continuous' scale), null when idle. */
  midi: number | null;
  /** Display name such as "C#4" (or the chord name, e.g. "Am", for a chords voice), "" when idle. */
  note: string;
  /** Index into lanes(voice), -1 when idle. */
  laneIndex: number;
  /** 0..1 loudness. */
  velocity: number;
  /** 0..1 tone brightness (filter). */
  brightness: number;
  /** True for exactly one update when a new note started (for UI pulses / particles). */
  onset: boolean;
}

/** One horizontal note lane. y and h are normalized camera-frame coordinates. */
export interface Lane {
  midi: number;
  note: string;
  /** Center y. */
  y: number;
  /** Lane height. */
  h: number;
  isRoot: boolean;
}

/** Vertical range of the camera frame (normalized) mapped to pitch. y0 (top) < y1 (bottom). */
export interface PlayZone {
  y0: number;
  y1: number;
}

export interface InstrumentLoadState {
  id: string;
  loading: boolean;
  /** 0..1 */
  progress: number;
  error?: string;
}

export interface Recording {
  blob: Blob;
  mimeType: string;
  /** Suggested file extension without the dot: "wav" when the take could be converted, else "webm" / "m4a" / "ogg". */
  extension: string;
  durationMs: number;
}

/** Live numbers for the musician's metrics strip. Updated by every `update()`. */
export interface MusicMetrics {
  /** Key root as text, e.g. "C", "F#", "Bb". */
  keyName: string;
  /** Scale display name, e.g. "Major pentatonic". */
  scaleName: string;
  /** Chord implied by the sounding + recent notes, e.g. "Am7", "C5", "" when nothing played yet. */
  chord: string;
  /** Roman numeral of that chord in the key, e.g. "vi", "" when not diatonic / unknown. */
  roman: string;
  /** Chord degree 1..7 selected by a hand (chords mode / left-hand chords role), 0 when none. */
  degree: number;
  /** Chord style picked by the right hand in chords mode, e.g. "Triad", "7th", "" otherwise. */
  chordStyle: string;
  /** True when the left wrist tilt swapped the chord's major/minor quality. */
  borrowed: boolean;
  /** HandState.id of the hand picking the chord degree, null if none. */
  degreeHandId: number | null;
  /** HandState.id of the hand shaping the chord (style / volume / filter) in chords mode, null if none. */
  styleHandId: number | null;
  /** The 7 diatonic chords of the current key for the degree guide, e.g. ["C","Dm","Em","F","G","Am","Bdim"]. */
  diatonic: string[];
  /** MIDI notes (integers) sounding right now, lead and bass, ascending. */
  activeMidi: number[];
  /** Overall expression 0..1 actually applied (mouth openness x hand volume). */
  expression: number;
  /** Left-hand volume 0..1 (1 when leftHand is not 'volume' or no left hand yet). */
  handVolume: number;
  /** HandState.id of the hand acting as the volume control, null if none. */
  volumeHandId: number | null;
  /** Output level in dBFS, -Infinity..0, for a numeric readout. */
  levelDb: number;
  /** Groove tempo. */
  bpm: number;
  /** Groove position, 1-based; both 0 when the groove is off. */
  bar: number;
  beat: number;
  /** Notes started since the engine was unlocked. */
  notesPlayed: number;
  /** Notes per minute over the last ~10 s. */
  notesPerMinute: number;
  /** Milliseconds since the engine was unlocked. */
  sessionMs: number;
}

export interface MusicEngine {
  readonly instruments: readonly InstrumentDef[];
  readonly scales: readonly ScaleDef[];
  /** Call from the Start click/tap handler, before any await: unlocks Web Audio (incl. iOS mute switch). */
  unlock(): Promise<void>;
  /** Apply the full settings object. Loads instruments lazily. Cheap when nothing changed. */
  configure(settings: Settings): void;
  setPlayZone(zone: PlayZone): void;
  /** Called on every tracking frame. Maps gestures to sound and returns [lead, bass] state. */
  update(frame: TrackingFrame): VoiceState[];
  /** Note lanes for a voice, top to bottom. */
  lanes(voice: VoiceId): Lane[];
  /** Live metrics for the HUD strip. Returns the same object instance each call (mutated). */
  metrics(): MusicMetrics;
  /** Subscribe to instrument loading; returns an unsubscribe function. */
  onLoadState(cb: (s: InstrumentLoadState) => void): () => void;
  /** Output RMS level 0..1 for visuals. */
  level(): number;
  /** 64 FFT bins 0..1 for visuals. Returns the same array instance each call. */
  spectrum(): Float32Array;
  readonly isRecording: boolean;
  startRecording(): void;
  stopRecording(): Promise<Recording>;
  /** Release every note now (tab hidden, exit). */
  panic(): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------------------------
// UI (src/ui)
// ---------------------------------------------------------------------------------------------

export interface LandingView {
  readonly el: HTMLElement;
  /** Disable the Start button and show a short status label (or restore it). */
  setBusy(busy: boolean, label?: string): void;
  showError(err: AppError): void;
  destroy(): void;
}

export interface StageCallbacks {
  /** User changed one or more settings in the controls. */
  onSettings(patch: Partial<Settings>): void;
  onRecordToggle(): void;
  /** User left the stage (back to the landing page). */
  onExit(): void;
  /** Start learning a song (null = stop learning). `mode` defaults to 'wait'. Optional: without it
   *  the stage hides its Learn entry. */
  onLearn?(songId: string | null, mode?: LearnMode): void;
}

export interface HudStatus {
  fps: number;
  delegate: 'GPU' | 'CPU' | null;
  hands: number;
  face: boolean;
}

/** A gesture action that just fired, for a short HUD flash ("✌ Next instrument: Violin"). */
export interface GestureEvent {
  gesture: ActionGesture;
  action: GestureAction;
  /** Human text describing the result. */
  label: string;
  /** performance.now() when it fired. */
  t: number;
}

/** Everything the stage draws in one animation frame. */
export interface StageRenderData {
  /** Latest tracking result, null until tracking runs. */
  frame: TrackingFrame | null;
  voices: readonly VoiceState[];
  lanes: { lead: readonly Lane[]; bass: readonly Lane[] };
  audio: { level: number; spectrum: Float32Array };
  metrics: MusicMetrics;
  status: HudStatus;
  /** Most recent gesture action (stays set; compare `t` to animate), null before the first one. */
  lastGesture: GestureEvent | null;
  /** Gesture held toward an action right now and how far along the ~0.5 s hold is (0..1), for a ring. */
  pendingGesture: { handId: number; gesture: ActionGesture; progress: number } | null;
  /** Learn mode progress, null (or absent) when no song is being learned. */
  learn?: LearnState | null;
}

export interface StageView {
  readonly el: HTMLElement;
  /** The <video> the camera stream is attached to (muted, playsinline, mirrored by CSS). */
  readonly video: HTMLVideoElement;
  /** Element the overlay covers; its client size is the visible viewport for geometry. */
  readonly viewport: HTMLElement;
  setInstruments(list: readonly InstrumentDef[], scales: readonly ScaleDef[]): void;
  setSettings(settings: Settings): void;
  setBootProgress(p: LoadProgress | null): void;
  setLoadState(s: InstrumentLoadState): void;
  setRecording(on: boolean): void;
  /** Called once per animation frame with the latest data. */
  render(data: StageRenderData): void;
  showError(err: AppError): void;
  toast(message: string): void;
  /** Songs offered by Learn mode, with the best result stored on this device. */
  setSongs(list: readonly SongInfo[]): void;
  destroy(): void;
}

// ---------------------------------------------------------------------------------------------
// Learn (src/learn): guided songs on the lead voice
// ---------------------------------------------------------------------------------------------

/** wait: the song waits on every note until you play it. tempo: the notes move on at the song's tempo. */
export type LearnMode = 'wait' | 'tempo';

/** Best finished run of a song stored on this device. */
export interface LearnBest {
  /** 1..3 */
  stars: number;
  /** 0..1 */
  accuracy: number;
  bestStreak: number;
  mode: LearnMode;
}

/** A song in the Learn list. */
export interface SongInfo {
  id: string;
  title: string;
  /** Composer or origin, e.g. "L. v. Beethoven", "Traditional". */
  credit: string;
  /** 1 easy, 2 medium, 3 hard. */
  difficulty: 1 | 2 | 3;
  /** Number of notes to play. */
  length: number;
  bpm: number;
  /** Display key, e.g. "C major". */
  keyName: string;
  best: LearnBest | null;
}

/** One note of the song as it appears on the lead lanes right now. */
export interface LearnNote {
  /** MIDI note on the lanes (the song shifted by whole octaves to sit on them). */
  midi: number;
  /** Display name, e.g. "E4". */
  note: string;
  /** Index into StageRenderData.lanes.lead, -1 when no lane carries this note. */
  laneIndex: number;
  /** Length in beats. */
  beats: number;
}

/**
 * Live Learn mode state, one object mutated in place by the controller. Timestamps are
 * performance.now() milliseconds (the TrackingFrame clock); 0 means "not yet".
 */
export interface LearnState {
  songId: string;
  title: string;
  mode: LearnMode;
  /** Index of the note to play now; equals `total` once the song is done. */
  index: number;
  total: number;
  /** The note to play now, null when done. */
  target: LearnNote | null;
  /** The target followed by the next notes (up to 7 in all) for the ribbon. */
  upcoming: readonly LearnNote[];
  /** Notes played on the right pitch. */
  hits: number;
  /** Notes with a wrong note (or, in tempo mode, not played in time); at most one per note. */
  misses: number;
  /** Notes in a row played without a miss. */
  streak: number;
  bestStreak: number;
  /** 0..1 share of the judged notes played without a miss (1 before the first note). */
  accuracy: number;
  /** 0..1 */
  progress: number;
  done: boolean;
  /** 0..3 stars, final once done. */
  stars: number;
  /** The finished run beat the stored best for this song. */
  newBest: boolean;
  lastHitT: number;
  lastMissT: number;
  startedT: number;
  finishedT: number;
  /** Song tempo, ms per beat. */
  msPerBeat: number;
  /** Tempo mode: song clock in ms from the first note (negative during the count-in); 0 in wait mode. */
  songMs: number;
  /** Tempo mode: start of the target note on the song clock, ms. */
  targetStartMs: number;
  /** False when some song notes are on no lane (key, scale, octave or span changed after the start). */
  onLanes: boolean;
}

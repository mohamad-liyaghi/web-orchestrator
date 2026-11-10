/**
 * Looper + MIDI out harness: the real music engine driven by synthetic hands, with Web MIDI
 * replaced by a recording mock. Exposes window.__looperSelfTest() and window.__midiSelfTest()
 * for dev/music-check.mjs (headless Chrome):
 *
 *   node dev/music-check.mjs http://localhost:5186/dev/looper.html "window.__looperSelfTest()"
 *   node dev/music-check.mjs http://localhost:5186/dev/looper.html "window.__midiSelfTest()"
 */
import type { FaceState, FrameQuality, HandState, LoopCommand, Settings, TrackingFrame } from '../src/types';

// ---------------------------------------------------------------------------------------------
// Web MIDI mock (installed before the engine exists)
// ---------------------------------------------------------------------------------------------

interface SentMsg {
  port: string;
  data: number[];
  at: number;
}
const sent: SentMsg[] = [];

class MockOutput {
  state: 'connected' | 'disconnected' = 'connected';
  readonly manufacturer = 'Mock';
  readonly type = 'output';
  constructor(
    readonly id: string,
    readonly name: string,
  ) {}
  send(data: number[], at?: number): void {
    if (this.state === 'disconnected') throw new DOMException('port is disconnected', 'InvalidStateError');
    sent.push({ port: this.id, data: [...data], at: at ?? performance.now() });
  }
  open(): Promise<this> {
    return Promise.resolve(this);
  }
}

const outputs = new Map<string, MockOutput>([
  ['out-1', new MockOutput('out-1', 'Mock Synth A')],
  ['out-2', new MockOutput('out-2', 'Mock Synth B')],
]);
const access = {
  outputs,
  inputs: new Map(),
  sysexEnabled: false,
  onstatechange: null as ((e: unknown) => void) | null,
};
let midiRequests = 0;
Object.defineProperty(navigator, 'requestMIDIAccess', {
  configurable: true,
  value: () => {
    midiRequests++;
    return Promise.resolve(access);
  },
});

const { createMusicEngine } = await import('../src/music');
const { DEFAULT_SETTINGS } = await import('../src/settings');

const engine = createMusicEngine();
// The checks play melodies on lanes (the app now starts in chords mode).
let settings: Settings = { ...DEFAULT_SETTINGS, gestures: { ...DEFAULT_SETTINGS.gestures }, mode: 'melody' };

// ---------------------------------------------------------------------------------------------
// Internals the test inspects (not part of the public API)
// ---------------------------------------------------------------------------------------------

interface DbgPlayer {
  spec: { id: string };
  activeCount: number;
  start(midi: number, velocity: number, time: number, gain?: number): number;
}
interface DbgLooper {
  players: Map<string, DbgPlayer>;
  origin: number | null;
  tracks: Array<{ events: Array<{ tick: number; dur: number; midi: number; inst: string; voice: string }> }>;
  sounding: unknown[];
  pending: Map<number, unknown>;
  undoStack: unknown[];
  soundingCount: number;
  noteOn(voice: string, inst: string, handle: number, midi: number, velocity: number, gain: number, time: number): void;
}
interface DbgEngine {
  looperImpl: DbgLooper;
  makeLoopPlayer(id: string): DbgPlayer | null;
  ctx: { currentTime: number; transport: { PPQ: number; bpm: { value: number }; getTicksAtTime(t: number): number; state: string } };
  liveBus: { gain: { value: number } };
}
const dbg = engine as unknown as DbgEngine;

/** Every loop-player note start: audio time, pitch, instrument, player. */
interface PlayLog {
  t: number;
  midi: number;
  inst: string;
  player: DbgPlayer;
}
const plays: PlayLog[] = [];
/** Logging off for the memory run (the logs themselves would grow the heap). */
let logging = true;
/** Every live note captured by the looper: audio time, pitch, instrument. */
const live: Array<{ t: number; midi: number; inst: string }> = [];

function instrumentSpies(): void {
  const make = dbg.makeLoopPlayer.bind(engine);
  dbg.makeLoopPlayer = (id: string) => {
    const p = make(id);
    if (!p) return p;
    const start = p.start.bind(p);
    p.start = (midi, velocity, time, gain) => {
      const h = start(midi, velocity, time, gain);
      if (h >= 0 && logging) {
        plays.push({ t: time, midi: Math.round(midi), inst: p.spec.id, player: p });
        if (plays.length > 4000) plays.splice(0, 1000);
      }
      return h;
    };
    return p;
  };
  const looper = dbg.looperImpl;
  const on = looper.noteOn.bind(looper);
  looper.noteOn = (voice, inst, handle, midi, velocity, gain, time) => {
    if (logging) live.push({ t: time, midi: Math.round(midi), inst });
    on(voice, inst, handle, midi, velocity, gain, time);
  };
}

function trackOf(p: DbgPlayer): number {
  for (const [k, v] of dbg.looperImpl.players) if (v === p) return Number(k.split(':')[0]);
  return -1;
}

// ---------------------------------------------------------------------------------------------
// Synthetic input
// ---------------------------------------------------------------------------------------------

const QUALITY: FrameQuality = { score: 1, verdict: 'great', ideal: true, brightness: 0.5, handScale: 0.3 };
const OPEN: HandState['fingers'] = [true, true, true, true, true];

function hand(id: number, side: 'left' | 'right', x: number, y: number): HandState {
  return {
    id,
    side,
    landmarks: Array.from({ length: 21 }, () => ({ x, y, z: 0 })),
    box: { x: x - 0.08, y: y - 0.05, w: 0.16, h: 0.3 },
    indexTip: { x, y },
    thumbTip: { x: x - 0.04, y: y + 0.05 },
    pinch: 0,
    pinching: false,
    fingersUp: 5,
    fingers: OPEN,
    roll: 0,
    thumbOut: false,
    gesture: 'open',
    score: 0.95,
    age: 1000,
  };
}
function face(mouthOpen: number): FaceState {
  return {
    box: { x: 0.4, y: 0.2, w: 0.2, h: 0.35 },
    mouthOpen,
    mouthIsOpen: mouthOpen > 0.22,
    pucker: 0,
    smile: 0,
    browUp: 0,
    outerLips: [],
    innerLips: [],
    mouthCenter: { x: 0.5, y: 0.47 },
  };
}
function frame(hands: HandState[], f: FaceState | null = null): TrackingFrame {
  return { t: performance.now(), hands, face: f, fps: 60, quality: QUALITY, video: { width: 1280, height: 720 } };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function drive(make: () => TrackingFrame, ms: number): Promise<number> {
  const end = performance.now() + ms;
  let peak = 0;
  while (performance.now() < end) {
    engine.update(make());
    peak = Math.max(peak, engine.level());
    await sleep(16);
  }
  return peak;
}

function laneY(i: number, voice: 'lead' | 'bass' = 'lead'): number {
  const lanes = engine.lanes(voice);
  return lanes[Math.max(0, Math.min(lanes.length - 1, i))]!.y;
}

/** Plays notes: [lane, ms on, ms off] with the right hand (and the left hand for bass lanes). */
async function phrase(notes: Array<[number, number, number]>, bassLane: number | null = null): Promise<void> {
  for (const [lane, on, off] of notes) {
    const hs = (withLead: boolean) => {
      const list: HandState[] = [];
      if (bassLane !== null) list.push(hand(1, 'left', 0.25, laneY(bassLane, 'bass')));
      if (withLead) list.push(hand(0, 'right', 0.75, laneY(lane)));
      return list;
    };
    await drive(() => frame(hs(true)), on);
    if (off) await drive(() => frame(hs(false)), off);
  }
}

function configure(patch: Partial<Settings>): void {
  settings = { ...settings, ...patch };
  engine.configure(settings);
}

function loop(cmd: LoopCommand): string {
  return engine.loop(cmd);
}

async function until(cond: () => boolean, timeoutMs: number, idle: () => TrackingFrame = () => frame([])): Promise<boolean> {
  const end = performance.now() + timeoutMs;
  while (performance.now() < end) {
    if (cond()) return true;
    engine.update(idle());
    await sleep(16);
  }
  return cond();
}

function waitLoaded(id: string): Promise<boolean> {
  return new Promise((resolve) => {
    let unsub: (() => void) | null = null;
    const to = window.setTimeout(() => resolve(false), 20000);
    unsub = engine.onLoadState((s) => {
      if (s.id === id && !s.loading && s.progress >= 1) {
        window.clearTimeout(to);
        queueMicrotask(() => unsub?.());
        resolve(true);
      }
    });
  });
}

const r3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * For each loop-player note in `ps`, how far its start is (in ms) from where the Transport says
 * that note belongs: (tick - origin) mod loop length must equal the recorded event tick.
 */
function transportError(ps: PlayLog[]): { n: number; maxMs: number } {
  const L = dbg.looperImpl;
  const tr = dbg.ctx.transport;
  const loopTicks = tr.PPQ * 4 * settings.loopBars;
  const msPerTick = (60_000 / tr.bpm.value) / tr.PPQ;
  let maxMs = 0;
  let n = 0;
  for (const p of ps) {
    const track = trackOf(p.player);
    if (track < 0 || L.origin === null) continue;
    const rel = (((tr.getTicksAtTime(p.t) - L.origin) % loopTicks) + loopTicks) % loopTicks;
    let best = Infinity;
    for (const e of L.tracks[track]!.events) {
      if (e.midi !== p.midi || e.inst !== p.inst) continue;
      const d = Math.min(Math.abs(e.tick - rel), loopTicks - Math.abs(e.tick - rel));
      best = Math.min(best, d);
    }
    if (best === Infinity) continue;
    n++;
    maxMs = Math.max(maxMs, best * msPerTick);
  }
  return { n, maxMs: r3(maxMs) };
}

/** Each live note must come back one loop later (plus at most the gentle quantize shift). */
function performanceError(liveNotes: typeof live, ps: PlayLog[], loopSec: number): { matched: number; of: number; maxMs: number } {
  let matched = 0;
  let maxMs = 0;
  for (const l of liveNotes) {
    let best = Infinity;
    for (const p of ps) {
      if (p.midi !== l.midi || p.inst !== l.inst) continue;
      const k = Math.round((p.t - l.t) / loopSec);
      if (k < 1) continue;
      best = Math.min(best, Math.abs(p.t - l.t - k * loopSec));
    }
    if (best < 0.2) {
      matched++;
      maxMs = Math.max(maxMs, best * 1000);
    }
  }
  return { matched, of: liveNotes.length, maxMs: r3(maxMs) };
}

function startsBy(ps: PlayLog[]): number[] {
  const c = [0, 0, 0, 0];
  for (const p of ps) {
    const t = trackOf(p.player);
    if (t >= 0) c[t]!++;
  }
  return c;
}

/** Plays (idle hands) for `ms` and returns the loop-player starts in that window. */
async function listen(ms: number): Promise<PlayLog[]> {
  const from = plays.length;
  await drive(() => frame([]), ms);
  return plays.slice(from);
}

/** Records a take on `track` with `perform` and waits until the looper is playing again. */
async function take(track: number, perform: () => Promise<void>): Promise<{ label: string; countIn: number[]; live: typeof live; notes: number }> {
  const label = loop({ type: 'record', track });
  const counts: number[] = [];
  await until(() => {
    const st = engine.looper();
    if (st.phase === 'count-in' && !counts.includes(st.countIn)) counts.push(st.countIn);
    return st.phase === 'recording';
  }, 8000);
  const from = live.length;
  await perform();
  await until(() => engine.looper().phase !== 'recording', 12000);
  return { label, countIn: counts, live: live.slice(from), notes: engine.looper().tracks[track]!.notes };
}

// ---------------------------------------------------------------------------------------------
// Looper self-test
// ---------------------------------------------------------------------------------------------

type Report = Record<string, unknown>;

async function looperSelfTest(): Promise<Report> {
  const report: Report = {};
  const errors: string[] = [];
  window.addEventListener('error', (e) => errors.push(String(e.message)));
  window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
  await engine.unlock();
  instrumentSpies();
  settings = { ...settings, trigger: 'always', leftHand: 'off', groove: false, reverb: 0, tempo: 120, loopBars: 1, lead: 'grand-piano', bass: 'electric-bass', scale: 'major', key: 0 };
  engine.configure(settings);
  engine.setPlayZone({ y0: 0.1, y1: 0.86 });
  await waitLoaded('grand-piano');
  const loopSec = 2; // 1 bar at 120 BPM

  // 1. Track 1 from silence: count-in 4..1, then a 4-note piano phrase, auto-stop after one loop.
  {
    const r = await take(0, () => phrase([[2, 220, 280], [4, 220, 280], [6, 220, 280], [8, 300, 0]]));
    const pass = await listen(loopSec * 1000 * 2);
    const tErr = transportError(pass);
    const pErr = performanceError(r.live, pass, loopSec);
    report.track1 = { label: r.label, countIn: r.countIn, notes: r.notes, phase: engine.looper().phase, starts: pass.length, transport: tErr, performance: pErr, origin: dbg.looperImpl.origin, ok: r.countIn.join() === '4,3,2,1' && r.notes >= 4 && pass.length >= 8 && tErr.maxMs < 2 && pErr.matched === r.live.length && pErr.maxMs <= 32 };
  }

  // 2. Track 2: the bass voice (left hand) while track 1 plays: no count-in, recording starts at once.
  {
    // Pinch trigger: the right hand rests (no pinch), the left hand pinches the bass notes.
    configure({ leftHand: 'bass', trigger: 'pinch' });
    await waitLoaded('electric-bass');
    const both = (lane: number, pinch: boolean) => frame([{ ...hand(1, 'left', 0.25, laneY(lane, 'bass')), pinching: pinch, pinch: pinch ? 1 : 0 }, hand(0, 'right', 0.75, 0.5)]);
    const r = await take(1, async () => {
      for (const lane of [0, 3, 1, 4]) {
        await drive(() => both(lane, true), 230);
        await drive(() => both(lane, false), 260);
      }
    });
    configure({ leftHand: 'off', trigger: 'always' });
    const pass = await listen(loopSec * 1000 * 2);
    const by = startsBy(pass);
    const pErr = performanceError(r.live, pass, loopSec);
    const insts2 = engine.looper().tracks[1]!.instruments;
    report.track2 = { label: r.label, countIn: r.countIn, notes: r.notes, insts: insts2, startsByTrack: by, transport: transportError(pass), performance: pErr, ok: insts2.join() === 'electric-bass' && r.countIn.length === 0 && r.notes >= 4 && by[0]! >= 8 && by[1]! >= 8 && pErr.matched === r.live.length && pErr.maxMs <= 32 };
  }

  // 3. Track 3: a synth, then change the live instrument: recorded tracks keep theirs.
  {
    configure({ lead: 'pluck' });
    const r = await take(2, () => phrase([[10, 150, 100], [9, 150, 100], [7, 150, 100], [5, 150, 400]]));
    configure({ lead: 'violin' });
    await waitLoaded('violin');
    const pass = await listen(loopSec * 1000 * 2);
    const insts = [...new Set(pass.map((p) => `${trackOf(p.player)}:${p.inst}`))].sort();
    report.track3 = { notes: r.notes, playedInstruments: insts, transport: transportError(pass), performance: performanceError(r.live, pass, loopSec), ok: r.notes >= 4 && insts.includes('0:grand-piano') && insts.includes('1:electric-bass') && insts.includes('2:pluck') && !insts.some((x) => x.endsWith('violin')) };
  }

  // 4. Track 4 with the hands-free path (next free track) and a sustained instrument.
  {
    const label = loop({ type: 'record' });
    const st = { recordTrack: engine.looper().recordTrack };
    await until(() => engine.looper().phase === 'recording', 4000);
    await phrase([[3, 500, 200], [6, 600, 200]]);
    await until(() => engine.looper().phase !== 'recording', 6000);
    const pass = await listen(loopSec * 1000 * 2);
    const by = startsBy(pass);
    report.track4 = { label, armed: st.recordTrack, notes: engine.looper().tracks[3]!.notes, startsByTrack: by, transport: transportError(pass), full: loop({ type: 'record' }), ok: label.startsWith('Loop 4') && by.every((n) => n >= 2) };
    loop({ type: 'stop' });
  }

  // 5. In time with the Transport across a tempo change.
  {
    configure({ tempo: 100 });
    const pass = await listen(2400 * 2);
    const tErr = transportError(pass);
    report.tempoChange = { starts: pass.length, transport: tErr, ok: pass.length > 10 && tErr.maxMs < 2 };
    configure({ tempo: 120 });
  }

  // 6. Mute / solo.
  {
    loop({ type: 'mute', track: 0 });
    const muted = startsBy(await listen(loopSec * 1000 * 1.5));
    loop({ type: 'mute', track: 0 });
    loop({ type: 'solo', track: 1 });
    const solo = startsBy(await listen(loopSec * 1000 * 1.5));
    loop({ type: 'solo', track: 1 });
    const back = startsBy(await listen(loopSec * 1000 * 1.5));
    report.muteSolo = { muted, solo, back, ok: muted[0] === 0 && muted[1]! > 0 && solo[1]! > 0 && solo[0]! + solo[2]! + solo[3]! === 0 && back.every((n) => n > 0) };
  }

  // 7. Overdub + undo, clear + undo.
  {
    const before = engine.looper().tracks[0]!.notes;
    configure({ lead: 'grand-piano' });
    await take(0, () => phrase([[12, 150, 120], [13, 150, 120]]));
    const after = engine.looper().tracks[0]!.notes;
    const undo1 = loop({ type: 'undo' });
    const undone = engine.looper().tracks[0]!.notes;
    const clear = loop({ type: 'clear', track: 2 });
    const cleared = startsBy(await listen(loopSec * 1000 * 1.5));
    const undo2 = loop({ type: 'undo' });
    const restored = startsBy(await listen(loopSec * 1000 * 1.5));
    report.overdubUndo = { before, after, undo1, undone, clear, clearedStarts: cleared, undo2, restoredStarts: restored, ok: after > before && undone === before && cleared[2] === 0 && restored[2]! > 0 };
  }

  // 8. Stop mid-take with a note held, then clear all: no stuck notes, players released.
  {
    loop({ type: 'record', track: 1 });
    await until(() => engine.looper().phase === 'recording', 3000);
    configure({ lead: 'opera-choir' });
    await waitLoaded('opera-choir');
    await drive(() => frame([hand(0, 'right', 0.75, laneY(5))]), 400);
    const stopLabel = loop({ type: 'stop' });
    await drive(() => frame([]), 300);
    const pendingAfterStop = dbg.looperImpl.pending.size;
    loop({ type: 'clear-all' });
    await drive(() => frame([]), 1800);
    const level = engine.level();
    report.noStuckNotes = { stopLabel, pendingAfterStop, sounding: dbg.looperImpl.soundingCount, list: dbg.looperImpl.sounding.length, level: r3(level), phase: engine.looper().phase, transport: dbg.ctx.transport.state, ok: pendingAfterStop === 0 && dbg.looperImpl.soundingCount === 0 && level < 0.003 && engine.looper().phase === 'idle' };
    const undo = loop({ type: 'undo' });
    report.undoClearAll = { undo, notes: engine.looper().tracks.map((t) => t.notes) };
  }

  // 9. Groove + loops in sync: loop start on a bar line, beat and loop share the grid.
  {
    configure({ groove: true, beat: 'pop' });
    await drive(() => frame([]), 1500);
    const origin = dbg.looperImpl.origin;
    const bar = dbg.ctx.transport.PPQ * 4;
    const m = engine.metrics();
    report.grooveSync = { origin, barAligned: origin !== null && origin % bar === 0, bar: m.bar, beat: m.beat, ok: origin !== null && origin % bar === 0 && m.bar >= 1 };
    configure({ groove: false });
  }

  // 10. Memory: four tracks looping (1 bar at 160 BPM) for 200 loops. Heap after GC at loops 10,
  //     50, 150 and 200, plus the automation events Tone keeps for the loop players' params: they
  //     fill up to Tone's cap (1000 per param) during the first passes and then the heap is flat.
  {
    configure({ tempo: 160, lead: 'grand-piano' });
    logging = false;
    plays.length = 0;
    live.length = 0;
    const gc = (window as unknown as { gc?: () => void }).gc;
    const heap = () => (performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0;
    /** Sum of Tone automation timeline lengths reachable from the loop players. */
    const toneEvents = (): number => {
      const seen = new Set<object>();
      let n = 0;
      const walk = (o: unknown, depth: number): void => {
        if (!o || typeof o !== 'object' || seen.has(o) || depth > 7 || o instanceof AudioNode || o instanceof AudioParam || o instanceof BaseAudioContext) return;
        seen.add(o);
        const ev = (o as { _events?: { length?: number } })._events;
        if (ev && typeof ev.length === 'number') n += ev.length;
        for (const k of Object.keys(o)) {
          if (k === 'context' || k === '_context' || k === 'output' && depth > 2) continue;
          walk((o as Record<string, unknown>)[k], depth + 1);
        }
      };
      for (const p of dbg.looperImpl.players.values()) walk(p, 0);
      return n;
    };
    const sec = 1.5;
    const players0 = dbg.looperImpl.players.size;
    let maxSounding = 0;
    const marks: number[] = [];
    const events: number[] = [];
    for (let loops = 1; loops <= 200; loops++) {
      const end = performance.now() + sec * 1000;
      while (performance.now() < end) {
        engine.update(frame([]));
        engine.looper();
        engine.metrics();
        maxSounding = Math.max(maxSounding, dbg.looperImpl.sounding.length);
        await sleep(16);
      }
      if (loops === 10 || loops === 50 || loops === 150 || loops === 200) {
        gc?.();
        await sleep(200);
        gc?.();
        marks.push(heap());
        events.push(toneEvents());
      }
    }
    logging = true;
    const kb = (n: number) => Math.round(n / 1024);
    const tail = marks[3]! - marks[2]!;
    report.memory = {
      loops: 200,
      atLoops: [10, 50, 150, 200],
      heapMB: marks.map((m) => r3(m / 1048576)),
      toneAutomationEvents: events,
      growth150to200KB: kb(tail),
      players0,
      players1: dbg.looperImpl.players.size,
      maxSounding,
      undo: dbg.looperImpl.undoStack.length,
      ok: tail < 128 * 1024 && dbg.looperImpl.players.size === players0 && maxSounding <= 48,
    };
  }

  // 11. Panic (tab hidden) keeps loops but silences them; the clock comes back with them.
  {
    engine.panic();
    await drive(() => frame([]), 1500); // the echo tail dies out
    const silent = engine.level() < 0.003 && dbg.looperImpl.soundingCount === 0;
    engine.configure(settings);
    const pass = await listen(1500 * 2);
    report.panic = { silent, startsAfter: startsBy(pass), ok: silent && startsBy(pass).every((n) => n > 0) };
    loop({ type: 'clear-all' });
    await drive(() => frame([]), 1500);
  }

  report.errors = errors;
  const okKeys = Object.entries(report).filter(([, v]) => v && typeof v === 'object' && 'ok' in (v as Report));
  report.summary = okKeys.map(([k, v]) => `${k}:${(v as Report).ok ? 'ok' : 'FAIL'}`).join(' ');
  return report;
}

// ---------------------------------------------------------------------------------------------
// MIDI self-test (mocked outputs)
// ---------------------------------------------------------------------------------------------

const hex = (d: number[]) => d.map((b) => b.toString(16).padStart(2, '0')).join(' ');

async function midiSelfTest(): Promise<Report> {
  const report: Report = {};
  await engine.unlock();
  settings = { ...settings, trigger: 'always', leftHand: 'off', groove: false, lead: 'theremin', bass: 'sub-bass', midiOut: '', midiChannel: 3, midiOnly: false };
  engine.configure(settings);
  engine.setPlayZone({ y0: 0.1, y1: 0.86 });

  report.before = { supported: engine.midiStatus().supported, enabled: engine.midiStatus().enabled, requests: midiRequests };
  const statuses: number[] = [];
  engine.onMidiStatus((s) => statuses.push(s.outputs.length));
  const st = await engine.enableMidi();
  report.enable = { enabled: st.enabled, outputs: st.outputs, requests: midiRequests, ok: st.enabled && st.outputs.length === 2 };

  // Off: nothing is sent.
  sent.length = 0;
  await phrase([[3, 300, 200]]);
  report.offSendsNothing = { sent: sent.length, ok: sent.length === 0 };

  // Lead on channel 3, velocity from the mouth (sustained synth): wide mouth -> louder note-on.
  configure({ midiOut: 'out-1', trigger: 'mouth' });
  sent.length = 0;
  await drive(() => frame([hand(0, 'right', 0.75, laneY(4))], face(0)), 200);
  await drive(() => frame([hand(0, 'right', 0.75, laneY(4))], face(0.3)), 300);
  await drive(() => frame([hand(0, 'right', 0.75, laneY(4))], face(0)), 300);
  await drive(() => frame([hand(0, 'right', 0.75, laneY(4))], face(0.95)), 300);
  await drive(() => frame([hand(0, 'right', 0.75, laneY(4))], face(0)), 300);
  const ons = sent.filter((m) => (m.data[0]! & 0xf0) === 0x90 && m.data[2]! > 0);
  const offs = sent.filter((m) => (m.data[0]! & 0xf0) === 0x80);
  const cc11 = sent.filter((m) => m.data[0] === 0xb2 && m.data[1] === 11);
  report.leadNotes = {
    ons: ons.map((m) => hex(m.data)),
    offs: offs.map((m) => hex(m.data)),
    cc11: cc11.length,
    cc11Range: cc11.length ? [Math.min(...cc11.map((m) => m.data[2]!)), Math.max(...cc11.map((m) => m.data[2]!))] : [],
    ok: ons.length === 2 && ons.every((m) => m.data[0] === 0x92) && ons[1]!.data[2]! > ons[0]!.data[2]! && offs.length === 2 && cc11.length > 3,
  };

  // Bass voice on the next channel (4), both hands.
  configure({ trigger: 'always', leftHand: 'bass' });
  sent.length = 0;
  await phrase([[6, 300, 200]], 2);
  await drive(() => frame([]), 200);
  const ch = new Set(sent.filter((m) => (m.data[0]! & 0xf0) === 0x90).map((m) => m.data[0]! & 0x0f));
  report.bassChannel = { channels: [...ch].map((c) => c + 1).sort(), ok: ch.has(2) && ch.has(3) };

  // Note-ons and note-offs balance (no hanging notes on the device) across a chord phrase.
  configure({ leftHand: 'chords', bass: 'warm-pad' });
  sent.length = 0;
  const L = (fingers: HandState['fingers']) => ({ ...hand(1, 'left', 0.25, 0.5), fingers, fingersUp: fingers.filter(Boolean).length });
  for (const f of [[false, true, false, false, false], [false, true, true, true, true], [true, true, true, true, true]] as HandState['fingers'][]) {
    await drive(() => frame([L(f), hand(0, 'right', 0.75, laneY(5))]), 400);
  }
  await drive(() => frame([]), 400);
  const bal = new Map<string, number>();
  for (const m of sent) {
    const type = m.data[0]! & 0xf0;
    const k = `${m.data[0]! & 0x0f}:${m.data[1]}`;
    if (type === 0x90 && m.data[2]! > 0) bal.set(k, (bal.get(k) ?? 0) + 1);
    if (type === 0x80) bal.set(k, (bal.get(k) ?? 0) - 1);
  }
  const hanging = [...bal.entries()].filter(([, v]) => v > 0).map(([k]) => k);
  report.balanced = { messages: sent.length, hanging, ok: hanging.length === 0 && sent.length > 6 };

  // Instrument change and panic send "all notes off" (CC 123).
  configure({ leftHand: 'off' });
  sent.length = 0;
  await drive(() => frame([hand(0, 'right', 0.75, laneY(5))]), 200);
  configure({ lead: 'analog-lead' });
  const cc123a = sent.filter((m) => m.data[1] === 123 && (m.data[0]! & 0xf0) === 0xb0).map((m) => hex(m.data));
  await drive(() => frame([hand(0, 'right', 0.75, laneY(5))]), 200);
  sent.length = 0;
  engine.panic();
  const cc123b = sent.filter((m) => m.data[1] === 123 && (m.data[0]! & 0xf0) === 0xb0).map((m) => hex(m.data));
  const offAtPanic = sent.filter((m) => (m.data[0]! & 0xf0) === 0x80).length;
  report.allNotesOff = { onInstrumentChange: cc123a, onPanic: cc123b, noteOffsAtPanic: offAtPanic, ok: cc123a.includes('b2 7b 00') && cc123b.includes('b2 7b 00') && cc123b.includes('b3 7b 00') && offAtPanic >= 1 };

  // MIDI only: the live voices go quiet inside the browser.
  configure({ midiOnly: true });
  await drive(() => frame([]), 2500); // let the reverb tail of the previous step die out
  const quietPeak = await drive(() => frame([hand(0, 'right', 0.75, laneY(5))]), 600);
  const liveGainOn = r3(dbg.liveBus.gain.value);
  await drive(() => frame([]), 500);
  configure({ midiOnly: false });
  const loudPeak = await drive(() => frame([hand(0, 'right', 0.75, laneY(5))]), 600);
  await drive(() => frame([]), 500);
  report.midiOnly = { liveGainWhenOn: liveGainOn, quietPeak: r3(quietPeak), loudPeak: r3(loudPeak), ok: quietPeak < 0.01 && loudPeak > 0.02 };

  // Hot-plug: unplug the selected output, then plug it back in.
  configure({ midiOnly: true });
  const out1 = outputs.get('out-1')!;
  out1.state = 'disconnected';
  access.onstatechange?.({ port: out1 });
  const unplugged = engine.midiStatus();
  sent.length = 0;
  const fallbackPeak = await drive(() => frame([hand(0, 'right', 0.75, laneY(5))]), 600);
  await drive(() => frame([]), 400);
  const sentWhileGone = sent.length;
  out1.state = 'connected';
  access.onstatechange?.({ port: out1 });
  const replugged = engine.midiStatus();
  sent.length = 0;
  await drive(() => frame([hand(0, 'right', 0.75, laneY(5))]), 300);
  await drive(() => frame([]), 300);
  report.hotPlug = {
    unplugged: { connected: unplugged.connected, outputs: unplugged.outputs.length },
    internalSoundWhileUnplugged: r3(fallbackPeak),
    sentWhileGone,
    replugged: { connected: replugged.connected, outputs: replugged.outputs.length },
    sentAfterReplug: sent.length,
    statusEvents: statuses.length,
    ok: !unplugged.connected && unplugged.outputs.length === 1 && fallbackPeak > 0.02 && sentWhileGone === 0 && replugged.connected && sent.length > 0,
  };

  // Channel change releases the old channel; turning MIDI off releases everything.
  configure({ midiOnly: false });
  sent.length = 0;
  await drive(() => frame([hand(0, 'right', 0.75, laneY(5))]), 200);
  configure({ midiChannel: 10 });
  const offOld = sent.some((m) => m.data[0] === 0x82);
  await drive(() => frame([hand(0, 'right', 0.75, laneY(7))]), 200);
  const onNew = sent.some((m) => m.data[0] === 0x99);
  configure({ midiOut: '' });
  await drive(() => frame([]), 200);
  report.channelChange = { offOld, onNew, ok: offOld && onNew };

  const okKeys = Object.entries(report).filter(([, v]) => v && typeof v === 'object' && 'ok' in (v as Report));
  report.summary = okKeys.map(([k, v]) => `${k}:${(v as Report).ok ? 'ok' : 'FAIL'}`).join(' ');
  return report;
}

/** The WAV recorder hears the loops: record a loop, then record while only the loop plays. */
async function looperRecordCheck(): Promise<Report> {
  await engine.unlock();
  instrumentSpies();
  settings = { ...settings, trigger: 'always', leftHand: 'off', groove: false, reverb: 0, tempo: 120, loopBars: 1, lead: 'pluck' };
  engine.configure(settings);
  engine.setPlayZone({ y0: 0.1, y1: 0.86 });
  const t = await take(0, () => phrase([[3, 200, 250], [6, 200, 250], [9, 200, 250], [12, 200, 0]]));
  await drive(() => frame([]), 600);
  engine.startRecording();
  await drive(() => frame([]), 2500); // no hands: only the loop sounds
  const rec = await engine.stopRecording();
  const ctx = new AudioContext();
  const buf = await ctx.decodeAudioData(await rec.blob.arrayBuffer());
  void ctx.close();
  const x = buf.getChannelData(0);
  let e = 0;
  for (let i = 0; i < x.length; i++) e += x[i]! * x[i]!;
  const rms = Math.sqrt(e / Math.max(1, x.length));
  loop({ type: 'reset' });
  await drive(() => frame([]), 300);
  return { loopNotes: t.notes, size: rec.blob.size, ext: rec.extension, seconds: r3(buf.duration), rms: r3(rms), players: dbg.looperImpl.players.size, ok: t.notes >= 4 && rms > 0.003 && dbg.looperImpl.players.size === 0 };
}

declare global {
  interface Window {
    __looperSelfTest?: () => Promise<Report>;
    __midiSelfTest?: () => Promise<Report>;
    __looperRecordCheck?: () => Promise<Report>;
  }
}
window.__looperSelfTest = looperSelfTest;
window.__midiSelfTest = midiSelfTest;
window.__looperRecordCheck = looperRecordCheck;

const out = document.getElementById('out')!;
document.getElementById('looper')!.addEventListener('click', () => {
  out.textContent = 'running…';
  void looperSelfTest().then((r) => (out.textContent = JSON.stringify(r, null, 1)));
});
document.getElementById('midi')!.addEventListener('click', () => {
  out.textContent = 'running…';
  void midiSelfTest().then((r) => (out.textContent = JSON.stringify(r, null, 1)));
});



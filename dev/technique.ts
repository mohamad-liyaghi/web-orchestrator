/**
 * Playing-technique harness: pure checks of the technique module (guitar shapes, harmony,
 * arpeggio orders, walking bass, strum rhythms) and live checks on the real engine through a spy
 * on the players' note taps (strum order and timing, strum patterns on the grid, palm mute,
 * pedal, bass lines, arpeggiator rates, harmony, slides, looper capture, stuck notes).
 *
 *   node dev/music-check.mjs http://localhost:5194/dev/technique.html "window.__techniqueTest()"
 */
import { createMusicEngine } from '../src/music';
import { DEFAULT_SETTINGS } from '../src/settings';
import { degreeChord, arpIndex, walkingNote } from '../src/music/chords';
import { guitarShape, powerShape, harmonyNote, STRUM_RHYTHMS, RATE_UNITS, STRINGS } from '../src/music/technique';
import { chordName, mod12 } from '../src/music/theory';
import type { NoteTap, Player } from '../src/music/players';
import type { ArpPattern, BassPattern, FaceState, FrameQuality, HandState, NoteRate, Settings, StrumPattern, TrackingFrame } from '../src/types';

const engine = createMusicEngine();
let settings: Settings = { ...DEFAULT_SETTINGS, gestures: { ...DEFAULT_SETTINGS.gestures } };

// ---------------------------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------------------------

const QUALITY: FrameQuality = { score: 1, verdict: 'great', ideal: true, brightness: 0.5, handScale: 0.3 };
type Fingers = HandState['fingers'];
const ONE: Fingers = [false, true, false, false, false];
const FOUR: Fingers = [false, true, true, true, true];
const FIVE: Fingers = [true, true, true, true, true];
const DEG: Record<number, Fingers> = {
  1: ONE,
  2: [false, true, true, false, false],
  3: [false, true, true, true, false],
  4: FOUR,
  5: FIVE,
  6: [false, true, false, false, true],
  7: [true, true, false, false, true],
};

function hand(id: number, side: 'left' | 'right', x: number, y = 0.45, fingers: Fingers = FIVE): HandState {
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
function frame(hands: HandState[], face: FaceState | null = null): TrackingFrame {
  return { t: performance.now(), hands, face, fps: 30, quality: QUALITY, video: { width: 1280, height: 720 } };
}
/** Chords mode: the left hand shows a degree. */
const chordFrame = (degree: number) => () => frame([hand(1, 'left', 0.25, 0.45, DEG[degree]!)]);
/** Melody mode: the right hand points at the lane of `midi`. */
function laneFrame(midi: number): () => TrackingFrame {
  const lane = engine.lanes('lead').find((l) => l.midi === midi);
  if (!lane) throw new Error(`no lane for ${midi}`);
  return () => frame([hand(0, 'right', 0.7, lane.y)]);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function drive(make: () => TrackingFrame, ms: number): Promise<number> {
  const end = performance.now() + ms;
  let peak = 0;
  engine.update(make());
  while (performance.now() < end) {
    engine.update(make());
    peak = Math.max(peak, engine.level());
    await sleep(33);
  }
  return peak;
}
async function quiet(ms = 1500): Promise<{ ok: boolean; level: number; active: number }> {
  await drive(() => frame([]), ms);
  const level = engine.level();
  const active = engine.metrics().activeMidi.length;
  return { ok: level < 0.003 && active === 0, level: Number(level.toFixed(5)), active };
}

function waitLoaded(id: string, timeoutMs = 20000): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    let unsub: (() => void) | null = null;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      queueMicrotask(() => unsub?.());
      resolve(ok);
    };
    unsub = engine.onLoadState((s) => {
      if (s.id !== id) return;
      if (s.error) finish(false);
      else if (!s.loading && s.progress >= 1) finish(true);
    });
    window.setTimeout(() => finish(false), timeoutMs);
  });
}
async function set(patch: Partial<Settings>): Promise<void> {
  const ids = [patch.lead, patch.bass].filter((x): x is string => !!x);
  const waits = ids.map((id) => waitLoaded(id));
  settings = { ...settings, ...patch };
  engine.configure(settings);
  await Promise.all(waits);
  attachSpies();
}

// ---------------------------------------------------------------------------------------------
// Tap spy
// ---------------------------------------------------------------------------------------------

interface Ev {
  voice: string;
  kind: 'on' | 'off' | 'cancel' | 'glide';
  handle: number;
  midi: number;
  vel: number;
  time: number;
}
let log: Ev[] = [];
interface VoiceInternal {
  id: string;
  player: Player | null;
  part: { origin: number };
}
interface EngineInternal {
  tapFor(v: VoiceInternal): NoteTap;
  lead: VoiceInternal;
  bass: VoiceInternal;
  ctx: { currentTime: number; transport: { PPQ: number; getTicksAtTime(t: number): number } } | null;
}
const eng = engine as unknown as EngineInternal;
const origTapFor = eng.tapFor.bind(eng);
const spied = new WeakSet<NoteTap>();
eng.tapFor = (v) => {
  const t = origTapFor(v);
  const spy: NoteTap = {
    on: (p, h, m, vel, time) => {
      log.push({ voice: v.id, kind: 'on', handle: h, midi: m, vel, time });
      t.on(p, h, m, vel, time);
    },
    glide: (p, h, m, time) => {
      log.push({ voice: v.id, kind: 'glide', handle: h, midi: m, vel: 0, time });
      t.glide(p, h, m, time);
    },
    off: (p, h, time) => {
      log.push({ voice: v.id, kind: 'off', handle: h, midi: 0, vel: 0, time });
      t.off(p, h, time);
    },
    cancel: (p, h, time) => {
      log.push({ voice: v.id, kind: 'cancel', handle: h, midi: 0, vel: 0, time });
      t.cancel(p, h, time);
    },
  };
  spied.add(spy);
  return spy;
};
function attachSpies(): void {
  for (const v of [eng.lead, eng.bass]) if (v.player && (!v.player.tap || !spied.has(v.player.tap))) v.player.tap = eng.tapFor(v);
}
const ons = (voice: string, from = 0) => log.filter((e) => e.voice === voice && e.kind === 'on' && e.time >= from);
const r3 = (x: number) => Math.round(x * 1000) / 1000;

/** Groups note-ons into strokes (a new stroke after a 60 ms gap). */
function strokes(evs: Ev[]): { t: number; midis: number[]; dir: 'down' | 'up' | 'one'; gaps: number[]; vels: number[] }[] {
  const out: { t: number; midis: number[]; dir: 'down' | 'up' | 'one'; gaps: number[]; vels: number[] }[] = [];
  for (const e of evs) {
    const last = out[out.length - 1];
    if (last && e.time - (last.t + last.gaps.reduce((a, b) => a + b, 0)) < 0.06) {
      last.gaps.push(r3(e.time - (last.t + last.gaps.reduce((a, b) => a + b, 0))));
      last.midis.push(e.midi);
      last.vels.push(Number(e.vel.toFixed(3)));
    } else out.push({ t: e.time, midis: [e.midi], dir: 'one', gaps: [], vels: [Number(e.vel.toFixed(3))] });
  }
  for (const s of out) {
    if (s.midis.length < 2) continue;
    const asc = s.midis.every((m, i) => i === 0 || m > s.midis[i - 1]!);
    const desc = s.midis.every((m, i) => i === 0 || m < s.midis[i - 1]!);
    s.dir = asc ? 'down' : desc ? 'up' : 'one';
  }
  return out;
}

/** 8th slot in the part's bar for an audio time. */
function slotOf(time: number, voice: VoiceInternal): number {
  const t = eng.ctx!.transport;
  const step = t.getTicksAtTime(time) / (t.PPQ / 4) - voice.part.origin;
  return step / 2;
}

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

type Report = Record<string, unknown>;

function pureChecks(report: Report): void {
  // Guitar shapes for the 7 diatonic chords (triads and sevenths) in several keys.
  const keys: [number, Settings['scale']][] = [
    [0, 'major'],
    [7, 'major'],
    [2, 'major'],
    [9, 'major'],
    [4, 'major'],
    [5, 'major'],
    [10, 'major'],
    [9, 'minor'],
    [4, 'minor'],
  ];
  const problems: string[] = [];
  const table: Record<string, string> = {};
  let checked = 0;
  for (const [key, scale] of keys) {
    const row: string[] = [];
    for (let d = 0; d < 7; d++) {
      for (const style of ['triad', 'seventh', 'sus4', 'add9'] as const) {
        const chord = degreeChord(key, scale, d, style, false);
        const shape = guitarShape(chord);
        const name = chordName(chord, false);
        checked++;
        if (!shape) {
          problems.push(`${name}: no shape`);
          continue;
        }
        // Every chord tone sounds, nothing else; like real players' shapes (C7 = x32310) the
        // perfect fifth may be left out of a four-note chord.
        const want = new Set(chord.type.intervals.map((i) => mod12(chord.root + i)));
        const got = new Set(shape.notes.map(mod12));
        const fifth = mod12(chord.root + 7);
        const same = [...got].every((p) => want.has(p)) && [...want].every((p) => got.has(p) || (p === fifth && want.size >= 4));
        const ordered = shape.notes.every((n, i) => i === 0 || n > shape.notes[i - 1]!);
        const playable = shape.frets.every((f) => f <= 17) && shape.notes.length >= 3 && shape.notes.length <= 6;
        const root = mod12(shape.notes[0]!) === chord.root || shape.kind === 'open';
        if (!same || !ordered || !playable) problems.push(`${name} ${shape.frets.join('')} notes ${shape.notes.join(',')}`);
        if (!root && shape.kind !== 'open') problems.push(`${name}: barre without root in the bass`);
        if (style === 'triad') row.push(`${name}=${shape.frets.map((f) => (f < 0 ? 'x' : f.toString(16))).join('')}(${shape.kind})`);
      }
    }
    table[`${key}:${scale}`] = row.join(' ');
  }
  const openWanted = ['C', 'D', 'E', 'G', 'A', 'Am', 'Dm', 'Em'];
  const openOk = openWanted.every((n) => {
    const root = ['C', '', 'D', '', 'E', '', '', 'G', '', 'A'].indexOf(n[0]!);
    const chord = { root, type: n.endsWith('m') ? degreeChord(9, 'minor', 0, 'triad', false).type : degreeChord(0, 'major', 0, 'triad', false).type };
    return guitarShape(chord)?.kind === 'open';
  });
  const p = powerShape(0);
  report.guitarShapes = { checked, problems, openShapesForCDEGAAmDmEm: openOk, power_C: p.notes, strings: STRINGS, triadsByKey: table, ok: problems.length === 0 && openOk && p.notes.length === 3 };

  // Harmony.
  const h = (m: number, k: Parameters<typeof harmonyNote>[1], key = 0, scale: Settings['scale'] = 'major') => harmonyNote(m, k, key, scale);
  const cases: [string, number | null, number][] = [
    ['C4 3rd above', h(60, 'third-above'), 64],
    ['D4 3rd above (minor 3rd)', h(62, 'third-above'), 65],
    ['B4 3rd above', h(71, 'third-above'), 74],
    ['E4 6th below', h(64, 'sixth-below'), 55],
    ['C4 6th below', h(60, 'sixth-below'), 52],
    ['B4 5th above (dim)', h(71, 'fifth-above'), 77],
    ['G4 5th above', h(67, 'fifth-above'), 74],
    ['C4 octave', h(60, 'octave'), 72],
    ['A4 3rd above in A minor', h(69, 'third-above', 9, 'minor'), 72],
    ['Eb4 (blues) 3rd above in C', h(63, 'third-above'), 67],
    ['F#4 (chromatic) 6th below in C', h(66, 'sixth-below'), 59],
  ];
  let inScale = true;
  for (let m = 48; m < 84; m++) {
    if (![0, 2, 4, 5, 7, 9, 11].includes(mod12(m))) continue;
    for (const k of ['third-above', 'sixth-below', 'fifth-above'] as const) {
      const x = h(m, k)!;
      if (![0, 2, 4, 5, 7, 9, 11].includes(mod12(x))) inScale = false;
    }
  }
  report.harmony = { cases: cases.map(([n, got, want]) => `${n}: ${got} ${got === want ? 'ok' : `WANT ${want}`}`), allDiatonicInScale: inScale, ok: inScale && cases.every(([, g, w]) => g === w) };

  // Arpeggio orders over 4 notes.
  const orders: Record<string, string> = {};
  for (const pat of ['up', 'down', 'up-down', 'random', 'broken', 'alberti'] as ArpPattern[]) {
    let last = -1;
    const seq: number[] = [];
    for (let k = 0; k < 12; k++) {
      last = arpIndex(pat, k, 4, last, 1234 + k);
      seq.push(last);
    }
    orders[pat] = seq.join('');
  }
  const randomNoRepeat = orders.random!.split('').every((c, i, a) => i === 0 || c !== a[i - 1]);
  report.arpOrders = { orders, randomNoRepeat, ok: orders.up === '012301230123' && orders.down === '321032103210' && orders['up-down'] === '012321012321' && orders.alberti === '032303230323' && randomNoRepeat };

  // Walking bass over C (C E G) and G7 in C major, two bars of 4/4.
  const walk = (root: number, third: number, fifth: number) =>
    [0, 1].map((bar) => [0, 1, 2, 3].map((b) => walkingNote(root, third, fifth, b, 4, bar, 0, 'major')).join(',')).join(' | ');
  report.walking = { C: walk(36, 4, 7), G: walk(43, 4, 7) };
  report.strumRhythms = STRUM_RHYTHMS;
}

async function liveChecks(report: Report): Promise<void> {
  await engine.unlock();
  settings = {
    ...DEFAULT_SETTINGS,
    gestures: { ...DEFAULT_SETTINGS.gestures },
    mode: 'chords',
    trigger: 'always',
    leftHand: 'off',
    groove: false,
    tempo: 120,
    key: 0,
    scale: 'major',
    reverb: 0,
    humanize: 0,
    playStyle: 'auto',
    chordPlay: 'block',
    bassPattern: 'root',
    tiltControls: false,
  };
  engine.configure(settings);
  engine.setPlayZone({ y0: 0.1, y1: 0.86 });
  await set({ lead: 'acoustic-guitar', bass: 'electric-bass' });
  await quiet(600);

  // 1. One guitar strum: real C shape, string by string low -> high.
  {
    log = [];
    const peak = await drive(chordFrame(1), 700);
    const st = strokes(ons('lead'));
    const m = engine.metrics();
    const first = st[0];
    report.guitarStrike = {
      chord: m.chord,
      notes: first?.midis,
      dir: first?.dir,
      gapsMs: first?.gaps.map((g) => Math.round(g * 1000)),
      velocities: first?.vels,
      strokes: st.length,
      peak: r3(peak),
      ok: first?.midis.join(',') === '48,52,55,60,64' && first.dir === 'down' && first.gaps.every((g) => g >= 0.007 && g <= 0.031) && st.length === 1 && peak > 0.01,
    };
    await quiet(800);
  }

  // 2. Strum patterns in time (no beat running: the Transport still keeps time).
  {
    await set({ chordPlay: 'strum' });
    const res: Report = {};
    let allOk = true;
    for (const pattern of ['single', 'down-up', 'folk', 'pop', 'reggae', 'ballad'] as StrumPattern[]) {
      await set({ strumPattern: pattern });
      await quiet(300);
      log = [];
      const peak = await drive(chordFrame(1), 4300);
      const st = strokes(ons('lead'));
      // Skip the immediate strike on the chord change: the grid strokes follow the pattern.
      const grid = st.slice(1);
      const slots = grid.map((s) => slotOf(s.t, eng.lead));
      const onGrid = slots.every((x) => Math.abs(x - Math.round(x)) < 0.03);
      const bar = '........'.split('');
      for (let i = 0; i < grid.length; i++) {
        const sl = ((Math.round(slots[i]!) % 8) + 8) % 8;
        const s = grid[i]!;
        bar[sl] = s.dir === 'up' ? 'U' : pattern === 'reggae' ? 'x' : 'D';
      }
      const want = STRUM_RHYTHMS[pattern].replace(/U/g, 'U');
      const upStrings = grid.filter((s) => s.dir === 'up').map((s) => s.midis.length);
      const ok = onGrid && bar.join('') === want && peak > 0.01;
      allOk &&= ok;
      res[pattern] = { observedBar: bar.join(''), want, strokes: st.length, onGrid, upStrumStrings: [...new Set(upStrings)], peak: r3(peak), ok };
    }
    report.strumPatterns = { ...res, ok: allOk };
    await quiet(600);
  }

  // 3. Palm mute: short damped strums.
  {
    await set({ strumPattern: 'down-up', palmMute: true });
    log = [];
    await drive(chordFrame(1), 1500);
    const on = ons('lead');
    const lens = on.map((e) => {
      const off = log.find((x) => x.kind === 'off' && x.handle === e.handle);
      return off ? off.time - e.time : Infinity;
    });
    const maxLen = Math.max(...lens);
    report.palmMute = { notes: on.length, longestNoteMs: Math.round(maxLen * 1000), downStrings: strokes(on).filter((s) => s.dir === 'down').map((s) => s.midis.length)[1], ok: on.length > 10 && maxLen < 0.25 };
    await set({ palmMute: false });
    await quiet(600);
  }

  // 4. Chord change mid-bar keeps the rhythm, nothing of the old chord sounds after it.
  {
    await set({ strumPattern: 'down-up' });
    log = [];
    await drive(chordFrame(1), 1630);
    const changeAt = eng.ctx!.currentTime;
    await drive(chordFrame(4), 1500);
    const withdrawn = new Set(log.filter((e) => e.kind === 'cancel').map((e) => e.handle));
    // The new chord is picked after the 120 ms debounce; withdrawn notes never sounded.
    const after = ons('lead', changeAt + 0.2).filter((e) => !withdrawn.has(e.handle));
    const fShape = new Set(after.map((e) => mod12(e.midi)));
    const st = strokes(ons('lead')).slice(1);
    const slots = st.map((s) => slotOf(s.t, eng.lead));
    const onGrid = slots.filter((_x, i) => i > 0 && Math.abs(st[i]!.t - changeAt) > 0.08).every((x) => Math.abs(x - Math.round(x)) < 0.03);
    report.chordChange = {
      chord: engine.metrics().chord,
      pitchClassesAfterChange: [...fShape].sort((a, b) => a - b),
      cancelled: log.filter((e) => e.kind === 'cancel').length,
      gridKept: onGrid,
      ok: onGrid && [...fShape].every((p) => [5, 9, 0].includes(p)) && engine.metrics().chord === 'F',
    };
    await quiet(800);
  }

  // 5. Distortion guitar: power chords, named as they sound.
  {
    await set({ lead: 'distortion-guitar', chordPlay: 'block' });
    log = [];
    await drive(chordFrame(5), 600);
    const m = engine.metrics();
    const notes = strokes(ons('lead'))[0]?.midis ?? [];
    report.powerChord = { chord: m.chord, roman: m.roman, notes, ok: m.chord === 'G5' && notes.length === 3 && notes[1]! - notes[0]! === 7 && notes[2]! - notes[0]! === 12 };
    await quiet(800);
  }

  // 6. Piano: rolled chords (5-10 ms) and legato pedalling at chord changes.
  {
    await set({ lead: 'grand-piano', chordPlay: 'block', sustainPedal: 'auto' });
    log = [];
    await drive(chordFrame(1), 600);
    const changeAt = eng.ctx!.currentTime;
    await drive(chordFrame(4), 600);
    const st = strokes(ons('lead'));
    const firstHandles = log.filter((e) => e.kind === 'on' && e.voice === 'lead' && e.time < changeAt).map((e) => e.handle);
    const offs = log.filter((e) => e.kind === 'off' && firstHandles.includes(e.handle));
    const newOn = ons('lead', changeAt)[0]!;
    const lift = offs.length ? r3(Math.min(...offs.map((o) => o.time)) - newOn.time) : null;
    await set({ sustainPedal: 'off' });
    log = [];
    await drive(chordFrame(1), 500);
    const at2 = eng.ctx!.currentTime;
    await drive(chordFrame(4), 500);
    const fh = log.filter((e) => e.kind === 'on' && e.voice === 'lead' && e.time < at2).map((e) => e.handle);
    const offs2 = log.filter((e) => e.kind === 'off' && fh.includes(e.handle));
    const lift2 = offs2.length ? r3(Math.min(...offs2.map((o) => o.time)) - ons('lead', at2)[0]!.time) : null;
    report.pianoChords = {
      rollGapsMs: st[0]?.gaps.map((g) => Math.round(g * 1000)),
      pedalAutoOldChordUpAfterNewMs: lift === null ? null : Math.round(lift * 1000),
      pedalOffOldChordUpAfterNewMs: lift2 === null ? null : Math.round(lift2 * 1000),
      ok: !!st[0] && st[0].gaps.every((g) => g >= 0.005 && g <= 0.01) && lift !== null && lift > 0.03 && lift < 0.06 && lift2 !== null && lift2 <= 0.001,
    };
    await set({ sustainPedal: 'auto' });
    await quiet(800);
  }

  // 7. Bass lines in time under a held chord (120 bpm: beat 0.5 s).
  {
    await set({ lead: 'warm-pad', bass: 'electric-bass', chordPlay: 'block' });
    const res: Report = {};
    let allOk = true;
    for (const pattern of ['root', 'root-fifth', 'octave', 'walking', 'off'] as BassPattern[]) {
      await set({ bassPattern: pattern });
      await quiet(300);
      log = [];
      await drive(chordFrame(1), 2700);
      const b = ons('bass');
      const iois = b.slice(2).map((e, i) => r3(e.time - b[i + 1]!.time));
      const notes = b.map((e) => e.midi);
      const gate = engine.update(chordFrame(1)())[1]!.gate;
      let ok: boolean;
      switch (pattern) {
        case 'root':
          ok = notes.length === 1 && notes[0] === 36;
          break;
        case 'root-fifth':
          ok = iois.every((x) => Math.abs(x - 0.5) < 0.01) && notes.slice(1).every((m) => m === 36 || m === 31) && notes.includes(31);
          break;
        case 'octave':
          ok = iois.every((x) => Math.abs(x - 0.25) < 0.01) && notes.includes(36) && notes.includes(48);
          break;
        case 'walking':
          ok = iois.every((x) => Math.abs(x - 0.5) < 0.01) && new Set(notes).size >= 3;
          break;
        default:
          ok = notes.length === 0 && !gate;
      }
      allOk &&= ok;
      res[pattern] = { notes: notes.join(','), interOnsetS: [...new Set(iois)], bassGate: gate, ok };
    }
    report.bassPatterns = { ...res, ok: allOk };
    await set({ bassPattern: 'root' });
    await quiet(600);
  }

  // 8. Arpeggiator rates (120 bpm) and octaves.
  {
    await set({ lead: 'marimba', chordPlay: 'arp', arpPattern: 'up' });
    const res: Report = {};
    let allOk = true;
    for (const rate of ['1/4', '1/8', '1/8t', '1/8d', '1/16', '1/16t'] as NoteRate[]) {
      await set({ arpRate: rate, arpOctaves: rate === '1/16' ? 2 : 1 });
      await quiet(300);
      log = [];
      await drive(chordFrame(1), 2200);
      const a = ons('lead');
      const iois = a.slice(2).map((e, i) => e.time - a[i + 1]!.time).sort((x, y) => x - y);
      const median = iois[Math.floor(iois.length / 2)] ?? 0;
      const want = (0.5 * RATE_UNITS[rate]) / 12;
      const span = Math.max(...a.map((e) => e.midi)) - Math.min(...a.map((e) => e.midi));
      const ok = Math.abs(median - want) < 0.006 && (rate !== '1/16' || span > 12);
      allOk &&= ok;
      res[rate] = { notes: a.length, medianIoiS: r3(median), wantS: r3(want), spanSemitones: span, ok };
    }
    report.arpRates = { ...res, ok: allOk };
    await set({ chordPlay: 'block', arpOctaves: 1, arpRate: '1/8' });
    await quiet(600);
  }

  // 9. Strings section: spread voicing, legato common tones.
  {
    await set({ lead: 'string-ensemble' });
    log = [];
    await drive(chordFrame(1), 600);
    const notes = ons('lead').map((e) => e.midi).sort((a, b) => a - b);
    report.stringsVoicing = { notes, span: notes[notes.length - 1]! - notes[0]!, ok: notes.length >= 5 && notes[notes.length - 1]! - notes[0]! >= 19 };
    await quiet(1000);
  }

  // 10. Melody: harmony, guitar slides, piano pedal.
  {
    await set({ mode: 'melody', lead: 'flute', harmony: 'third-above', span: 15, scale: 'major', key: 0 });
    await quiet(300);
    await drive(laneFrame(72), 500);
    const act = engine.metrics().activeMidi.slice();
    await set({ harmony: 'sixth-below' });
    await drive(() => frame([]), 300);
    await drive(laneFrame(76), 500);
    const act2 = engine.metrics().activeMidi.slice();
    report.harmonyLive = { thirdAboveOnC5: act, sixthBelowOnE5: act2, ok: act.join(',') === '72,76' && act2.join(',') === '67,76' };
    await set({ harmony: 'off' });
    await quiet(800);

    await set({ lead: 'acoustic-guitar' });
    await quiet(500);
    log = [];
    await drive(laneFrame(60), 400);
    await drive(laneFrame(62), 400); // a slow move: re-picked
    await drive(laneFrame(64), 90); // re-picked (62 rang 400 ms), then within 150 ms...
    await drive(laneFrame(65), 400); // ...a semitone up: slide / hammer-on, no fresh pick
    const v = ons('lead').map((e) => Number(e.vel.toFixed(3)));
    report.guitarSlides = { notes: ons('lead').map((e) => e.midi), velocities: v, ok: v.length === 4 && Math.abs(v[1]! - v[0]!) < 0.01 && Math.abs(v[2]! - v[0]!) < 0.01 && v[3]! < v[0]! * 0.7 };
    await quiet(1000);

    await set({ lead: 'grand-piano', sustainPedal: 'auto' });
    const pedal = async (mode: Settings['sustainPedal']) => {
      await set({ sustainPedal: mode });
      log = [];
      await drive(laneFrame(60), 350);
      await drive(laneFrame(64), 350);
      const atF = eng.ctx!.currentTime;
      await drive(laneFrame(65), 350);
      const before = eng.ctx!.currentTime;
      const handles = ons('lead').map((e) => e.handle);
      const offAt = (h: number | undefined) => log.find((e) => e.kind === 'off' && e.handle === h)?.time;
      const c = offAt(handles[0]);
      const e = offAt(handles[1]);
      const active = engine.metrics().activeMidi.slice();
      await quiet(1200);
      const allOff = handles.every((h) => log.some((x) => x.kind === 'off' && x.handle === h));
      return { cUpWhileHeld: c !== undefined && c < before, eUpAtF: e !== undefined && Math.abs(e - atF) < 0.1, activeOnF: active, allOffAfterGate: allOff };
    };
    const auto = await pedal('auto');
    const hold = await pedal('hold');
    const off = await pedal('off');
    report.pianoPedal = {
      auto,
      hold,
      off,
      ok: !auto.cUpWhileHeld && auto.eUpAtF && auto.allOffAfterGate && !hold.cUpWhileHeld && !hold.eUpAtF && hold.allOffAfterGate && off.cUpWhileHeld && off.eUpAtF,
    };
    await set({ sustainPedal: 'auto', mode: 'chords' });
    await quiet(800);
  }

  // 11. The looper records the real strummed notes.
  {
    await set({ mode: 'chords', lead: 'acoustic-guitar', bass: 'electric-bass', chordPlay: 'strum', strumPattern: 'down-up', groove: true, loopBars: 1, countIn: false });
    await quiet(300);
    log = [];
    engine.loop({ type: 'record', track: 0 });
    const t0 = eng.ctx!.currentTime;
    let st = engine.looper();
    const end = performance.now() + 9000;
    while (performance.now() < end && (st.phase === 'count-in' || st.recordTrack >= 0 || st.phase === 'idle')) {
      await drive(chordFrame(1), 300);
      st = engine.looper();
      if (st.tracks[0]?.notes && st.recordTrack < 0) break;
    }
    const recorded = st.tracks[0]?.notes ?? 0;
    const played = log.filter((e) => e.kind === 'on' && e.time >= t0).length;
    report.looper = { phase: st.phase, recordedNotes: recorded, playedNotesDuringTake: played, cancelled: log.filter((e) => e.kind === 'cancel').length, ok: recorded > 20 };
    engine.loop({ type: 'reset' });
    await set({ groove: false });
    await quiet(1200);
  }

  // 12. Stuck notes: switch modes, instruments and techniques while playing.
  {
    log = [];
    const insts = ['acoustic-guitar', 'grand-piano', 'string-ensemble', 'harp', 'distortion-guitar', 'church-organ', 'pluck', 'marimba', 'warm-pad', 'banjo'];
    const plays = ['block', 'strum', 'arp'] as const;
    const patterns: StrumPattern[] = ['down-up', 'folk', 'reggae', 'ballad', 'pop', 'single'];
    const bassPats: BassPattern[] = ['walking', 'octave', 'root-fifth', 'root', 'off'];
    for (let i = 0; i < 14; i++) {
      await set({
        mode: i % 4 === 3 ? 'melody' : 'chords',
        leftHand: i % 5 === 4 ? 'chords' : 'off',
        lead: insts[i % insts.length]!,
        bass: i % 2 ? 'electric-bass' : 'grand-piano',
        chordPlay: plays[i % 3]!,
        strumPattern: patterns[i % patterns.length]!,
        bassPattern: bassPats[i % bassPats.length]!,
        palmMute: i % 3 === 0,
        humanize: (i % 4) / 3,
        harmony: i % 2 ? 'third-above' : 'off',
        sustainPedal: (['auto', 'hold', 'off'] as const)[i % 3]!,
        playStyle: i % 6 === 5 ? 'manual' : 'auto',
        voicing: (['close', 'open', 'drop2', 'spread', 'guitar'] as const)[i % 5]!,
        groove: i % 4 === 1,
      });
      const deg = 1 + (i % 7);
      await drive(() => frame([hand(1, 'left', 0.25, 0.45, DEG[deg]!), hand(0, 'right', 0.7, 0.2 + (i % 5) * 0.12)]), 500);
      await drive(() => frame([hand(1, 'left', 0.25, 0.45, DEG[1 + ((deg + 2) % 7)]!), hand(0, 'right', 0.7, 0.3)]), 400);
    }
    await set({ groove: false });
    const q = await quiet(3000);
    const live = (eng.lead.player?.activeCount ?? 0) + (eng.bass.player?.activeCount ?? 0);
    const handlesOn = new Set(log.filter((e) => e.kind === 'on').map((e) => e.handle));
    const ended = new Set(log.filter((e) => e.kind === 'off' || e.kind === 'cancel').map((e) => e.handle));
    const unbalanced = [...handlesOn].filter((h) => !ended.has(h)).length;
    report.stuckNotes = { notes: handlesOn.size, cancelled: log.filter((e) => e.kind === 'cancel').length, unbalanced, liveVoicesAfter: live, ...q, ok: q.ok && unbalanced === 0 };
  }
}

/** Synth voices under strums, arpeggios and fast chord changes (withdrawn notes, stolen voices). */
async function synthStress(report: Report): Promise<void> {
  const warnings: string[] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => {
    warnings.push(a.map(String).join(' ') + ' @ ' + (new Error().stack ?? '').split('\n').slice(2, 4).join(' | '));
    orig(...a);
  };
  try {
    const synths = ['pluck', 'fm-bell', 'analog-lead', 'square-lead', 'warm-pad', 'theremin'];
    for (const lead of synths) {
      for (const chordPlay of ['strum', 'arp'] as const) {
        await set({ mode: 'chords', lead, bass: 'sub-bass', chordPlay, strumPattern: 'down-up', arpRate: '1/16t', arpOctaves: 3, bassPattern: 'octave', tempo: 160, humanize: 1 });
        for (let i = 0; i < 12; i++) await drive(chordFrame(1 + ((i * 3) % 7)), 140 + (i % 4) * 45);
      }
    }
    await set({ mode: 'melody', lead: 'pluck', harmony: 'third-above', playStyle: 'manual', glide: 0.5 });
    for (let i = 0; i < 20; i++) await drive(() => frame([hand(0, 'right', 0.7, 0.15 + ((i * 7) % 10) * 0.07)]), 60);
    await set({ playStyle: 'auto', glide: 0.15, harmony: 'off', humanize: 0 });
  } finally {
    console.warn = orig;
  }
  const q = await quiet(2000);
  report.synthStress = { warnings: warnings.slice(0, 6), warningCount: warnings.length, ...q, ok: warnings.length === 0 && q.ok };
}

async function techniqueTest(): Promise<Report> {
  const report: Report = {};
  const errors: string[] = [];
  window.addEventListener('error', (e) => errors.push(String(e.message)));
  window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
  pureChecks(report);
  await liveChecks(report);
  await synthStress(report);
  report.errors = errors;
  const fails = Object.entries(report)
    .filter(([, v]) => v && typeof v === 'object' && 'ok' in (v as object) && !(v as { ok: boolean }).ok)
    .map(([k]) => k);
  report.summary = fails.length ? `FAIL: ${fails.join(', ')}` : 'all ok';
  return report;
}

declare global {
  interface Window {
    __techniqueTest?: () => Promise<Report>;
  }
}
window.__techniqueTest = techniqueTest;
document.getElementById('run')!.addEventListener('click', () => {
  const out = document.getElementById('out')!;
  out.textContent = 'running...';
  void techniqueTest().then((r) => (out.textContent = JSON.stringify(r, null, 1)));
});
/** Only the synth stress check (quick). */
(window as unknown as { __synthStress: unknown }).__synthStress = async () => {
  await engine.unlock();
  settings = { ...settings, trigger: 'always', leftHand: 'off', groove: false, reverb: 0, tiltControls: false };
  engine.configure(settings);
  engine.setPlayZone({ y0: 0.1, y1: 0.86 });
  const report: Report = {};
  await synthStress(report);
  return report;
};

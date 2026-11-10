/**
 * Music engine harness: MockTracker + the real engine, live readout of voices, lanes and metrics,
 * and an in-page self-test (window.__musicSelfTest) used by dev/music-check.mjs in headless Chrome.
 */
import { createMusicEngine } from '../src/music';
import { MockTracker } from '../src/dev/mockTracker';
import { DEFAULT_SETTINGS } from '../src/settings';
import type { FaceState, FrameQuality, HandGesture, HandState, Settings, TrackingFrame, VoiceState } from '../src/types';

const engine = createMusicEngine();
let settings: Settings = { ...DEFAULT_SETTINGS, gestures: { ...DEFAULT_SETTINGS.gestures } };
let tracker: MockTracker | null = null;
let timer = 0;
let lastVoices: VoiceState[] = [];

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const out = $<HTMLPreElement>('out');
const loadOut = $<HTMLPreElement>('load');
const meter = $<HTMLDivElement>('meter').firstElementChild as HTMLDivElement;

for (const id of ['lead', 'bass'] as const) {
  const sel = $<HTMLSelectElement>(id);
  for (const inst of engine.instruments) sel.add(new Option(`${inst.glyph} ${inst.name} (${inst.family}, ${inst.sizeKB} KB)`, inst.id));
  sel.value = settings[id];
}
const scaleSel = $<HTMLSelectElement>('scale');
for (const s of engine.scales) scaleSel.add(new Option(s.name, s.id));

function readControls(): void {
  const v = (id: string) => $<HTMLSelectElement>(id).value;
  const c = (id: string) => $<HTMLInputElement>(id).checked;
  settings = {
    ...settings,
    lead: v('lead'),
    bass: v('bass'),
    mode: v('mode') as Settings['mode'],
    leftHand: v('leftHand') as Settings['leftHand'],
    chordPlay: v('chordPlay') as Settings['chordPlay'],
    trigger: v('trigger') as Settings['trigger'],
    scale: v('scale') as Settings['scale'],
    beat: v('beat') as Settings['beat'],
    groove: c('groove'),
    lowPower: c('lowPower'),
  };
  engine.configure(settings);
}
function writeControls(): void {
  for (const k of ['lead', 'bass', 'mode', 'leftHand', 'chordPlay', 'trigger', 'scale', 'beat'] as const) $<HTMLSelectElement>(k).value = String(settings[k]);
  $<HTMLInputElement>('groove').checked = settings.groove;
  $<HTMLInputElement>('lowPower').checked = settings.lowPower;
}
writeControls();
document.querySelectorAll('select, input').forEach((el) => el.addEventListener('change', readControls));

engine.onLoadState((s) => {
  loadOut.textContent = `load: ${s.id} ${s.loading ? 'loading' : 'ready'} ${(s.progress * 100).toFixed(0)}%${s.error ? ` ERROR ${s.error}` : ''}`;
});

// Chords mode: the mock's left hand cycles through the finger patterns I..vii.
const PATTERNS: HandState['fingers'][] = [
  [false, true, false, false, false],
  [false, true, true, false, false],
  [false, true, true, true, false],
  [false, true, true, true, true],
  [true, true, true, true, true],
  [false, true, false, false, true],
  [true, true, false, false, true],
];
function decorate(frame: TrackingFrame): TrackingFrame {
  if (settings.mode !== 'chords' && settings.leftHand !== 'chords') return frame;
  const left = frame.hands.length >= 2 || settings.mode === 'chords' ? frame.hands[0] : undefined;
  if (left) {
    const f = PATTERNS[Math.floor(frame.t / 2000) % PATTERNS.length]!;
    left.fingers = [...f];
    left.fingersUp = f.filter(Boolean).length;
  }
  return frame;
}

$('start').addEventListener('click', () => {
  void engine.unlock().then(() => {
    readControls();
    tracker?.dispose();
    tracker = new MockTracker();
    void tracker.init().then(() => {
      tracker!.start(document.createElement('video'), (f) => {
        lastVoices = engine.update(decorate(f));
      });
    });
    window.clearInterval(timer);
    timer = window.setInterval(render, 150);
  });
});
$('stop').addEventListener('click', () => {
  tracker?.dispose();
  tracker = null;
  engine.panic();
});
$('panic').addEventListener('click', () => engine.panic());
$('rec').addEventListener('click', () => {
  if (!engine.isRecording) {
    engine.startRecording();
    $('rec').textContent = 'Stop recording';
    return;
  }
  $('rec').textContent = 'Record';
  void engine.stopRecording().then((r) => {
    out.textContent = `recorded ${r.blob.size} bytes ${r.mimeType} .${r.extension} ${Math.round(r.durationMs)} ms`;
  });
});

function render(): void {
  const lvl = engine.level();
  meter.style.width = `${Math.min(100, lvl * 300)}%`;
  const m = engine.metrics();
  const voices = lastVoices;
  const lanes = engine.lanes('lead').map((l) => `${l.note}${l.isRoot ? '*' : ''}`).join(' ');
  const bassLanes = engine.lanes('bass').map((l) => l.note).join(' ');
  out.textContent = [
    ...voices.map((v) => `${v.voice.padEnd(4)} hand=${v.handId ?? '-'} ${v.instrument} gate=${v.gate ? 'ON ' : 'off'} note=${v.note || '-'} midi=${v.midi?.toFixed(2) ?? '-'} lane=${v.laneIndex} vel=${v.velocity.toFixed(2)} bright=${v.brightness.toFixed(2)}`),
    `lanes lead (top->bottom): ${lanes}`,
    `lanes bass: ${bassLanes || '-'}`,
    `key ${m.keyName} ${m.scaleName} | chord ${m.chord || '-'} ${m.roman} | degree ${m.degree} style ${m.chordStyle || '-'} borrowed ${m.borrowed}`,
    `diatonic ${m.diatonic.join(' ')}`,
    `active [${m.activeMidi.join(',')}] expr ${m.expression.toFixed(2)} handVol ${m.handVolume.toFixed(2)} volHand ${m.volumeHandId ?? '-'}`,
    `level ${lvl.toFixed(3)} (${m.levelDb.toFixed(1)} dB) | ${m.bpm} bpm bar ${m.bar}:${m.beat} | notes ${m.notesPlayed} (${m.notesPerMinute}/min) | ${(m.sessionMs / 1000).toFixed(1)} s`,
  ].join('\n');
}

// ---------------------------------------------------------------------------------------------
// Self-test (headless Chrome)
// ---------------------------------------------------------------------------------------------

const QUALITY: FrameQuality = { score: 1, verdict: 'great', ideal: true, brightness: 0.5, handScale: 0.3 };
const OPEN: HandState['fingers'] = [true, true, true, true, true];

interface HandOpts {
  y?: number;
  fingers?: HandState['fingers'];
  roll?: number;
  thumbOut?: boolean;
  pinching?: boolean;
  gesture?: HandGesture;
}
function hand(id: number, side: 'left' | 'right', x: number, o: HandOpts = {}): HandState {
  const y = o.y ?? 0.45;
  const fingers = o.fingers ?? OPEN;
  return {
    id,
    side,
    landmarks: Array.from({ length: 21 }, () => ({ x, y, z: 0 })),
    box: { x: x - 0.08, y: y - 0.05, w: 0.16, h: 0.3 },
    indexTip: { x, y },
    thumbTip: { x: x - 0.04, y: y + 0.05 },
    pinch: o.pinching ? 1 : 0,
    pinching: !!o.pinching,
    fingersUp: fingers.filter(Boolean).length,
    fingers,
    roll: o.roll ?? 0,
    thumbOut: !!o.thumbOut,
    gesture: o.gesture ?? 'open',
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
  return { t: performance.now(), hands, face: f, fps: 30, quality: QUALITY, video: { width: 1280, height: 720 } };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Feeds frames at 30 fps for `ms`, returns the peak level seen and the last voice states. */
async function drive(make: () => TrackingFrame, ms: number) {
  const end = performance.now() + ms;
  let peak = 0;
  let onsets = 0;
  let voices = engine.update(make());
  while (performance.now() < end) {
    voices = engine.update(make());
    for (const v of voices) if (v.onset) onsets++;
    peak = Math.max(peak, engine.level());
    await sleep(33);
  }
  return { peak, onsets, voices: voices.map((v) => ({ ...v })), metrics: { ...engine.metrics(), activeMidi: [...engine.metrics().activeMidi], diatonic: [...engine.metrics().diatonic] } };
}

function waitLoaded(id: string, timeoutMs = 20000): Promise<{ ok: boolean; error?: string; ms: number }> {
  const t0 = performance.now();
  return new Promise((resolve) => {
    let done = false;
    let unsub: (() => void) | null = null;
    let to = 0;
    const finish = (r: { ok: boolean; error?: string }) => {
      if (done) return;
      done = true;
      queueMicrotask(() => unsub?.());
      clearTimeout(to);
      resolve({ ...r, ms: Math.round(performance.now() - t0) });
    };
    unsub = engine.onLoadState((s) => {
      if (s.id !== id) return;
      if (s.error) finish({ ok: false, error: s.error });
      else if (!s.loading && s.progress >= 1) finish({ ok: true });
    });
    if (!done) to = window.setTimeout(() => finish({ ok: false, error: 'timeout' }), timeoutMs);
  });
}

async function setAndLoad(patch: Partial<Settings>, ids: string[]) {
  const waits = ids.map((id) => waitLoaded(id));
  settings = { ...settings, ...patch };
  engine.configure(settings);
  return Promise.all(waits);
}

async function quiet(ms = 1200) {
  const r = await drive(() => frame([]), ms);
  return engine.level() < 0.003 ? { ok: true, level: engine.level(), peakDuring: r.peak } : { ok: false, level: engine.level(), peakDuring: r.peak };
}

interface Report {
  [k: string]: unknown;
}

async function selfTest(): Promise<Report> {
  const report: Report = {};
  const errors: string[] = [];
  window.addEventListener('error', (e) => errors.push(String(e.message)));
  window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason)));
  tracker?.dispose();
  tracker = null;
  await engine.unlock();
  settings = { ...DEFAULT_SETTINGS, gestures: { ...DEFAULT_SETTINGS.gestures }, trigger: 'always', leftHand: 'off', groove: false, reverb: 0.2 };
  engine.configure(settings);
  engine.setPlayZone({ y0: 0.1, y1: 0.86 });

  // 1. Every instrument: loads, sounds, releases (dry, so a reverb tail cannot hide or fake a stuck note).
  settings = { ...settings, reverb: 0 };
  engine.configure(settings);
  const perInstrument: Report[] = [];
  for (const inst of engine.instruments) {
    const [load] = await setAndLoad({ lead: inst.id }, [inst.id]);
    const play = await drive(() => frame([hand(0, 'right', 0.7, { y: 0.5 })]), 450);
    const dbg = engine as unknown as { lead: { player: { spec: { id: string }; activeCount: number } | null } };
    const playing = `${dbg.lead.player?.spec.id}:${dbg.lead.player?.activeCount}`;
    const off = await quiet(inst.sustained ? 900 : 1600);
    perInstrument.push({ id: inst.id, kind: inst.kind, sizeKB: inst.sizeKB, load: load!.ok, loadMs: load!.ms, error: load!.error, peak: Number(play.peak.toFixed(4)), note: play.voices[0]!.note, silentAfter: off.ok, playing, onsets: play.onsets, ok: load!.ok && play.peak > 0.01 && off.ok });
  }
  report.instruments = perInstrument;
  report.instrumentsOk = perInstrument.filter((r) => r.ok).length + '/' + perInstrument.length;
  settings = { ...settings, reverb: 0.3 };
  engine.configure(settings);

  // 2. Lanes: 15 pentatonic lanes, cached array instance.
  await setAndLoad({ lead: 'grand-piano', scale: 'major-pentatonic', span: 15 }, ['grand-piano']);
  const l1 = engine.lanes('lead');
  report.lanes = { count: l1.length, top: l1[0]?.note, bottom: l1[l1.length - 1]?.note, cached: l1 === engine.lanes('lead') };

  // 3. Hysteresis: hover right at a lane boundary with jitter -> one note.
  {
    const lanes = engine.lanes('lead');
    const boundary = lanes[5]!.y + lanes[5]!.h / 2;
    let i = 0;
    const r = await drive(() => frame([hand(0, 'right', 0.7, { y: boundary + (i++ % 2 ? 0.004 : -0.004) })]), 800);
    report.hysteresis = { onsets: r.onsets, ok: r.onsets <= 1 };
    await quiet(800);
  }

  // 4. Switch instruments mid-note: no stuck notes.
  {
    await setAndLoad({ lead: 'violin' }, ['violin']);
    await setAndLoad({ lead: 'cello' }, ['cello']);
    const make = () => frame([hand(0, 'right', 0.7, { y: 0.4 })]);
    await drive(make, 300);
    settings = { ...settings, lead: 'violin' };
    engine.configure(settings);
    await drive(make, 300);
    settings = { ...settings, lead: 'theremin' };
    engine.configure(settings);
    await drive(make, 300);
    settings = { ...settings, lead: 'opera-choir' };
    engine.configure(settings); // loads while playing: keeps the theremin meanwhile
    await waitLoaded('opera-choir');
    await drive(make, 300);
    const q = await quiet(1800);
    report.switchMidNote = { ...q };
  }

  // 5. Mute gesture (fist bound to 'mute').
  {
    settings = { ...settings, lead: 'opera-choir', gesturesEnabled: true };
    engine.configure(settings);
    const playing = await drive(() => frame([hand(0, 'right', 0.7)]), 300);
    const muted = await drive(() => frame([hand(0, 'right', 0.7, { gesture: 'fist', fingers: [false, false, false, false, false] })]), 700);
    report.muteGesture = { gateBefore: playing.voices[0]!.gate, gateDuring: muted.voices[0]!.gate, levelAfter: Number(engine.level().toFixed(4)), ok: playing.voices[0]!.gate && !muted.voices[0]!.gate };
    await quiet(600);
  }

  // 6. Mouth trigger with sensitivity thresholds.
  {
    settings = { ...settings, trigger: 'mouth', sensitivity: 0.5 };
    engine.configure(settings);
    const closed = await drive(() => frame([hand(0, 'right', 0.7)], face(0.1)), 300);
    const open = await drive(() => frame([hand(0, 'right', 0.7)], face(0.6)), 300);
    const noFace = await drive(() => frame([hand(0, 'right', 0.7)], null), 300);
    report.mouthGate = { closed: closed.voices[0]!.gate, open: open.voices[0]!.gate, noFace: noFace.voices[0]!.gate, ok: !closed.voices[0]!.gate && open.voices[0]!.gate && !noFace.voices[0]!.gate };
    settings = { ...settings, trigger: 'always' };
    engine.configure(settings);
    await quiet(600);
  }

  // 7. Left hand volume role.
  {
    settings = { ...settings, leftHand: 'volume', lead: 'opera-choir' };
    engine.configure(settings);
    const top = await drive(() => frame([hand(1, 'left', 0.25, { y: 0.12 }), hand(0, 'right', 0.7)]), 400);
    const bottom = await drive(() => frame([hand(1, 'left', 0.25, { y: 0.85 }), hand(0, 'right', 0.7)]), 500);
    const gone = await drive(() => frame([hand(0, 'right', 0.7)]), 1000); // held
    const back = await drive(() => frame([hand(0, 'right', 0.7)]), 2600); // eases to full
    report.volumeRole = {
      top: top.metrics.handVolume.toFixed(2),
      bottom: bottom.metrics.handVolume.toFixed(2),
      heldAfterLoss: gone.metrics.handVolume.toFixed(2),
      recovered: back.metrics.handVolume.toFixed(2),
      volumeHandId: top.metrics.volumeHandId,
      ok: top.metrics.handVolume > 0.9 && bottom.metrics.handVolume < 0.05 && gone.metrics.handVolume < 0.1 && back.metrics.handVolume > 0.9,
    };
    settings = { ...settings, leftHand: 'off' };
    engine.configure(settings);
    await quiet(600);
  }

  // 8. Groove on/off + bar/beat.
  {
    settings = { ...settings, groove: true, beat: 'pop', tempo: 120 };
    engine.configure(settings);
    const on = await drive(() => frame([]), 1600);
    const styles: Report = {};
    for (const beat of ['lofi', 'rock', 'house', 'metronome'] as const) {
      settings = { ...settings, beat };
      engine.configure(settings);
      const r = await drive(() => frame([]), 1100);
      styles[beat] = Number(r.peak.toFixed(4));
    }
    settings = { ...settings, groove: false };
    engine.configure(settings);
    const off = await quiet(1500);
    report.groove = { peakOn: Number(on.peak.toFixed(4)), bar: on.metrics.bar, beat: on.metrics.beat, styles, silentAfterStop: off.ok, barAfterStop: engine.metrics().bar, ok: on.peak > 0.01 && on.metrics.bar >= 1 && off.ok };
  }

  // 9. Recording -> WAV.
  {
    engine.startRecording();
    await drive(() => frame([hand(0, 'right', 0.7)]), 1200);
    await quiet(300);
    const rec = await engine.stopRecording();
    report.recording = { size: rec.blob.size, mime: rec.mimeType, ext: rec.extension, durationMs: Math.round(rec.durationMs), ok: rec.blob.size > 1000 };
  }

  // 10. Chords mode.
  {
    const [a, b] = await setAndLoad({ mode: 'chords', lead: 'grand-piano', bass: 'electric-bass', chordPlay: 'block', key: 0, scale: 'major', tiltControls: true }, ['grand-piano', 'electric-bass']);
    const L = (fingers: HandState['fingers'], roll = 0) => hand(1, 'left', 0.25, { fingers, roll });
    const R = (o: HandOpts) => hand(0, 'right', 0.75, o);
    const one: HandState['fingers'] = [false, true, false, false, false];
    const cases: [string, () => TrackingFrame][] = [
      ['I', () => frame([L(one)])],
      ['ii', () => frame([L([false, true, true, false, false])])],
      ['iii', () => frame([L([false, true, true, true, false])])],
      ['IV', () => frame([L([false, true, true, true, true])])],
      ['V', () => frame([L(OPEN)])],
      ['vi', () => frame([L([false, true, false, false, true])])],
      ['vii', () => frame([L([true, true, false, false, true])])],
      ['I 7th', () => frame([L(one), R({ y: 0.2, fingers: [false, true, true, false, false] })])],
      ['I add9', () => frame([L(one), R({ y: 0.2, fingers: [false, true, true, true, false] })])],
      ['I sus4', () => frame([L(one), R({ y: 0.2, fingers: [false, true, true, true, true] })])],
      ['I open', () => frame([L(one), R({ y: 0.2, fingers: OPEN })])],
      ['I borrowed', () => frame([L(one, 0.6)])],
      ['I octave down', () => frame([L(one), R({ y: 0.2, fingers: [true, true, false, false, false], thumbOut: true })])],
      ['right fist mute', () => frame([L(one), R({ y: 0.2, fingers: [false, false, false, false, false], gesture: 'fist' })])],
    ];
    const results: Report[] = [];
    for (const [name, make] of cases) {
      const r = await drive(make, 450);
      results.push({ case: name, chord: r.metrics.chord, roman: r.metrics.roman, degree: r.metrics.degree, style: r.metrics.chordStyle, borrowed: r.metrics.borrowed, hands: `${r.metrics.degreeHandId}/${r.metrics.styleHandId}`, lead: r.voices[0]!.note, bass: r.voices[1]!.note, active: r.metrics.activeMidi.join(','), gate: r.voices[0]!.gate, peak: Number(r.peak.toFixed(3)) });
    }
    report.chordsLoad = [a!.ok, b!.ok];
    report.chords = results;
    report.diatonic = engine.metrics().diatonic.join(' ');
    // Debounce: passing finger counts (flicker for < 120 ms) never sound.
    await quiet(500);
    let k = 0;
    const flick = await drive(() => frame([L(k++ % 3 === 0 ? OPEN : one)]), 600);
    report.chordDebounce = { degree: flick.metrics.degree, chord: flick.metrics.chord };
    // Play styles.
    for (const chordPlay of ['strum', 'arp'] as const) {
      settings = { ...settings, chordPlay, tempo: 120 };
      engine.configure(settings);
      await quiet(400);
      const r = await drive(() => frame([L(one)]), 1600);
      report[`chords_${chordPlay}`] = { onsets: r.onsets, peak: Number(r.peak.toFixed(3)), active: r.metrics.activeMidi.join(',') };
    }
    settings = { ...settings, chordPlay: 'block' };
    engine.configure(settings);
    report.chordsSilentAfter = (await quiet(1500)).ok;
  }

  // 11. Melody mode with the left-hand chords role (same finger mapping).
  {
    settings = { ...settings, mode: 'melody', leftHand: 'chords', bass: 'grand-piano', lead: 'flute' };
    await setAndLoad({}, []);
    await waitLoaded('flute');
    const r = await drive(() => frame([hand(1, 'left', 0.25, { fingers: [false, true, false, false, true] }), hand(0, 'right', 0.7)]), 600);
    report.chordRole = { bassNote: r.voices[1]!.note, lead: r.voices[0]!.note, chord: r.metrics.chord, degree: r.metrics.degree, ok: r.voices[1]!.note === 'Am' };
    settings = { ...settings, leftHand: 'bass', bass: 'electric-bass' };
    engine.configure(settings);
    const rb = await drive(() => frame([hand(1, 'left', 0.25, { y: 0.8 }), hand(0, 'right', 0.7)]), 500);
    report.bassRole = { bass: rb.voices[1]!.note, lanes: engine.lanes('bass').map((l) => l.note).join(' ') };
    settings = { ...settings, leftHand: 'off' };
    engine.configure(settings);
    report.melodySilentAfter = (await quiet(1500)).ok;
  }

  // 12. Panic releases everything immediately.
  {
    settings = { ...settings, lead: 'string-ensemble' };
    await setAndLoad({}, []);
    await waitLoaded('string-ensemble');
    const before = await drive(() => frame([hand(0, 'right', 0.7)]), 400);
    engine.panic();
    const activeAfter = engine.metrics().activeMidi.length;
    await sleep(250);
    const at250 = engine.level();
    await sleep(2000);
    const at2s = engine.level();
    report.panic = { before: Number(before.peak.toFixed(4)), at250ms: Number(at250.toFixed(4)), at2s: Number(at2s.toFixed(5)), activeAfter, ok: activeAfter === 0 && at250 < before.peak * 0.35 && at2s < 0.003 };
  }

  const total = perInstrument.reduce((s, r) => s + (r.sizeKB as number), 0);
  report.totalSampleKB = total;
  report.errors = errors;
  return report;
}

declare global {
  interface Window {
    __musicSelfTest?: () => Promise<Report>;
  }
}
window.__musicSelfTest = selfTest;
/** Plays one instrument for `ms` and reports the peak level (for level balancing). */
(window as unknown as { __musicProbe: unknown }).__musicProbe = async (ids: string[], ms = 600) => {
  await engine.unlock();
  settings = { ...DEFAULT_SETTINGS, gestures: { ...DEFAULT_SETTINGS.gestures }, trigger: 'always', leftHand: 'off', reverb: 0 };
  engine.configure(settings);
  engine.setPlayZone({ y0: 0.1, y1: 0.86 });
  const out: Record<string, number> = {};
  for (const id of ids) {
    await setAndLoad({ lead: id }, [id]);
    const r = await drive(() => frame([hand(0, 'right', 0.7, { y: 0.5 })]), ms);
    out[id] = Number(r.peak.toFixed(4));
    await quiet(engine.instruments.find((i) => i.id === id)?.sustained ? 900 : 1600);
  }
  return out;
};
/**
 * Soak: the mock tracker drives the engine for `minutes` while instruments, modes, play styles
 * and the groove keep changing. Samples the JS heap (after a GC when exposed) and the number of
 * live notes so a leak shows up as growth.
 */
(window as unknown as { __musicSoak: unknown }).__musicSoak = async (minutes = 10) => {
  await engine.unlock();
  const ids = ['grand-piano', 'violin', 'theremin', 'opera-choir', 'acoustic-guitar', 'warm-pad', 'marimba', 'flute', 'electric-bass', 'fm-bell'];
  settings = { ...DEFAULT_SETTINGS, gestures: { ...DEFAULT_SETTINGS.gestures }, trigger: 'mouth', groove: true };
  engine.configure(settings);
  tracker?.dispose();
  tracker = new MockTracker();
  await tracker.init();
  let frames = 0;
  tracker.start(document.createElement('video'), (f) => {
    frames++;
    lastVoices = engine.update(decorate(f));
  });
  const raf = () => {
    engine.level();
    engine.spectrum();
    engine.metrics();
    if (tracker) requestAnimationFrame(raf);
  };
  requestAnimationFrame(raf);
  const gc = (window as unknown as { gc?: () => void }).gc;
  const heap = () => {
    gc?.();
    return Math.round(((performance as unknown as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? 0) / 1024);
  };
  const inner = engine as unknown as { lead: { player: { activeCount: number } | null }; bass: { player: { activeCount: number } | null } };
  const samples: { t: number; heapKB: number; liveNotes: number; notes: number }[] = [];
  const end = performance.now() + minutes * 60_000;
  let step = 0;
  while (performance.now() < end) {
    await sleep(15_000);
    step++;
    const mode = step % 4 === 3 ? 'chords' : 'melody';
    settings = {
      ...settings,
      lead: ids[step % ids.length]!,
      bass: ids[(step + 3) % ids.length]!,
      mode,
      leftHand: (['volume', 'bass', 'chords', 'off'] as const)[step % 4]!,
      chordPlay: (['block', 'strum', 'arp'] as const)[step % 3]!,
      beat: (['pop', 'lofi', 'rock', 'house', 'metronome'] as const)[step % 5]!,
      lowPower: step % 6 === 5,
    };
    engine.configure(settings);
    if (step % 2 === 0) {
      samples.push({ t: Math.round((minutes * 60_000 - (end - performance.now())) / 1000), heapKB: heap(), liveNotes: (inner.lead.player?.activeCount ?? 0) + (inner.bass.player?.activeCount ?? 0), notes: engine.metrics().notesPlayed });
    }
  }
  tracker.dispose();
  tracker = null;
  engine.panic();
  await sleep(2500);
  samples.push({ t: minutes * 60, heapKB: heap(), liveNotes: (inner.lead.player?.activeCount ?? 0) + (inner.bass.player?.activeCount ?? 0), notes: engine.metrics().notesPlayed });
  return { frames, samples };
};
$('selftest').addEventListener('click', () => {
  out.textContent = 'running self-test...';
  void selfTest().then((r) => (out.textContent = JSON.stringify(r, null, 1)));
});

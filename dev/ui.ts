/**
 * UI harness: landing -> stage with the MockTracker and the silent MockEngine. No camera, no
 * models, no audio. Open /dev/ui.html in the dev server.
 *
 * Query flags (combine freely):
 *   auto            start immediately (skips the landing click)
 *   error=<code>    show that AppError on the landing page
 *   stageError      show an error card on the stage
 *   boot            keep the boot overlay up (models never finish)
 *   sheet=<tab>     open the controls on lead | left | play | learn | gestures | display
 *   help            open the help overlay
 *   mode=chords     start in chords mode;  lowPower  start in low-power mode
 *   rec             start a (silent) recording
 *   set=<json>      extra settings patch
 *   learn=<songId>  start Learn mode on that song (learnMode=tempo for tempo mode)
 *   learnPilot      the right hand follows the target lane and the mouth opens on it
 */
import { AppError, type AppErrorCode, type LandingView, type Settings, type StageView, type TrackingFrame, type VoiceState } from '../src/types';
import { mountLanding, mountStage } from '../src/ui';
import { MockTracker } from '../src/dev/mockTracker';
import { MockEngine } from '../src/dev/mockEngine';
import { DEFAULT_SETTINGS, sanitizeSettings } from '../src/settings';
import { GestureController } from '../src/gestures';
import { coverMap, playZoneFor } from '../src/geometry';
import { LearnSession } from '../src/learn';

const q = new URLSearchParams(location.search);
const root = document.getElementById('app')!;
const engine = new MockEngine();
const ids = engine.instruments.map((i) => i.id);
let settings: Settings = sanitizeSettings(
  {
    ...DEFAULT_SETTINGS,
    ...(q.get('mode') === 'chords' ? { mode: 'chords', trigger: 'always', groove: true } : {}),
    ...(q.has('lowPower') ? { lowPower: true } : {}),
    ...(q.get('set') ? (JSON.parse(q.get('set')!) as Partial<Settings>) : {}),
  },
  ids,
);

let landing: LandingView | null = null;
let stage: StageView | null = null;
let tracker: MockTracker | null = null;
let frame: TrackingFrame | null = null;
let voices: VoiceState[] = [];
let raf = 0;
let fakeCam: { stream: MediaStream; stop: () => void } | null = null;
let zoneKey = '';
const learn = new LearnSession(ids);
const learnPilot = q.has('learnPilot');
let pilotY = -1;

/** Learn autopilot: glide the lead hand to the target lane, open the mouth once it is there. */
function pilot(f: TrackingFrame): void {
  const st = learn.state!;
  const hand = f.hands[f.hands.length - 1];
  const lane = st.target ? engine.lanes('lead')[st.target.laneIndex] : undefined;
  if (!hand || !lane) return;
  if (pilotY < 0) pilotY = hand.indexTip.y;
  pilotY += (lane.y - pilotY) * 0.35;
  const dy = pilotY - hand.indexTip.y;
  for (const p of hand.landmarks) p.y += dy;
  hand.box.y += dy;
  hand.indexTip.y += dy;
  hand.thumbTip.y += dy;
  hand.pinch = 0;
  hand.pinching = false;
  if (f.face) {
    const onLane = Math.abs(lane.y - pilotY) < lane.h / 2;
    // Tempo mode: open just before the note is due (closing after each hit re-articulates).
    const due = st.mode === 'wait' ? f.t - st.lastHitT > 160 : st.songMs >= st.targetStartMs - 120;
    const open = onLane && due;
    f.face.mouthOpen = open ? 0.7 : 0.02;
    f.face.mouthIsOpen = open;
  }
}

const gestures = new GestureController({
  getSettings: () => settings,
  apply: (p) => apply(p),
  toggleRecording: () => toggleRec(),
  isRecording: () => engine.isRecording,
  instruments: engine.instruments,
  scales: engine.scales,
});

function apply(patch: Partial<Settings>): void {
  settings = sanitizeSettings({ ...settings, ...patch }, ids);
  engine.configure(settings);
  tracker?.setLowPower(settings.lowPower);
  stage?.setSettings(settings);
}

function toggleRec(): void {
  if (!engine.isRecording) {
    engine.startRecording();
    stage?.setRecording(true);
  } else {
    stage?.setRecording(false);
    void engine.stopRecording().then(() => stage?.toast('Nothing was recorded (mock engine).'));
  }
}

/** A dim "room" with a soft silhouette, so the stage is not a black hole in screenshots. */
function fakeCamera(): { stream: MediaStream; stop: () => void } {
  const c = document.createElement('canvas');
  c.width = 640;
  c.height = 360;
  const ctx = c.getContext('2d')!;
  let t = 0;
  const draw = (): void => {
    t += 1;
    const g = ctx.createLinearGradient(0, 0, 0, 360);
    g.addColorStop(0, '#2a2f45');
    g.addColorStop(1, '#14161f');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 640, 360);
    ctx.fillStyle = 'rgba(255,220,180,0.06)';
    ctx.fillRect(470, 40, 120, 160);
    const body = ctx.createRadialGradient(320, 330, 20, 320, 330, 200);
    body.addColorStop(0, '#5a4c4a');
    body.addColorStop(1, 'rgba(40,36,40,0)');
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.ellipse(320, 380, 190, 150, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#8a6f62';
    ctx.beginPath();
    ctx.ellipse(320, 130 + Math.sin(t / 40) * 2, 42, 56, 0, 0, Math.PI * 2);
    ctx.fill();
  };
  draw();
  const timer = window.setInterval(draw, 66);
  const stream = c.captureStream(15);
  return { stream, stop: () => (window.clearInterval(timer), stream.getTracks().forEach((tr) => tr.stop())) };
}

function updateZone(): void {
  if (!stage) return;
  const w = stage.viewport.clientWidth;
  const h = stage.viewport.clientHeight;
  const key = `${w}x${h}`;
  if (key === zoneKey || !w || !h) return;
  zoneKey = key;
  engine.setPlayZone(playZoneFor(coverMap(1280, 720, w, h)));
}

const loop = (): void => {
  if (!stage) return;
  stage.render({
    frame,
    voices,
    lanes: { lead: engine.lanes('lead'), bass: engine.lanes('bass') },
    audio: { level: engine.level(), spectrum: engine.spectrum() },
    metrics: engine.metrics(),
    status: { fps: frame?.fps ?? 0, delegate: tracker?.delegate ?? null, hands: frame?.hands.length ?? 0, face: !!frame?.face },
    lastGesture: gestures.last,
    pendingGesture: gestures.pending,
    learn: learn.state,
  });
  raf = requestAnimationFrame(loop);
};

async function start(): Promise<void> {
  landing?.setBusy(true, 'Tuning the orchestra…');
  await engine.unlock();
  const st = mountStage(root, {
    onSettings: apply,
    onRecordToggle: toggleRec,
    onExit: exit,
    onLearn: (id, mode) => {
      if (!id) return learn.stop();
      const patch = learn.start(id, mode);
      if (patch) apply(patch);
    },
  });
  stage = st;
  st.setInstruments(engine.instruments, engine.scales);
  st.setSettings(settings);
  st.setSongs(learn.songs());
  engine.onLoadState((s) => stage?.setLoadState(s));
  engine.configure(settings);
  st.setBootProgress({ stage: 'camera', label: 'Waiting for camera permission', loaded: 0, total: 0, done: false });
  await new Promise((r) => setTimeout(r, 350));
  fakeCam = fakeCamera();
  st.video.srcObject = fakeCam.stream;
  void st.video.play().catch(() => undefined);
  st.setBootProgress({ stage: 'camera', label: 'Camera ready', loaded: 1, total: 1, done: true });
  landing?.destroy();
  landing = null;
  tracker = new MockTracker();
  if (q.has('boot')) {
    st.setBootProgress({ stage: 'hands', label: 'Loading hand model · 3.1 / 7.8 MB', loaded: 3.1, total: 7.8, done: false });
    return;
  }
  await tracker.init((p) => stage?.setBootProgress(p));
  st.setBootProgress({ stage: 'audio', label: 'Audio ready', loaded: 1, total: 1, done: true });
  st.setBootProgress(null);
  tracker.setLowPower(settings.lowPower);
  tracker.start(st.video, (f) => {
    frame = f;
    updateZone();
    gestures.update(f);
    if (learnPilot && learn.state) pilot(f);
    voices = engine.update(f);
    const lead = settings.mode === 'melody' ? (voices[0] ?? null) : null;
    if (learn.state && learn.update(lead, engine.lanes('lead'), f.t)) stage?.setSongs(learn.songs());
  });
  window.addEventListener('resize', updateZone);
  raf = requestAnimationFrame(loop);

  const click = (sel: string): void => (document.querySelector(sel) as HTMLElement | null)?.click();
  const tab = q.get('sheet');
  if (tab) {
    click('.dock-more');
    const names: Record<string, string> = { lead: 'Lead', left: 'Left hand', play: 'Play', learn: 'Learn', gestures: 'Gestures', display: 'Setup' };
    for (const b of document.querySelectorAll<HTMLElement>('.tab')) if (b.textContent === names[tab]) b.click();
  }
  if (q.has('help')) click('.icon-btn[aria-label^="Help"]');
  const song = q.get('learn');
  if (song) {
    const patch = learn.start(song, q.get('learnMode') === 'tempo' ? 'tempo' : 'wait');
    if (patch) apply(patch);
  }
  if (q.has('rec')) toggleRec();
  if (q.has('stageError')) st.showError(new AppError('model-load-failed', 'Failed to fetch hand_landmarker.task (HTTP 503)'));
}

function exit(): void {
  cancelAnimationFrame(raf);
  tracker?.dispose();
  tracker = null;
  fakeCam?.stop();
  fakeCam = null;
  engine.panic();
  gestures.reset();
  learn.stop();
  stage?.destroy();
  stage = null;
  frame = null;
  zoneKey = '';
  showLanding();
}

function showLanding(): void {
  landing = mountLanding(root, { onStart: () => void start() });
}

showLanding();
const err = q.get('error') as AppErrorCode | null;
if (err) {
  const msgs: Partial<Record<AppErrorCode, string>> = {
    'camera-denied': 'Permission denied',
    'insecure-context': 'The camera needs a secure (https) connection.',
    'camera-in-use': 'Could not start video source',
  };
  landing!.showError(new AppError(err, msgs[err] ?? 'Mock error for the UI harness'));
}
if (q.has('auto')) void start();

// Expose for automated checks (frame timing, memory).
(window as unknown as { __harness: unknown }).__harness = { engine, get stage() { return stage; } };

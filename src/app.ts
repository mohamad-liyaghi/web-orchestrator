import {
  AppError,
  type HudStatus,
  type LandingView,
  type LearnMode,
  type LoopCommand,
  type MusicEngine,
  type Settings,
  type StageView,
  type Tracker,
  type TrackingFrame,
  type VoiceState,
} from './types';
import { cameraIdOf, closeCamera, createTracker, listCameras, openCamera, prefetchTrackingAssets } from './tracking';
import { createMusicEngine } from './music';
import { mountLanding, mountStage } from './ui';
import { MockTracker } from './dev/mockTracker';
import { loadSettings, sanitizeSettings, saveSettings, settingsFromHash } from './settings';
import { coverMap, playZoneFor } from './geometry';
import { GestureController } from './gestures';
import { LearnSession } from './learn';

/** `?mock` runs a synthetic tracker: no camera, no models. Used for development and tests. */
const MOCK = new URLSearchParams(location.search).has('mock');

function toAppError(e: unknown): AppError {
  if (e instanceof AppError) return e;
  const message = e instanceof Error ? e.message : String(e);
  return new AppError('unknown', message || 'Something went wrong.', { cause: e });
}

function stamp(d = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

/**
 * Top-level controller: landing -> (Start) -> camera + models + audio -> stage loop -> exit.
 * Owns the lifecycle; the modules stay unaware of each other.
 */
export class App {
  private readonly engine: MusicEngine;
  private settings: Settings;
  private landing: LandingView | null = null;
  private stage: StageView | null = null;
  private tracker: Tracker | null = null;
  private stream: MediaStream | null = null;
  private unsubscribeLoad: (() => void) | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private frame: TrackingFrame | null = null;
  private voices: VoiceState[] = [];
  private raf = 0;
  private running = false;
  private starting = false;
  private zoneKey = '';
  private readonly instrumentIds: string[];
  private readonly gestures: GestureController;
  private readonly learn: LearnSession;
  private unsubscribeMidi: (() => void) | null = null;
  /** Camera switch in progress (a newer pick waits for it). */
  private cameraBusy: Promise<void> | null = null;
  private cameraWanted = '';

  constructor(private readonly root: HTMLElement) {
    this.engine = createMusicEngine();
    this.instrumentIds = this.engine.instruments.map((i) => i.id);
    this.settings = loadSettings(this.instrumentIds);
    this.learn = new LearnSession(this.instrumentIds);
    this.gestures = new GestureController({
      getSettings: () => this.settings,
      apply: (patch) => this.applySettings(patch),
      toggleRecording: () => void this.toggleRecording(),
      isRecording: () => this.engine.isRecording,
      loopRecord: () => this.engine.loop({ type: 'record' }),
      instruments: this.engine.instruments,
      scales: this.engine.scales,
    });
    // A shared setup link (#lead=theremin&scale=minor...) overrides the stored settings once.
    const shared = settingsFromHash();
    if (shared) {
      this.settings = sanitizeSettings({ ...this.settings, ...shared }, this.instrumentIds);
      saveSettings(this.settings);
      history.replaceState(null, '', location.pathname + location.search);
    }
  }

  mount(): void {
    this.showLanding();
    document.addEventListener('visibilitychange', this.onVisibility);
    window.addEventListener('pagehide', this.onPageHide);
    // Give the first start a head start on desktop (never on phones or with data saver), once the
    // landing page has painted and settled.
    if (!MOCK) {
      const idle = (cb: () => void): void => {
        const ric = (window as Window & { requestIdleCallback?: Window['requestIdleCallback'] }).requestIdleCallback;
        if (ric) ric.call(window, cb, { timeout: 4000 });
        else setTimeout(cb, 1500);
      };
      window.setTimeout(() => idle(prefetchTrackingAssets), 1200);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Start / stop
  // -------------------------------------------------------------------------------------------

  private showLanding(error?: AppError): void {
    if (!this.landing) this.landing = mountLanding(this.root, { onStart: () => void this.start() });
    this.landing.setBusy(false);
    if (error) this.landing.showError(error);
  }

  private async start(): Promise<void> {
    if (this.starting || this.running) return;
    this.starting = true;
    this.landing?.setBusy(true, 'Preparing everything…');

    // Must run synchronously inside the click/tap handler (autoplay policies, iOS).
    const audioReady = this.engine.unlock().catch((e: unknown) => {
      throw new AppError('audio-failed', 'Audio could not start in this browser.', { cause: e });
    });
    let stage: StageView | null = null;

    try {
      if (!MOCK && !window.isSecureContext) {
        throw new AppError('insecure-context', 'The camera needs a secure (https) connection.');
      }

      stage = mountStage(this.root, {
        onSettings: (patch) => this.applySettings(patch),
        onRecordToggle: () => void this.toggleRecording(),
        onExit: () => void this.exit(),
        onLearn: (songId, mode) => this.setLearn(songId, mode),
        onLoop: (cmd) => this.loopCommand(cmd),
        onMidiEnable: () => void this.enableMidi(),
      });
      this.stage = stage;
      stage.setInstruments(this.engine.instruments, this.engine.scales);
      stage.setSettings(this.settings);
      stage.setSongs(this.learn.songs());
      this.unsubscribeLoad = this.engine.onLoadState((s) => this.stage?.setLoadState(s));
      stage.setMidiStatus(this.engine.midiStatus());
      this.unsubscribeMidi = this.engine.onMidiStatus((s) => this.stage?.setMidiStatus(s));

      const tracker: Tracker = MOCK ? new MockTracker() : createTracker();
      this.tracker = tracker;
      const modelsReady = tracker.init((p) => this.stage?.setBootProgress(p));
      modelsReady.catch(() => undefined); // awaited below; avoid an unhandled rejection meanwhile

      stage.setBootProgress({ stage: 'camera', label: 'Waiting for camera permission', loaded: 0, total: 0, done: false });
      const stream = MOCK ? null : await this.openPreferredCamera(stage.video);
      if (this.stage !== stage) {
        // The user left (or the page was hidden) while the permission prompt was open.
        closeCamera(stream);
        return;
      }
      this.stream = stream;
      this.cameraWanted = this.settings.cameraId;
      this.stream?.getVideoTracks()[0]?.addEventListener('ended', this.onCameraEnded);
      if (!MOCK) {
        void this.refreshCameras();
        navigator.mediaDevices?.addEventListener?.('devicechange', this.onDeviceChange);
      }
      stage.setBootProgress({ stage: 'camera', label: 'Camera on', loaded: 1, total: 1, done: true });
      stage.setBootProgress({ stage: 'audio', label: 'Starting audio', loaded: 0, total: 0, done: false });
      await audioReady;
      if (this.stage !== stage) return; // left while audio was starting; teardown closed the camera
      stage.setBootProgress({ stage: 'audio', label: 'Sound ready', loaded: 1, total: 1, done: true });
      this.engine.configure(this.settings);
      // MIDI out was turned on in an earlier session: reconnect (the browser remembers the grant).
      if (this.settings.midiOut) void this.enableMidi();

      // Camera is live: reveal the stage while the models finish loading.
      this.landing?.destroy();
      this.landing = null;

      await modelsReady;
      if (this.stage !== stage) return; // the user left while the models were loading
      stage.setBootProgress(null);

      this.resizeObserver = new ResizeObserver(() => this.updatePlayZone());
      this.resizeObserver.observe(stage.viewport);
      tracker.setLowPower(this.settings.lowPower);
      tracker.start(stage.video, this.onFrame);
      this.running = true;
      this.raf = requestAnimationFrame(this.loop);
    } catch (e) {
      if (stage && this.stage !== stage) return; // the user left mid-start; nothing to report
      const err = toAppError(e);
      console.error('[orchestrator] start failed:', err.code, err.message, err.cause ?? '');
      this.teardown();
      this.showLanding(err);
    } finally {
      this.starting = false;
    }
  }

  private async exit(error?: AppError): Promise<void> {
    if (this.engine.isRecording) await this.toggleRecording();
    this.teardown();
    this.showLanding(error);
  }

  private teardown(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.tracker?.dispose();
    this.tracker = null;
    this.stream?.getVideoTracks()[0]?.removeEventListener('ended', this.onCameraEnded);
    closeCamera(this.stream, this.stage?.video);
    this.stream = null;
    this.engine.panic();
    this.engine.loop({ type: 'reset' });
    navigator.mediaDevices?.removeEventListener?.('devicechange', this.onDeviceChange);
    this.unsubscribeMidi?.();
    this.unsubscribeMidi = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.unsubscribeLoad?.();
    this.unsubscribeLoad = null;
    this.stage?.destroy();
    this.stage = null;
    this.frame = null;
    this.voices = [];
    this.zoneKey = '';
    this.gestures.reset();
    this.learn.stop();
  }

  // -------------------------------------------------------------------------------------------
  // Per-frame
  // -------------------------------------------------------------------------------------------

  private readonly onFrame = (frame: TrackingFrame): void => {
    this.frame = frame;
    this.updatePlayZone();
    this.gestures.update(frame);
    this.voices = this.engine.update(frame);
    this.updateLearn(frame.t);
  };

  private readonly loop = (): void => {
    if (!this.running || !this.stage) return;
    const frame = this.frame;
    const status: HudStatus = {
      fps: frame?.fps ?? 0,
      delegate: this.tracker?.delegate ?? null,
      hands: frame?.hands.length ?? 0,
      face: !!frame?.face,
    };
    this.stage.render({
      frame,
      voices: this.voices,
      lanes: { lead: this.engine.lanes('lead'), bass: this.engine.lanes('bass') },
      audio: { level: this.engine.level(), spectrum: this.engine.spectrum() },
      metrics: this.engine.metrics(),
      status,
      lastGesture: this.gestures.last,
      pendingGesture: this.gestures.pending,
      learn: this.learn.state,
      looper: this.engine.looper(),
    });
    this.raf = requestAnimationFrame(this.loop);
  };

  /** Keep the pitch range matched to the part of the camera picture that is actually visible. */
  private updatePlayZone(): void {
    const stage = this.stage;
    if (!stage) return;
    const vw = this.frame?.video.width || stage.video.videoWidth;
    const vh = this.frame?.video.height || stage.video.videoHeight;
    const w = stage.viewport.clientWidth;
    const h = stage.viewport.clientHeight;
    if (!vw || !vh || !w || !h) return;
    const insetTop = Math.round(stage.hudInsets?.().top ?? 0);
    const key = `${vw}x${vh}@${w}x${h}+${insetTop}`;
    if (key === this.zoneKey) return;
    this.zoneKey = key;
    // Keep the top lane clear of the top bar (matters on short landscape phones).
    const topInset = Math.max(0.1, (insetTop + 12) / h);
    this.engine.setPlayZone(playZoneFor(coverMap(vw, vh, w, h), Math.min(topInset, 0.35)));
  }

  // -------------------------------------------------------------------------------------------
  // Controls
  // -------------------------------------------------------------------------------------------

  private applySettings(patch: Partial<Settings>): void {
    this.settings = sanitizeSettings({ ...this.settings, ...patch }, this.instrumentIds);
    saveSettings(this.settings);
    this.engine.configure(this.settings);
    this.tracker?.setLowPower(this.settings.lowPower);
    this.stage?.setSettings(this.settings);
    if (this.running && !MOCK && this.settings.cameraId !== this.cameraWanted) void this.switchCamera(this.settings.cameraId);
  }

  // -------------------------------------------------------------------------------------------
  // Looper, MIDI, cameras
  // -------------------------------------------------------------------------------------------

  private loopCommand(cmd: LoopCommand): void {
    const label = this.engine.loop(cmd);
    // The panel shows mute / solo / clear; say the rest out loud.
    if (label && (cmd.type === 'record' || cmd.type === 'undo' || cmd.type === 'clear-all' || cmd.type === 'stop')) this.stage?.toast(label);
  }

  private async enableMidi(): Promise<void> {
    const st = await this.engine.enableMidi();
    this.stage?.setMidiStatus(st);
  }

  /** The remembered camera, or the default one when it is gone (and forget it then). */
  private async openPreferredCamera(video: HTMLVideoElement): Promise<MediaStream> {
    const id = this.settings.cameraId;
    if (!id) return openCamera(video);
    try {
      return await openCamera(video, id);
    } catch (e) {
      if (!(e instanceof AppError) || e.code !== 'camera-not-found') throw e;
      this.forgetCamera();
      window.setTimeout(() => this.stage?.toast('Your chosen camera is not connected. Using the default camera.'), 600);
      return openCamera(video);
    }
  }

  /** Back to the default camera in the settings, without reopening anything. */
  private forgetCamera(): void {
    this.cameraWanted = '';
    this.settings = sanitizeSettings({ ...this.settings, cameraId: '' }, this.instrumentIds);
    saveSettings(this.settings);
    this.stage?.setSettings(this.settings);
  }

  private async refreshCameras(): Promise<void> {
    const list = await listCameras();
    this.stage?.setCameras(list);
  }

  /**
   * Reopens the stream on another camera. The tracker and the audio keep running: the tracker
   * just restarts its frame loop on the same <video>, so no model is reloaded.
   */
  private async switchCamera(deviceId: string): Promise<void> {
    this.cameraWanted = deviceId;
    while (this.cameraBusy) await this.cameraBusy;
    const stage = this.stage;
    const tracker = this.tracker;
    if (!stage || !tracker || !this.running || deviceId !== this.cameraWanted) return;
    if (cameraIdOf(this.stream) === deviceId && deviceId) return;
    const run = (async () => {
      this.stream?.getVideoTracks()[0]?.removeEventListener('ended', this.onCameraEnded);
      tracker.stop();
      // Phones cannot open two cameras at once: release the old one first.
      closeCamera(this.stream, stage.video);
      this.stream = null;
      try {
        this.stream = await this.openPreferredCamera(stage.video);
      } catch (e) {
        try {
          this.stream = await openCamera(stage.video);
          this.stage?.toast('That camera could not start. Back on the default camera.');
          this.forgetCamera();
        } catch {
          if (this.stage === stage) void this.exit(toAppError(e));
          return;
        }
      }
      if (this.stage !== stage || !this.running) {
        closeCamera(this.stream, undefined);
        this.stream = null;
        return;
      }
      this.cameraWanted = this.settings.cameraId;
      this.stream.getVideoTracks()[0]?.addEventListener('ended', this.onCameraEnded);
      this.zoneKey = '';
      tracker.start(stage.video, this.onFrame);
      void this.refreshCameras();
    })();
    this.cameraBusy = run;
    try {
      await run;
    } finally {
      this.cameraBusy = null;
    }
  }

  private readonly onDeviceChange = (): void => {
    void this.refreshCameras();
  };

  private async toggleRecording(): Promise<void> {
    if (!this.engine.isRecording) {
      try {
        this.engine.startRecording();
        this.stage?.setRecording(true);
      } catch (e) {
        this.stage?.toast(`Recording is not available: ${toAppError(e).message}`);
      }
      return;
    }
    this.stage?.setRecording(false);
    try {
      const rec = await this.engine.stopRecording();
      if (rec.blob.size === 0) {
        this.stage?.toast('Nothing was recorded.');
        return;
      }
      download(rec.blob, `orchestrator-${stamp()}.${rec.extension}`);
      const secs = Math.round(rec.durationMs / 1000);
      this.stage?.toast(`Saved your ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')} take`);
    } catch (e) {
      this.stage?.toast(`Could not save the recording: ${toAppError(e).message}`);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Learn mode
  // -------------------------------------------------------------------------------------------

  /** Start (or restart) a song with its lane setup, or stop learning. Nothing is restored after. */
  private setLearn(songId: string | null, mode?: LearnMode): void {
    if (!songId) {
      this.learn.stop();
      return;
    }
    const patch = this.learn.start(songId, mode, this.settings.countIn);
    if (patch) this.applySettings(patch);
  }

  private updateLearn(t: number): void {
    if (!this.learn.state) return;
    let lead: VoiceState | null = null;
    // Chords mode has no lead lanes: pause judging until the user is back in melody mode.
    if (this.settings.mode === 'melody') for (const v of this.voices) if (v.voice === 'lead') lead = v;
    if (this.learn.update(lead, this.engine.lanes('lead'), t)) this.stage?.setSongs(this.learn.songs());
  }

  // -------------------------------------------------------------------------------------------
  // Browser events
  // -------------------------------------------------------------------------------------------

  private readonly onVisibility = (): void => {
    if (!this.running) return;
    if (document.hidden) {
      // No stuck notes or a lonely beat in a background tab.
      this.engine.panic();
      this.engine.configure({ ...this.settings, groove: false });
    } else {
      this.engine.configure(this.settings);
    }
  };

  private readonly onPageHide = (): void => {
    // Release the camera when the page is hidden for good (or enters the bfcache). A take in
    // progress is dropped rather than leaking into the next session.
    if (this.engine.isRecording) void this.engine.stopRecording().catch(() => undefined);
    if (!this.stage) return;
    this.teardown();
    this.showLanding();
  };

  private readonly onCameraEnded = (): void => {
    // A picked camera was unplugged: carry on with the default one if there is one.
    if (this.settings.cameraId && this.running) {
      this.stage?.toast('The camera was disconnected. Switching to the default camera.');
      this.applySettings({ cameraId: '' });
      return;
    }
    void this.exit(new AppError('camera-not-found', 'The camera was disconnected.'));
  };
}

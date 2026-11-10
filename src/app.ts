import {
  AppError,
  type HudStatus,
  type LandingView,
  type MusicEngine,
  type Settings,
  type StageView,
  type Tracker,
  type TrackingFrame,
  type VoiceState,
} from './types';
import { closeCamera, createTracker, openCamera } from './tracking';
import { createMusicEngine } from './music';
import { mountLanding, mountStage } from './ui';
import { MockTracker } from './dev/mockTracker';
import { loadSettings, sanitizeSettings, saveSettings, settingsFromHash } from './settings';
import { coverMap, playZoneFor } from './geometry';
import { GestureController } from './gestures';

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

  constructor(private readonly root: HTMLElement) {
    this.engine = createMusicEngine();
    this.instrumentIds = this.engine.instruments.map((i) => i.id);
    this.settings = loadSettings(this.instrumentIds);
    this.gestures = new GestureController({
      getSettings: () => this.settings,
      apply: (patch) => this.applySettings(patch),
      toggleRecording: () => void this.toggleRecording(),
      isRecording: () => this.engine.isRecording,
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
    this.landing?.setBusy(true, 'Tuning the orchestra…');

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
      });
      this.stage = stage;
      stage.setInstruments(this.engine.instruments, this.engine.scales);
      stage.setSettings(this.settings);
      this.unsubscribeLoad = this.engine.onLoadState((s) => this.stage?.setLoadState(s));

      const tracker: Tracker = MOCK ? new MockTracker() : createTracker();
      this.tracker = tracker;
      const modelsReady = tracker.init((p) => this.stage?.setBootProgress(p));
      modelsReady.catch(() => undefined); // awaited below; avoid an unhandled rejection meanwhile

      stage.setBootProgress({ stage: 'camera', label: 'Waiting for camera permission', loaded: 0, total: 0, done: false });
      this.stream = MOCK ? null : await openCamera(stage.video);
      this.stream?.getVideoTracks()[0]?.addEventListener('ended', this.onCameraEnded);
      stage.setBootProgress({ stage: 'audio', label: 'Starting audio', loaded: 0, total: 0, done: false });
      await audioReady;
      this.engine.configure(this.settings);

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
  }

  // -------------------------------------------------------------------------------------------
  // Per-frame
  // -------------------------------------------------------------------------------------------

  private readonly onFrame = (frame: TrackingFrame): void => {
    this.frame = frame;
    this.updatePlayZone();
    this.gestures.update(frame);
    this.voices = this.engine.update(frame);
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
    const key = `${vw}x${vh}@${w}x${h}`;
    if (key === this.zoneKey) return;
    this.zoneKey = key;
    this.engine.setPlayZone(playZoneFor(coverMap(vw, vh, w, h)));
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
  }

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
    // Release the camera when the page is hidden for good (or enters the bfcache).
    if (!this.stage) return;
    this.teardown();
    this.showLanding();
  };

  private readonly onCameraEnded = (): void => {
    void this.exit(new AppError('camera-not-found', 'The camera was disconnected.'));
  };
}

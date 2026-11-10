import type {
  AppError,
  FrameVerdict,
  InstrumentDef,
  InstrumentLoadState,
  LeftHandRole,
  LoadProgress,
  ScaleDef,
  Settings,
  StageCallbacks,
  StageRenderData,
  StageView,
  TriggerMode,
} from '../types';
import { APP_NAME } from '../config';
import { DEFAULT_SETTINGS } from '../settings';
import { ACTION_LABEL, GESTURE_GLYPH } from '../gestures';
import { Dock, LEFT_ROLES, TRIGGERS } from './dock';
import { TextSlot, formatClock, h, setClass } from './dom';
import { buildErrorCard } from './errors';
import { HudRenderer } from './hud';
import { icon, logoMark } from './icons';
import { MetricsStrip } from './metrics';
import { buildHelp } from './help';
import { ChordDeck } from './chords';

type FrameState = FrameVerdict | 'no-face' | 'waiting';

const FRAME_TEXT: Record<FrameState, string> = {
  great: 'Perfect frame',
  good: 'Good frame',
  'no-hands': 'Raise your hand',
  'too-dark': 'Turn on a light',
  'too-bright': 'Too much backlight',
  'too-far': 'Come closer',
  'too-close': 'Move back a little',
  'hand-cut-off': 'Keep your hands inside the frame',
  unstable: 'Hold steady',
  'low-fps': 'Low frame rate: try Low power',
  'no-face': 'Face the camera',
  waiting: 'Starting camera',
};

const BOOT_STEPS: ReadonlyArray<{ stage: LoadProgress['stage']; label: string }> = [
  { stage: 'camera', label: 'Camera' },
  { stage: 'runtime', label: 'Vision runtime' },
  { stage: 'hands', label: 'Hand tracker' },
  { stage: 'face', label: 'Face tracker' },
  { stage: 'audio', label: 'Audio engine' },
];

const fullscreenSupported = (): boolean =>
  !!(document.fullscreenEnabled || (document as Document & { webkitFullscreenEnabled?: boolean }).webkitFullscreenEnabled);

function isTyping(t: EventTarget | null): boolean {
  if (!(t instanceof HTMLElement)) return false;
  return t.isContentEditable || t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA';
}

export function mountStage(root: HTMLElement, callbacks: StageCallbacks): StageView {
  return new Stage(root, callbacks);
}

class Stage implements StageView {
  readonly el: HTMLElement;
  readonly video: HTMLVideoElement;
  readonly viewport: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly instruments = new Map<string, InstrumentDef>();
  private scales: readonly ScaleDef[] = [];
  private settings: Settings = { ...DEFAULT_SETTINGS };
  private readonly hud: HudRenderer;
  private readonly metrics: MetricsStrip;
  private readonly chordDeck = new ChordDeck();
  private readonly dock: Dock;
  private readonly ro: ResizeObserver;
  private readonly bottomRo: ResizeObserver;
  private bottomH = -1;
  private destroyed = false;

  // top bar
  private readonly frameBadge: HTMLElement;
  private readonly frameText: TextSlot;
  private readonly frameFill: HTMLElement;
  private frameState: FrameState = 'waiting';
  private framePending: FrameState = 'waiting';
  private framePendingSince = 0;
  private frameScoreShown = -1;
  private readonly fpsText: TextSlot;
  private readonly gpuText: TextSlot;
  private readonly handL: HTMLElement;
  private readonly handR: HTMLElement;
  private readonly faceChip: HTMLElement;
  private readonly ecoChip: HTMLElement;
  private readonly recBtn: HTMLButtonElement;
  private readonly recTime: TextSlot;
  private readonly fsBtn: HTMLButtonElement | null;
  private lastStatusAt = 0;
  private recording = false;
  private recStart = 0;

  // overlays
  private readonly boot: HTMLElement;
  private readonly bootLabel: TextSlot;
  private readonly bootFill: HTMLElement;
  private readonly bootHint: HTMLElement;
  private readonly bootSteps = new Map<LoadProgress['stage'], HTMLElement>();
  private bootHideTimer = 0;
  private readonly coach: HTMLElement;
  private readonly coachText: TextSlot;
  private coachKey = '';
  private noHandMs = 0;
  private noGateMs = 0;
  private playedMs = 0;
  private readonly flash: HTMLElement;
  private readonly flashGlyph: TextSlot;
  private readonly flashText: TextSlot;
  private flashT = -1;
  private flashOn = false;
  private readonly help: HTMLElement;
  private readonly helpRefresh: (s: Settings) => void;
  private readonly toasts: HTMLElement;
  private readonly errorLayer: HTMLElement;
  private lastNow = 0;
  private statsAt = 0;
  private lite = false;

  constructor(root: HTMLElement, private readonly callbacks: StageCallbacks) {
    this.el = h('main', { class: 'stage', 'aria-label': `${APP_NAME} stage` });

    // ---- viewport -----------------------------------------------------------------------
    this.video = h('video', { class: 'cam', muted: true, playsinline: true, 'webkit-playsinline': true, autoplay: true, 'aria-hidden': 'true' });
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.autoplay = true;
    this.canvas = h('canvas', { class: 'hud', 'aria-hidden': 'true' });
    this.viewport = h('div', { class: 'viewport' }, this.video, h('div', { class: 'cam-shade', 'aria-hidden': 'true' }), this.canvas);
    this.hud = new HudRenderer(this.canvas, this.instruments);

    // ---- top bar ------------------------------------------------------------------------
    const brand = h('div', { class: 'tb-brand' });
    brand.append(logoMark(), h('span', { class: 'tb-name', text: APP_NAME }));

    this.frameText = new TextSlot(h('span', { class: 'fb-text', text: FRAME_TEXT.waiting }));
    this.frameFill = h('span', { class: 'fb-fill' });
    this.frameBadge = h(
      'div',
      { class: 'frame-badge is-wait', role: 'status', 'aria-live': 'polite', title: 'Framing quality' },
      h('span', { class: 'fb-dot', 'aria-hidden': 'true' }),
      this.frameText.el,
      h('span', { class: 'fb-meter', 'aria-hidden': 'true' }, this.frameFill),
    );
    this.fpsText = new TextSlot(h('span', { class: 'mono', text: '--' }));
    this.gpuText = new TextSlot(h('span', { class: 'mono', text: '···' }));
    const fpsChip = h('span', { class: 'chip-s hide-sm', title: 'Tracking frames per second' }, this.fpsText.el, h('span', { class: 'chip-unit', text: 'FPS' }));
    const gpuChip = h('span', { class: 'chip-s hide-sm', title: 'Tracking runs on' }, this.gpuText.el);
    this.handL = h('span', { class: 'hand-ind', text: 'L', title: 'Left hand' });
    this.handR = h('span', { class: 'hand-ind', text: 'R', title: 'Right hand' });
    const handsChip = h('span', { class: 'chip-s chip-hands', 'aria-label': 'Hands detected' });
    handsChip.append(icon('hand'), this.handL, this.handR);
    this.faceChip = h('span', { class: 'chip-s chip-face', title: 'Face detected' });
    this.faceChip.append(icon('face'));
    this.ecoChip = h('span', { class: 'chip-s chip-eco', text: 'ECO', title: 'Reduced effects to keep things smooth', hidden: true });
    const status = h('div', { class: 'tb-status' }, this.frameBadge, fpsChip, gpuChip, handsChip, this.faceChip, this.ecoChip);

    this.recTime = new TextSlot(h('span', { class: 'rec-time mono', text: 'REC' }));
    this.recBtn = h('button', { type: 'button', class: 'rec-btn', 'aria-pressed': 'false', 'aria-label': 'Start recording (R)' });
    this.recBtn.append(h('span', { class: 'rec-dot', 'aria-hidden': 'true' }), this.recTime.el);
    this.recBtn.addEventListener('click', () => callbacks.onRecordToggle());

    const helpBtn = this.iconButton('help', 'Help and gestures (H)', () => this.toggleHelp());
    this.fsBtn = fullscreenSupported() ? this.iconButton('expand', 'Fullscreen (F)', () => void this.toggleFullscreen()) : null;
    if (this.fsBtn) this.fsBtn.classList.add('hide-sm');
    const settingsBtn = this.iconButton('settings', 'Settings', () => (this.dock.isOpen ? this.dock.close() : this.dock.open('play')));
    const exitBtn = this.iconButton('exit', 'Exit to the start page', () => callbacks.onExit());
    exitBtn.classList.add('exit-btn');
    const actions = h('div', { class: 'tb-actions' }, this.recBtn, helpBtn, this.fsBtn, settingsBtn, exitBtn);
    const topbar = h('header', { class: 'topbar' }, brand, status, actions);

    // ---- coach + flash ------------------------------------------------------------------
    this.coachText = new TextSlot(h('span', { class: 'coach-text' }));
    this.coach = h('div', { class: 'coach', role: 'status', 'aria-live': 'polite' }, h('span', { class: 'coach-icon', 'aria-hidden': 'true' }), this.coachText.el);
    this.flashGlyph = new TextSlot(h('span', { class: 'flash-glyph', 'aria-hidden': 'true' }));
    this.flashText = new TextSlot(h('span', { class: 'flash-text' }));
    this.flash = h('div', { class: 'flash', role: 'status', 'aria-live': 'polite' }, this.flashGlyph.el, this.flashText.el);

    // ---- bottom: metrics + dock ---------------------------------------------------------
    this.metrics = new MetricsStrip(this.instruments);
    this.dock = new Dock({ callbacks, toast: (m) => this.toast(m) });
    const bottom = h('div', { class: 'bottom' }, this.chordDeck.el, this.metrics.el, this.dock.dock);

    // ---- boot overlay -------------------------------------------------------------------
    this.bootLabel = new TextSlot(h('p', { class: 'boot-label' }));
    this.bootFill = h('span', { class: 'boot-fill' });
    this.bootHint = h('p', { class: 'boot-hint' });
    this.bootHint.append(icon('camera'), h('span', { text: 'Allow camera access when your browser asks. The video stays on this device.' }));
    const stepList = h('ol', { class: 'boot-steps' });
    for (const s of BOOT_STEPS) {
      const li = h('li', { class: 'boot-step' }, h('span', { class: 'boot-tick', 'aria-hidden': 'true' }), h('span', { text: s.label }));
      this.bootSteps.set(s.stage, li);
      stepList.append(li);
    }
    const bootCard = h(
      'div',
      { class: 'boot-card glass' },
      h('div', { class: 'boot-orb', 'aria-hidden': 'true' }),
      h('h2', { class: 'boot-title', text: 'Tuning the orchestra' }),
      this.bootLabel.el,
      h('div', { class: 'boot-bar', role: 'progressbar', 'aria-label': 'Loading' }, this.bootFill),
      stepList,
      this.bootHint,
    );
    this.boot = h('div', { class: 'boot', role: 'status', 'aria-live': 'polite', hidden: true }, bootCard);

    // ---- help, toasts, errors -----------------------------------------------------------
    const helpParts = buildHelp(() => this.toggleHelp(false));
    this.help = helpParts.el;
    this.helpRefresh = helpParts.refresh;
    this.toasts = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'false' });
    this.errorLayer = h('div', { class: 'stage-error', hidden: true });

    this.el.append(this.viewport, topbar, this.coach, this.flash, bottom, this.dock.scrim, this.dock.sheet, this.boot, this.help, this.errorLayer, this.toasts);
    root.append(this.el);

    // ---- wiring -------------------------------------------------------------------------
    this.ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const r = e.contentRect;
        this.hud.resize(r.width, r.height);
      }
    });
    this.ro.observe(this.viewport);
    // The camera view (and so the play zone) ends where the bottom controls begin, so the lowest
    // notes are never hidden behind the metrics strip or the dock.
    this.bottomRo = new ResizeObserver(() => {
      const hgt = Math.round(bottom.getBoundingClientRect().height);
      if (hgt !== this.bottomH) {
        this.bottomH = hgt;
        this.el.style.setProperty('--bottom-h', `${hgt}px`);
      }
    });
    this.bottomRo.observe(bottom);
    const r = this.viewport.getBoundingClientRect();
    this.hud.resize(r.width || window.innerWidth, r.height || window.innerHeight);
    document.fonts?.ready.then(() => !this.destroyed && this.hud.invalidateText()).catch(() => undefined);
    window.addEventListener('keydown', this.onKey);
    document.addEventListener('fullscreenchange', this.onFullscreen);
  }

  // -------------------------------------------------------------------------------------------
  // StageView
  // -------------------------------------------------------------------------------------------

  setInstruments(list: readonly InstrumentDef[], scales: readonly ScaleDef[]): void {
    this.instruments.clear();
    for (const i of list) this.instruments.set(i.id, i);
    this.scales = scales;
    this.dock.setInstruments(list, scales);
    this.metrics.setScale(this.settings, scales);
    this.hud.invalidateText();
  }

  setSettings(s: Settings): void {
    this.settings = s;
    this.dock.setSettings(s);
    this.metrics.setScale(s, this.scales);
    this.hud.setLowPower(s.lowPower);
    this.helpRefresh(s);
    this.chordDeck.setVisible(s.mode === 'chords');
    setClass(this.el, 'is-chords', s.mode === 'chords');
    this.syncLite();
  }

  setBootProgress(p: LoadProgress | null): void {
    window.clearTimeout(this.bootHideTimer);
    if (!p) {
      this.boot.classList.add('is-leaving');
      this.bootHideTimer = window.setTimeout(() => {
        this.boot.hidden = true;
        this.boot.classList.remove('is-leaving');
      }, 400);
      return;
    }
    this.boot.hidden = false;
    this.boot.classList.remove('is-leaving');
    this.bootLabel.set(p.label);
    const idx = BOOT_STEPS.findIndex((s) => s.stage === p.stage);
    BOOT_STEPS.forEach((s, i) => {
      const li = this.bootSteps.get(s.stage)!;
      // Models load in parallel with the camera prompt, so mark by explicit completion too.
      const done = li.classList.contains('is-done') || (p.stage === s.stage && p.done) || (i < idx && s.stage === 'camera');
      setClass(li, 'is-done', done);
      setClass(li, 'is-active', p.stage === s.stage && !p.done);
    });
    const doneCount = BOOT_STEPS.filter((s) => this.bootSteps.get(s.stage)!.classList.contains('is-done')).length;
    const within = p.total > 0 ? Math.min(1, p.loaded / p.total) : p.done ? 1 : 0.35;
    const frac = Math.min(1, (doneCount + (p.done ? 0 : within)) / BOOT_STEPS.length);
    this.bootFill.style.transform = `scaleX(${Math.max(0.04, frac)})`;
    this.bootHint.hidden = !(p.stage === 'camera' && !p.done);
  }

  setLoadState(s: InstrumentLoadState): void {
    this.dock.setLoadState(s);
    if (s.error) this.toast(`Couldn’t load ${this.instruments.get(s.id)?.name ?? s.id}. Try another instrument.`);
  }

  setRecording(on: boolean): void {
    this.recording = on;
    this.recStart = performance.now();
    this.recBtn.setAttribute('aria-pressed', String(on));
    this.recBtn.setAttribute('aria-label', on ? 'Stop recording (R)' : 'Start recording (R)');
    setClass(this.recBtn, 'is-on', on);
    this.recTime.set(on ? '0:00' : 'REC');
  }

  render(data: StageRenderData): void {
    if (this.destroyed) return;
    const now = performance.now();
    const dt = this.lastNow ? Math.min(100, now - this.lastNow) : 16;
    this.lastNow = now;
    const s = this.settings;

    this.hud.draw(data, s, now);
    this.metrics.update(data, s, now);
    this.chordDeck.update(data.metrics, s);
    this.updateStatus(data, now);
    this.updateCoach(data, dt);
    this.updateFlash(data, now);
    if (this.recording) this.recTime.set(formatClock(now - this.recStart));
    if (this.hud.stats.degraded !== this.lite) this.syncLite();
    if (now - this.statsAt > 1000) {
      this.statsAt = now;
      this.el.dataset.hudMs = this.hud.stats.drawMs.toFixed(2);
      this.el.dataset.frameMs = this.hud.stats.frameMs.toFixed(1);
    }
  }

  showError(err: AppError): void {
    const dismiss = h('button', { type: 'button', class: 'btn', text: 'Dismiss' });
    dismiss.addEventListener('click', () => {
      this.errorLayer.hidden = true;
      this.errorLayer.replaceChildren();
    });
    const exit = h('button', { type: 'button', class: 'btn btn-primary', text: 'Back to start' });
    exit.addEventListener('click', () => this.callbacks.onExit());
    const card = buildErrorCard(err);
    card.append(h('div', { class: 'btn-row' }, dismiss, exit));
    this.errorLayer.replaceChildren(card);
    this.errorLayer.hidden = false;
    exit.focus();
  }

  toast(message: string): void {
    const t = h('div', { class: 'toast glass', text: message });
    this.toasts.append(t);
    while (this.toasts.children.length > 3) this.toasts.firstElementChild?.remove();
    const ttl = Math.min(7000, 2600 + message.length * 40);
    window.setTimeout(() => {
      t.classList.add('is-leaving');
      window.setTimeout(() => t.remove(), 300);
    }, ttl);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.ro.disconnect();
    this.bottomRo.disconnect();
    window.removeEventListener('keydown', this.onKey);
    document.removeEventListener('fullscreenchange', this.onFullscreen);
    window.clearTimeout(this.bootHideTimer);
    this.dock.destroy();
    this.hud.destroy();
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    this.video.pause();
    this.video.srcObject = null;
    this.video.removeAttribute('src');
    this.el.remove();
  }

  // -------------------------------------------------------------------------------------------

  private iconButton(name: Parameters<typeof icon>[0], label: string, onClick: () => void): HTMLButtonElement {
    const b = h('button', { type: 'button', class: 'icon-btn', 'aria-label': label, title: label });
    b.append(icon(name));
    b.addEventListener('click', onClick);
    return b;
  }

  /** Lite mode: no backdrop blur over the live video (expensive on phones) and fewer effects. */
  private syncLite(): void {
    this.lite = this.settings.lowPower || this.hud.stats.degraded;
    setClass(this.el, 'is-lite', this.lite);
    this.ecoChip.hidden = !this.lite;
  }

  private updateStatus(data: StageRenderData, now: number): void {
    const f = data.frame;
    // FRAME badge: verdict from the tracker (already smoothed); 'no-face' added in mouth mode.
    let state: FrameState = 'waiting';
    if (f) {
      const q = f.quality;
      state = q.ideal ? 'great' : q.verdict;
      if (this.settings.trigger === 'mouth' && !f.face && (state === 'great' || state === 'good')) state = 'no-face';
    }
    if (state !== this.framePending) {
      this.framePending = state;
      this.framePendingSince = now;
    }
    // Small dwell so a single odd frame never flips the badge.
    if (state !== this.frameState && now - this.framePendingSince > 350) {
      this.frameState = state;
      this.frameText.set(FRAME_TEXT[state]);
      const tone = state === 'great' ? 'is-good' : state === 'good' ? 'is-ok' : state === 'waiting' ? 'is-wait' : f && f.quality.score < 0.45 ? 'is-bad' : 'is-warn';
      for (const c of ['is-good', 'is-ok', 'is-warn', 'is-bad', 'is-wait']) setClass(this.frameBadge, c, c === tone);
    }
    if (f) {
      const sc = Math.round(f.quality.score * 50) / 50;
      if (sc !== this.frameScoreShown) {
        this.frameScoreShown = sc;
        this.frameFill.style.transform = `scaleX(${sc})`;
      }
    }

    if (now - this.lastStatusAt < 250) return;
    this.lastStatusAt = now;
    const st = data.status;
    this.fpsText.set(st.fps ? String(Math.round(st.fps)) : '--');
    this.gpuText.set(st.delegate ?? '···');
    let l = false;
    let r = false;
    for (const hand of f?.hands ?? []) {
      if (hand.side === 'left') l = true;
      else r = true;
    }
    setClass(this.handL, 'on', l);
    setClass(this.handR, 'on', r);
    setClass(this.faceChip, 'on', st.face);
  }

  private updateCoach(data: StageRenderData, dt: number): void {
    const f = data.frame;
    const s = this.settings;
    let lead = null;
    for (const v of data.voices) if (v.voice === 'lead') lead = v;
    const hands = f?.hands.length ?? 0;
    this.noHandMs = hands ? 0 : this.noHandMs + dt;
    if (lead?.gate) {
      this.playedMs += dt;
      this.noGateMs = 0;
    } else if (hands) this.noGateMs += dt;
    else this.noGateMs = 0;

    let key = '';
    if (f) {
      if (s.trigger === 'mouth' && this.hud.noFaceMs > 2000) key = 'face';
      else if (this.noHandMs > 900) key = 'hand';
      else if (s.trigger === 'mouth' && this.noGateMs > 1400 && this.playedMs < 4000) key = 'mouth';
      else if (s.trigger === 'pinch' && this.noGateMs > 1400 && this.playedMs < 4000) key = 'pinch';
    }
    if (key === this.coachKey) return;
    this.coachKey = key;
    const text =
      key === 'face'
        ? 'Can’t see your face — face the camera or switch Trigger to Pinch'
        : key === 'hand'
          ? 'Raise your right hand'
          : key === 'mouth'
            ? 'Open your mouth to play'
            : key === 'pinch'
              ? 'Pinch thumb and index to play'
              : '';
    if (text) this.coachText.set(text);
    this.coach.dataset.kind = key;
    setClass(this.coach, 'is-on', !!text);
  }

  private updateFlash(data: StageRenderData, now: number): void {
    const g = data.lastGesture;
    if (g && g.t !== this.flashT) {
      this.flashT = g.t;
      this.flashGlyph.set(GESTURE_GLYPH[g.gesture]);
      const base = ACTION_LABEL[g.action];
      const text = g.action === 'next-instrument' || g.action === 'prev-instrument' ? `${base}: ${g.label}` : g.label || base;
      this.flashText.set(text);
      this.flash.classList.remove('is-on');
      void this.flash.offsetWidth; // restart the animation
      this.flash.classList.add('is-on');
      this.flashOn = true;
    } else if (this.flashOn && g && now - g.t > 1300) {
      this.flashOn = false;
      this.flash.classList.remove('is-on');
    }
  }

  private toggleHelp(force?: boolean): void {
    const open = force ?? this.help.hidden;
    if (open) {
      this.dock.close();
      this.helpRefresh(this.settings);
      this.help.hidden = false;
      this.help.querySelector<HTMLElement>('.help-close')?.focus();
    } else if (!this.help.hidden) {
      this.help.hidden = true;
    }
  }

  private async toggleFullscreen(): Promise<void> {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    } catch {
      this.toast('Fullscreen is not available here');
    }
  }

  private readonly onFullscreen = (): void => {
    if (!this.fsBtn) return;
    const on = !!document.fullscreenElement;
    this.fsBtn.replaceChildren(icon(on ? 'shrink' : 'expand'));
    this.fsBtn.setAttribute('aria-label', on ? 'Exit fullscreen (F)' : 'Fullscreen (F)');
  };

  private readonly onKey = (e: KeyboardEvent): void => {
    if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Escape') {
      if (!this.help.hidden) this.toggleHelp(false);
      else if (this.dock.isOpen) this.dock.close();
      else if (!this.errorLayer.hidden) this.errorLayer.hidden = true;
      return;
    }
    if (isTyping(e.target)) return;
    const s = this.settings;
    const set = (patch: Partial<Settings>): void => this.callbacks.onSettings(patch);
    switch (e.key) {
      case 'r':
      case 'R':
        this.callbacks.onRecordToggle();
        break;
      case 'g':
      case 'G':
        set({ groove: !s.groove });
        this.toast(s.groove ? 'Beat off' : 'Beat on');
        break;
      case 'ArrowUp':
        set({ octave: Math.min(2, s.octave + 1) });
        break;
      case 'ArrowDown':
        set({ octave: Math.max(-2, s.octave - 1) });
        break;
      case 't':
      case 'T': {
        const i = TRIGGERS.findIndex((t) => t.id === s.trigger);
        const next = TRIGGERS[(i + 1) % TRIGGERS.length]!;
        set({ trigger: next.id as TriggerMode });
        this.toast(`Trigger: ${next.label}`);
        break;
      }
      case 'l':
      case 'L': {
        const i = LEFT_ROLES.findIndex((r) => r.id === s.leftHand);
        const next = LEFT_ROLES[(i + 1) % LEFT_ROLES.length]!;
        set({ leftHand: next.id as LeftHandRole });
        this.toast(`Left hand: ${next.label}`);
        break;
      }
      case 'h':
      case 'H':
      case '?':
        this.toggleHelp();
        break;
      case 'f':
      case 'F':
        if (this.fsBtn) void this.toggleFullscreen();
        break;
      default:
        return;
    }
    e.preventDefault();
  };
}

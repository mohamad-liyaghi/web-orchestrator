/**
 * Looper panel: four track lanes (recorded notes as a mini piano roll, a playhead, a pulse when
 * the track plays), record arm with the take progress, mute / solo / clear, loop length, undo and
 * clear all. Lanes redraw only when the recorded content changes; per frame only the playheads
 * move (transforms) and a few classes flip.
 */
import type { InstrumentDef, LoopBars, LoopCommand, LooperState, LoopTrackState } from '../types';
import { LOOP_BARS } from '../settings';
import { TextSlot, h, setClass } from './dom';
import { icon } from './icons';

/** Accent of each track lane (notes take their instrument's color). */
export const TRACK_COLORS = ['#3cf2ff', '#ff3dcb', '#ffb547', '#b6ff5c'] as const;

interface LooperDeps {
  onLoop(cmd: LoopCommand): void;
  onBars(bars: LoopBars): void;
  instruments: ReadonlyMap<string, InstrumentDef>;
}

interface TrackView {
  row: HTMLElement;
  rec: HTMLButtonElement;
  lane: HTMLElement;
  canvas: HTMLCanvasElement;
  head: HTMLElement;
  info: TextSlot;
  mute: HTMLButtonElement;
  solo: HTMLButtonElement;
  clear: HTMLButtonElement;
  drawn: readonly unknown[] | null;
  w: number;
  h: number;
  progress: number;
  pulse: number;
  take: number;
  key: string;
}

const MAX_DPR = 2;

export class LooperPanel {
  readonly el: HTMLElement;
  private readonly tracks: TrackView[] = [];
  private readonly status: TextSlot;
  private readonly count: TextSlot;
  private readonly countEl: HTMLElement;
  private readonly undoBtn: HTMLButtonElement;
  private readonly clearAllBtn: HTMLButtonElement;
  private readonly barBtns: HTMLButtonElement[] = [];
  private readonly ro: ResizeObserver;
  private open = false;
  private version = -1;
  private bars: LoopBars = 2;
  private phase = '';
  private recordTrack = -2;
  private countIn = -1;
  private tenths = -1;

  constructor(private readonly deps: LooperDeps) {
    this.status = new TextSlot(h('span', { class: 'lp-status' }));
    this.count = new TextSlot(h('span', { class: 'lp-count-n mono' }));
    this.countEl = h('span', { class: 'lp-count', 'aria-hidden': 'true' }, this.count.el);

    const bars = h('div', { class: 'seg lp-bars', role: 'radiogroup', 'aria-label': 'Loop length in bars' });
    for (const b of LOOP_BARS) {
      const btn = h('button', { type: 'button', class: 'seg-btn', role: 'radio', 'aria-checked': 'false', 'data-value': b, text: String(b), title: `${b} bar${b === 1 ? '' : 's'}` });
      btn.addEventListener('click', () => deps.onBars(b));
      bars.append(btn);
      this.barBtns.push(btn);
    }
    const barsWrap = h('div', { class: 'lp-bars-wrap' }, h('span', { class: 'lp-label', text: 'Bars' }), bars);

    this.undoBtn = this.iconBtn('undo', 'Undo last take (Backspace)', () => deps.onLoop({ type: 'undo' }));
    this.clearAllBtn = this.iconBtn('trash', 'Clear all loops', () => deps.onLoop({ type: 'clear-all' }));
    const head = h(
      'div',
      { class: 'lp-head' },
      h('span', { class: 'lp-title' }, icon('loop'), h('span', { text: 'Loop' })),
      this.status.el,
      this.countEl,
      h('span', { class: 'lp-spacer' }),
      barsWrap,
      this.undoBtn,
      this.clearAllBtn,
    );

    const list = h('div', { class: 'lp-tracks' });
    for (let i = 0; i < 4; i++) list.append(this.buildTrack(i));

    this.el = h('section', { class: 'looper glass', 'aria-label': 'Looper', hidden: true }, head, list);
    this.ro = new ResizeObserver(() => {
      for (const t of this.tracks) this.sizeLane(t);
    });
    for (const t of this.tracks) this.ro.observe(t.lane);
  }

  get isOpen(): boolean {
    return this.open;
  }

  setOpen(on: boolean): void {
    if (on === this.open) return;
    this.open = on;
    this.el.hidden = !on;
    if (on) {
      this.version = -1; // repaint lanes at their new size
      for (const t of this.tracks) this.sizeLane(t);
    }
  }

  setBars(bars: LoopBars): void {
    this.bars = bars;
    for (const b of this.barBtns) {
      const on = Number(b.dataset.value) === bars;
      b.setAttribute('aria-checked', String(on));
      setClass(b, 'is-on', on);
    }
  }

  /** Once per animation frame while open. */
  update(st: LooperState): void {
    if (!this.open) return;
    const contentChanged = st.version !== this.version;
    this.version = st.version;

    // Header: only when something it shows changed (no string building per frame).
    const tenths = Math.round(st.seconds * 10);
    if (contentChanged || st.phase !== this.phase || st.recordTrack !== this.recordTrack || st.countIn !== this.countIn || tenths !== this.tenths) {
      this.phase = st.phase;
      this.recordTrack = st.recordTrack;
      this.countIn = st.countIn;
      this.tenths = tenths;
      setClass(this.el, 'is-countin', st.phase === 'count-in');
      setClass(this.el, 'is-rec', st.phase === 'recording');
      this.count.set(st.countIn ? String(st.countIn) : '');
      this.countEl.hidden = st.phase !== 'count-in';
      this.status.set(this.statusText(st));
      this.undoBtn.disabled = !st.canUndo;
      let any = false;
      for (const t of st.tracks) if (t.notes > 0) any = true;
      this.clearAllBtn.disabled = !any && st.phase !== 'recording';
    }

    for (let i = 0; i < this.tracks.length; i++) {
      const tv = this.tracks[i]!;
      const ts = st.tracks[i];
      if (!ts) continue;
      if (contentChanged) this.syncTrack(tv, ts, st);
      if (ts.view !== tv.drawn) this.draw(tv, ts);
      // Playhead: one transform per lane, only when it moved.
      const p = st.phase === 'idle' ? 0 : st.progress;
      if (Math.abs(p - tv.progress) > 0.0015) {
        tv.progress = p;
        tv.head.style.transform = `translateX(${(p * 100).toFixed(2)}%)`;
      }
      const pulse = Math.round(ts.pulse * 10) / 10;
      if (pulse !== tv.pulse) {
        tv.pulse = pulse;
        tv.lane.style.setProperty('--pulse', String(pulse));
      }
      const take = ts.recording && st.phase === 'recording' ? Math.round(st.takeProgress * 100) / 100 : 0;
      if (take !== tv.take) {
        tv.take = take;
        tv.rec.style.setProperty('--take', String(take));
      }
    }
  }

  destroy(): void {
    this.ro.disconnect();
    this.el.remove();
  }

  // -------------------------------------------------------------------------------------------

  private statusText(st: LooperState): string {
    const len = `${st.bars} bar${st.bars === 1 ? '' : 's'} · ${st.seconds.toFixed(1)} s`;
    switch (st.phase) {
      case 'count-in':
        return `Loop ${st.recordTrack + 1} starts in`;
      case 'recording':
        return `Recording loop ${st.recordTrack + 1}`;
      case 'playing':
        return len;
      default:
        return `Press 1–4 to record · ${len}`;
    }
  }

  private iconBtn(name: Parameters<typeof icon>[0], label: string, onClick: () => void): HTMLButtonElement {
    const b = h('button', { type: 'button', class: 'lp-btn', 'aria-label': label, title: label });
    b.append(icon(name));
    b.addEventListener('click', onClick);
    return b;
  }

  private buildTrack(i: number): HTMLElement {
    const color = TRACK_COLORS[i]!;
    const rec = h('button', { type: 'button', class: 'lp-rec', 'aria-pressed': 'false', 'aria-label': `Record loop ${i + 1} (${i + 1})`, title: `Record loop ${i + 1} (${i + 1})` });
    rec.append(h('span', { class: 'lp-rec-ring', 'aria-hidden': 'true' }), h('span', { class: 'lp-rec-n mono', text: String(i + 1) }));
    rec.addEventListener('click', () => this.deps.onLoop({ type: 'record', track: i }));
    const canvas = h('canvas', { class: 'lp-canvas', 'aria-hidden': 'true' });
    const head = h('span', { class: 'lp-playhead', 'aria-hidden': 'true' });
    const info = new TextSlot(h('span', { class: 'lp-info' }));
    const lane = h('div', { class: 'lp-lane', role: 'img', 'aria-label': `Loop ${i + 1}: empty` }, canvas, head, info.el);
    const mute = h('button', { type: 'button', class: 'lp-tog', 'aria-pressed': 'false', text: 'M', 'aria-label': `Mute loop ${i + 1}`, title: `Mute loop ${i + 1}` });
    mute.addEventListener('click', () => this.deps.onLoop({ type: 'mute', track: i }));
    const solo = h('button', { type: 'button', class: 'lp-tog lp-solo', 'aria-pressed': 'false', text: 'S', 'aria-label': `Solo loop ${i + 1}`, title: `Solo loop ${i + 1}` });
    solo.addEventListener('click', () => this.deps.onLoop({ type: 'solo', track: i }));
    const clear = h('button', { type: 'button', class: 'lp-tog lp-clear', 'aria-label': `Clear loop ${i + 1}`, title: `Clear loop ${i + 1}` });
    clear.append(icon('close'));
    clear.addEventListener('click', () => this.deps.onLoop({ type: 'clear', track: i }));
    const row = h('div', { class: 'lp-track is-empty' }, rec, lane, mute, solo, clear);
    row.style.setProperty('--c', color);
    this.tracks.push({ row, rec, lane, canvas, head, info, mute, solo, clear, drawn: null, w: 0, h: 0, progress: -1, pulse: -1, take: -1, key: '' });
    return row;
  }

  private syncTrack(tv: TrackView, ts: LoopTrackState, st: LooperState): void {
    const key = `${ts.notes}:${ts.muted}:${ts.solo}:${ts.audible}:${ts.recording}:${st.phase}:${ts.instruments.join(',')}`;
    if (key === tv.key) return;
    tv.key = key;
    const empty = ts.notes === 0;
    setClass(tv.row, 'is-empty', empty);
    setClass(tv.row, 'is-muted', ts.muted || (!empty && !ts.audible));
    setClass(tv.row, 'is-armed', ts.recording && st.phase === 'count-in');
    setClass(tv.row, 'is-recording', ts.recording && st.phase === 'recording');
    tv.rec.setAttribute('aria-pressed', String(ts.recording));
    tv.mute.setAttribute('aria-pressed', String(ts.muted));
    tv.solo.setAttribute('aria-pressed', String(ts.solo));
    tv.mute.disabled = tv.solo.disabled = tv.clear.disabled = empty;
    const names = ts.instruments.map((id) => this.deps.instruments.get(id)?.name ?? id);
    const label = ts.recording ? (st.phase === 'count-in' ? 'Get ready…' : 'Recording…') : empty ? 'Empty' : names.join(' + ');
    tv.info.set(label);
    tv.lane.setAttribute('aria-label', `Loop ${ts.index + 1}: ${empty ? 'empty' : `${ts.notes} notes, ${names.join(', ')}${ts.muted ? ', muted' : ''}${ts.solo ? ', solo' : ''}`}`);
  }

  private sizeLane(tv: TrackView): void {
    const r = tv.lane.getBoundingClientRect();
    const w = Math.round(r.width);
    const hgt = Math.round(r.height);
    if (!w || !hgt || (w === tv.w && hgt === tv.h)) return;
    tv.w = w;
    tv.h = hgt;
    const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
    tv.canvas.width = Math.round(w * dpr);
    tv.canvas.height = Math.round(hgt * dpr);
    tv.drawn = null; // redraw at the new size
  }

  private draw(tv: TrackView, ts: LoopTrackState): void {
    tv.drawn = ts.view;
    const c = tv.canvas;
    const ctx = c.getContext('2d');
    if (!ctx || !c.width || !c.height) return;
    const W = c.width;
    const H = c.height;
    ctx.clearRect(0, 0, W, H);
    // Beat grid: faint beats, brighter bar lines.
    const beats = this.bars * 4;
    for (let b = 1; b < beats; b++) {
      const x = Math.round((b / beats) * W) + 0.5;
      ctx.fillStyle = b % 4 === 0 ? 'rgba(200,210,255,0.16)' : 'rgba(200,210,255,0.06)';
      ctx.fillRect(x, 0, 1, H);
    }
    const view = ts.view;
    if (!view.length) return;
    let lo = 127;
    let hi = 0;
    for (const n of view) {
      if (n.midi < lo) lo = n.midi;
      if (n.midi > hi) hi = n.midi;
    }
    lo -= 2;
    hi += 2;
    const pad = H * 0.16;
    const span = Math.max(1, hi - lo);
    const nh = Math.max(2, Math.min(H * 0.18, (H - pad * 2) / span + 1));
    for (const n of view) {
      ctx.fillStyle = this.deps.instruments.get(n.instrument)?.color ?? TRACK_COLORS[ts.index]!;
      const y = H - pad - ((n.midi - lo) / span) * (H - pad * 2) - nh / 2;
      const x = n.start * W;
      const w = Math.max(2, n.length * W);
      ctx.fillRect(x, y, Math.min(w, W - x), nh);
      if (x + w > W) ctx.fillRect(0, y, x + w - W, nh); // wraps around the loop point
    }
  }
}

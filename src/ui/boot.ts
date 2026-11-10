import type { LoadProgress } from '../types';
import { ASSET_BYTES, FIRST_START_BYTES, formatMB } from '../config';
import { TextSlot, h, setClass } from './dom';
import { icon } from './icons';

type Stage = LoadProgress['stage'];

interface Row {
  stage: Stage;
  label: string;
  /** Expected bytes for download rows, 0 for the others. */
  bytes: number;
}

const ROWS: readonly Row[] = [
  { stage: 'camera', label: 'Camera', bytes: 0 },
  { stage: 'runtime', label: 'Vision engine', bytes: ASSET_BYTES.wasm },
  { stage: 'hands', label: 'Hand model', bytes: ASSET_BYTES.hand },
  { stage: 'face', label: 'Face model', bytes: ASSET_BYTES.face },
  { stage: 'warmup', label: 'Warming up', bytes: 0 },
  { stage: 'audio', label: 'Sound', bytes: 0 },
];

const DOWNLOADS: readonly Stage[] = ['runtime', 'hands', 'face'];

interface RowState {
  loaded: number;
  total: number;
  done: boolean;
  active: boolean;
  el: HTMLElement;
  value: TextSlot;
}

const mb = (bytes: number): string => (bytes / 1_000_000).toFixed(1);

/**
 * "Preparing everything" card: one row per thing being prepared with its size and live state,
 * an overall bar driven by real bytes, transfer speed and time left, and a clear "warming up"
 * step for the few seconds the vision engine needs after its download.
 */
export class BootPanel {
  readonly el: HTMLElement;
  private readonly summary: TextSlot;
  private readonly fill: HTMLElement;
  private readonly bar: HTMLElement;
  private readonly hint: HTMLElement;
  private readonly rows = new Map<Stage, RowState>();
  private readonly samples: Array<[t: number, bytes: number]> = [];
  private firstByteAt = 0;
  private hideTimer = 0;

  constructor() {
    this.summary = new TextSlot(h('p', { class: 'boot-label mono' }));
    this.fill = h('span', { class: 'boot-fill' });
    this.bar = h('div', { class: 'boot-bar', role: 'progressbar', 'aria-label': 'Preparing', 'aria-valuemin': '0', 'aria-valuemax': '100' }, this.fill);
    this.hint = h('p', { class: 'boot-hint' });
    this.hint.append(icon('camera'), h('span', { text: 'Allow camera access when your browser asks. The video stays on this device.' }));

    const list = h('ul', { class: 'boot-steps' });
    for (const r of ROWS) {
      const value = new TextSlot(h('span', { class: 'boot-value mono' }));
      const el = h(
        'li',
        { class: 'boot-step' },
        h('span', { class: 'boot-tick', 'aria-hidden': 'true' }),
        h('span', { class: 'boot-name', text: r.label }),
        value.el,
      );
      value.set(r.bytes ? formatMB(r.bytes) : '');
      list.append(el);
      this.rows.set(r.stage, { loaded: 0, total: r.bytes, done: false, active: false, el, value });
    }

    const card = h(
      'div',
      { class: 'boot-card glass' },
      h('div', { class: 'boot-orb', 'aria-hidden': 'true' }),
      h('h2', { class: 'boot-title', text: 'Preparing everything' }),
      this.summary.el,
      this.bar,
      list,
      this.hint,
      h('p', { class: 'boot-foot', text: `About ${formatMB(FIRST_START_BYTES)} the first time. After that it opens from your browser's cache.` }),
    );
    this.el = h('div', { class: 'boot', role: 'status', 'aria-live': 'polite', hidden: true }, card);
    this.summary.set('Getting ready…');
  }

  update(p: LoadProgress | null): void {
    window.clearTimeout(this.hideTimer);
    if (!p) {
      this.el.classList.add('is-leaving');
      this.hideTimer = window.setTimeout(() => {
        this.el.hidden = true;
        this.el.classList.remove('is-leaving');
      }, 400);
      return;
    }
    this.el.hidden = false;
    this.el.classList.remove('is-leaving');

    const row = this.rows.get(p.stage);
    if (row) {
      if (DOWNLOADS.includes(p.stage)) {
        if (p.total > 0) row.total = p.total;
        row.loaded = Math.max(row.loaded, p.loaded);
        if (p.done) row.loaded = row.total = Math.max(p.loaded, 1);
      }
      row.done = row.done || p.done;
      row.active = !row.done;
    }
    this.render(p);
  }

  private render(p: LoadProgress): void {
    let loaded = 0;
    let total = 0;
    let downloadsDone = true;
    for (const s of DOWNLOADS) {
      const r = this.rows.get(s)!;
      loaded += Math.min(r.loaded, r.total);
      total += r.total;
      downloadsDone &&= r.done;
    }

    const now = performance.now();
    if (loaded > 0 && !this.firstByteAt) this.firstByteAt = now;
    this.samples.push([now, loaded]);
    while (this.samples.length > 2 && now - this.samples[0]![0] > 2500) this.samples.shift();

    // Rows
    for (const r of ROWS) {
      const st = this.rows.get(r.stage)!;
      setClass(st.el, 'is-done', st.done);
      setClass(st.el, 'is-active', st.active && !st.done);
      if (DOWNLOADS.includes(r.stage)) {
        st.value.set(st.done ? formatMB(st.total) : st.loaded > 0 ? `${mb(st.loaded)} / ${formatMB(st.total)}` : formatMB(st.total));
      } else if (r.stage === 'camera') {
        st.value.set(st.done ? 'allowed' : st.active ? 'waiting for you' : '');
      } else if (r.stage === 'warmup') {
        st.value.set(st.done ? 'ready' : st.active ? 'a few seconds' : '');
      } else if (r.stage === 'audio') {
        st.value.set(st.done ? 'ready' : st.active ? 'starting' : '');
      }
    }

    // Summary line + bar: downloads are 90 % of the bar, warming up the last 10 %.
    const warm = this.rows.get('warmup')!;
    const frac = total > 0 ? 0.9 * (loaded / total) + (warm.done ? 0.1 : 0) : 0;
    this.fill.style.transform = `scaleX(${Math.max(0.03, Math.min(1, frac))})`;
    this.bar.setAttribute('aria-valuenow', String(Math.round(frac * 100)));
    setClass(this.bar, 'is-indeterminate', downloadsDone && !warm.done);

    const cam = this.rows.get('camera')!;
    const waitingForCamera = cam.active && !cam.done;
    if (waitingForCamera) {
      this.summary.set(loaded > 0 ? `Waiting for the camera · ${mb(loaded)} of ${formatMB(total)} downloaded` : 'Waiting for camera permission');
    } else if (!downloadsDone) {
      const first = this.samples[0]!;
      const dt = (now - first[0]) / 1000;
      const speed = dt > 0.4 ? (loaded - first[1]) / dt : 0;
      const left = speed > 0 ? Math.ceil((total - loaded) / speed) : 0;
      const parts = [`Downloading ${mb(loaded)} of ${formatMB(total)}`];
      if (speed > 0) parts.push(`${(speed / 1_000_000).toFixed(1)} MB/s`);
      if (left > 0 && left < 600) parts.push(left < 60 ? `about ${left} s left` : `about ${Math.ceil(left / 60)} min left`);
      this.summary.set(parts.join(' · '));
    } else if (!warm.done) {
      const cached = this.firstByteAt > 0 && now - this.firstByteAt < 600;
      this.summary.set(cached ? 'Loaded from cache · warming up the vision engine' : 'Downloaded · warming up the vision engine');
    } else {
      this.summary.set(p.label || 'Almost there');
    }
    this.hint.hidden = !waitingForCamera;
  }
}

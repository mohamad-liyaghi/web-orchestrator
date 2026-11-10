import type { Settings } from '../types';
import { h, radioArrowKeys, setClass, uid } from './dom';
import { icon } from './icons';

/**
 * Building blocks of the controls sheet. Every control is built once; a binder repaints it from
 * the sanitized settings, so the flow stays one way: control -> onSettings(patch) -> setSettings.
 */
export type Binder = (s: Settings) => void;

export interface Option<T extends string | number> {
  id: T;
  label: string;
  /** One plain-language line shown under the group while this option is selected. */
  hint?: string;
}

/** Radio group of buttons (ARIA radio pattern, arrow keys move and select). */
export function radios<T extends string | number>(
  label: string,
  options: ReadonlyArray<Option<T>>,
  onPick: (id: T) => void,
  binders: Binder[],
  read: (s: Settings) => T,
  cfg: { cls: string; btnCls: string; content?: (o: Option<T>) => Array<Node | string> },
): HTMLElement {
  const group = h('div', { class: cfg.cls, role: 'radiogroup', 'aria-label': label });
  radioArrowKeys(group);
  const buttons = options.map((o) => {
    const b = h('button', { type: 'button', class: cfg.btnCls, role: 'radio', 'aria-checked': 'false', 'data-value': String(o.id) });
    if (cfg.content) b.append(...cfg.content(o));
    else b.textContent = o.label;
    if (cfg.content) b.setAttribute('aria-label', o.label);
    b.addEventListener('click', () => onPick(o.id));
    group.append(b);
    return b;
  });
  binders.push((s) => {
    const v = String(read(s));
    for (const b of buttons) {
      const on = b.dataset.value === v;
      b.setAttribute('aria-checked', String(on));
      b.tabIndex = on ? 0 : -1;
      setClass(b, 'is-on', on);
    }
    // Keep the group reachable by Tab even when the value matches no option.
    if (!buttons.some((b) => b.tabIndex === 0) && buttons[0]) buttons[0].tabIndex = 0;
  });
  return group;
}

/** Segmented control. */
export function segmented<T extends string>(
  label: string,
  options: ReadonlyArray<Option<T>>,
  onPick: (id: T) => void,
  binders: Binder[],
  read: (s: Settings) => T,
  cls = '',
): HTMLElement {
  return radios(label, options, onPick, binders, read, { cls: `seg ${cls}`.trim(), btnCls: 'seg-btn' });
}

/** Wrapping row of pill chips. */
export function chips<T extends string | number>(
  label: string,
  options: ReadonlyArray<Option<T>>,
  onPick: (id: T) => void,
  binders: Binder[],
  read: (s: Settings) => T,
  cls = '',
): HTMLElement {
  return radios(label, options, onPick, binders, read, { cls: `chip-row ${cls}`.trim(), btnCls: 'chip' });
}

/** A hint line that shows the selected option's hint. */
export function optionHint<T extends string | number>(options: ReadonlyArray<Option<T>>, binders: Binder[], read: (s: Settings) => T): HTMLElement {
  const p = h('p', { class: 'ctl-hint opt-hint', 'aria-live': 'polite' });
  binders.push((s) => {
    const v = read(s);
    const t = options.find((o) => o.id === v)?.hint ?? '';
    if (p.textContent !== t) p.textContent = t;
  });
  return p;
}

export function toggle(label: string, hint: string, onFlip: (v: boolean) => void, binders: Binder[], read: (s: Settings) => boolean): HTMLElement {
  const hintId = hint ? uid('hint') : null;
  const sw = h('button', { type: 'button', class: 'switch', role: 'switch', 'aria-checked': 'false', 'aria-label': label, 'aria-describedby': hintId });
  sw.append(h('span', { class: 'switch-knob' }));
  sw.addEventListener('click', () => onFlip(sw.getAttribute('aria-checked') !== 'true'));
  binders.push((s) => sw.setAttribute('aria-checked', String(read(s))));
  return h(
    'div',
    { class: 'ctl-row' },
    h('div', { class: 'ctl-text' }, h('span', { class: 'ctl-name', text: label }), hint ? h('span', { class: 'ctl-hint', id: hintId, text: hint }) : null),
    sw,
  );
}

export interface SliderOpts {
  /** Double-click (and the reset buttons) bring the slider back to this value. */
  reset?: number;
  /** Fill from this value instead of the minimum (EQ gains at 0 dB, "natural" settings). */
  center?: number;
  /** Short line under the label. */
  hint?: string;
  cls?: string;
}

export function slider(
  label: string,
  min: number,
  max: number,
  step: number,
  fmt: (v: number) => string,
  onValue: (v: number) => void,
  binders: Binder[],
  read: (s: Settings) => number,
  opts: SliderOpts = {},
): { el: HTMLElement; input: HTMLInputElement } {
  const id = uid('sl');
  const hintId = opts.hint ? uid('hint') : null;
  const input = h('input', { type: 'range', id, min, max, step, class: opts.center !== undefined ? 'range range-bi' : 'range', 'aria-describedby': hintId });
  const out = h('output', { class: 'range-val mono', for: id });
  const mid = opts.center !== undefined ? ((opts.center - min) / (max - min)) * 100 : 0;
  const paint = (v: number): void => {
    const text = fmt(v);
    out.textContent = text;
    input.setAttribute('aria-valuetext', text);
    const pct = ((v - min) / (max - min)) * 100;
    if (opts.center !== undefined) {
      input.style.setProperty('--lo', `${Math.min(mid, pct)}%`);
      input.style.setProperty('--hi', `${Math.max(mid, pct)}%`);
    } else input.style.setProperty('--fill', `${pct}%`);
  };
  input.addEventListener('input', () => {
    const v = Number(input.value);
    paint(v);
    onValue(v);
  });
  if (opts.reset !== undefined) {
    const r = opts.reset;
    input.title = `Double-click to reset to ${fmt(r)}`;
    input.addEventListener('dblclick', () => {
      input.value = String(r);
      paint(r);
      onValue(r);
    });
  }
  binders.push((s) => {
    const v = read(s);
    if (Number(input.value) !== v) input.value = String(v);
    paint(v);
  });
  if (opts.center !== undefined) input.style.setProperty('--mid', `${mid}%`);
  const el = h(
    'div',
    { class: `ctl-slider ${opts.cls ?? ''}`.trim() },
    h('div', { class: 'ctl-slider-head' }, h('label', { for: id, class: 'ctl-name', text: label }), out),
    opts.hint ? h('span', { class: 'ctl-hint', id: hintId, text: opts.hint }) : null,
    input,
  );
  return { el, input };
}

/** − value + stepper for small integer ranges. */
export function stepper(
  label: string,
  min: number,
  max: number,
  fmt: (v: number) => string,
  onValue: (v: number) => void,
  binders: Binder[],
  read: (s: Settings) => number,
  cls = 'stepper stepper-lg',
): HTMLElement {
  const wrap = h('div', { class: cls, role: 'group', 'aria-label': label });
  const down = h('button', { type: 'button', class: 'step-btn', 'aria-label': `${label} down` });
  down.append(icon('minus'));
  const val = h('span', { class: 'step-val mono', 'aria-live': 'polite' });
  const up = h('button', { type: 'button', class: 'step-btn', 'aria-label': `${label} up` });
  up.append(icon('plus'));
  let cur = min;
  down.addEventListener('click', () => onValue(Math.max(min, cur - 1)));
  up.addEventListener('click', () => onValue(Math.min(max, cur + 1)));
  wrap.append(down, val, up);
  binders.push((s) => {
    cur = read(s);
    val.textContent = fmt(cur);
    down.disabled = cur <= min;
    up.disabled = cur >= max;
  });
  return wrap;
}

export function section(title: string, ...children: (Node | null)[]): HTMLElement {
  return h('section', { class: 'sheet-sec' }, h('h3', { class: 'sheet-sec-title', text: title }), ...children);
}

/** A labelled row: name (+ hint) on the left, a control on the right. */
export function row(label: string, control: HTMLElement, hint = ''): HTMLElement {
  return h('div', { class: 'ctl-row' }, h('div', { class: 'ctl-text' }, h('span', { class: 'ctl-name', text: label }), hint ? h('span', { class: 'ctl-hint', text: hint }) : null), control);
}

/** Two-press confirm button ("Press again to reset"), disarms by itself after a few seconds. */
export function confirmButton(label: string, armedLabel: string, onConfirm: () => void, cls = 'btn'): { el: HTMLButtonElement; destroy(): void } {
  const el = h('button', { type: 'button', class: cls });
  const text = h('span', { class: 'reset-label', text: label });
  el.append(icon('refresh'), text);
  let armed = 0;
  const disarm = (): void => {
    window.clearTimeout(armed);
    armed = 0;
    text.textContent = label;
    el.classList.remove('is-armed');
  };
  el.addEventListener('click', () => {
    if (!armed) {
      text.textContent = armedLabel;
      el.classList.add('is-armed');
      armed = window.setTimeout(disarm, 3500);
      return;
    }
    disarm();
    onConfirm();
  });
  return { el, destroy: disarm };
}

import type {
  ActionGesture,
  GestureAction,
  InstrumentDef,
  InstrumentLoadState,
  LeftHandRole,
  ScaleDef,
  Settings,
  StageCallbacks,
  TriggerMode,
} from '../types';
import { ACTION_GESTURES, DEFAULT_SETTINGS, GESTURE_ACTIONS, shareUrl } from '../settings';
import { PRESETS } from '../presets';
import { ACTION_LABEL, GESTURE_GLYPH } from '../gestures';
import { FAMILIES, familyMeta } from './catalog';
import { NOTE_NAMES, h, setClass, uid } from './dom';
import { icon } from './icons';

export type SheetTab = 'lead' | 'left' | 'play' | 'gestures' | 'display';

const TABS: ReadonlyArray<{ id: SheetTab; label: string }> = [
  { id: 'lead', label: 'Lead' },
  { id: 'left', label: 'Left hand' },
  { id: 'play', label: 'Play' },
  { id: 'gestures', label: 'Gestures' },
  { id: 'display', label: 'Setup' },
];

export const LEFT_ROLES: ReadonlyArray<{ id: LeftHandRole; label: string; hint: string }> = [
  { id: 'volume', label: 'Volume', hint: 'Theremin style: raise your left hand for louder, lower it to fade out.' },
  { id: 'bass', label: 'Bass', hint: 'Your left hand plays a bass line; its height picks the note.' },
  { id: 'chords', label: 'Chords', hint: 'Raise 1–5 fingers on your left hand to play the chords I–V of the key.' },
  { id: 'off', label: 'Off', hint: 'Only your right hand plays. The left hand is ignored.' },
];

export const TRIGGERS: ReadonlyArray<{ id: TriggerMode; label: string; hint: string }> = [
  { id: 'mouth', label: 'Mouth', hint: 'Open your mouth to play; wider is louder.' },
  { id: 'pinch', label: 'Pinch', hint: 'Touch thumb and index of the playing hand to sound a note.' },
  { id: 'always', label: 'Hands', hint: 'Plays whenever a hand is up. Great for the theremin.' },
];

const GESTURE_NAME: Record<ActionGesture, string> = {
  fist: 'Fist',
  peace: 'Peace sign',
  'thumbs-up': 'Thumbs up',
  rock: 'Rock on',
};

interface DockDeps {
  callbacks: StageCallbacks;
  toast(message: string): void;
}

interface CardRefs {
  btn: HTMLButtonElement;
  bar: HTMLElement;
}

type Binder = (s: Settings) => void;

/** Segmented control (radio group semantics). */
function segmented<T extends string>(
  label: string,
  options: ReadonlyArray<{ id: T; label: string }>,
  onPick: (id: T) => void,
  binders: Binder[],
  read: (s: Settings) => T,
  cls = '',
): HTMLElement {
  const group = h('div', { class: `seg ${cls}`.trim(), role: 'radiogroup', 'aria-label': label });
  const buttons = options.map((o) => {
    const b = h('button', { type: 'button', class: 'seg-btn', role: 'radio', 'aria-checked': 'false', 'data-value': o.id, text: o.label });
    b.addEventListener('click', () => onPick(o.id));
    group.append(b);
    return b;
  });
  binders.push((s) => {
    const v = read(s);
    buttons.forEach((b) => {
      const on = b.dataset.value === v;
      b.setAttribute('aria-checked', String(on));
      setClass(b, 'is-on', on);
    });
  });
  return group;
}

function toggle(label: string, hint: string, onFlip: (v: boolean) => void, binders: Binder[], read: (s: Settings) => boolean): HTMLElement {
  const sw = h('button', { type: 'button', class: 'switch', role: 'switch', 'aria-checked': 'false', 'aria-label': label });
  sw.append(h('span', { class: 'switch-knob' }));
  sw.addEventListener('click', () => onFlip(sw.getAttribute('aria-checked') !== 'true'));
  binders.push((s) => sw.setAttribute('aria-checked', String(read(s))));
  return h('div', { class: 'ctl-row' }, h('div', { class: 'ctl-text' }, h('span', { class: 'ctl-name', text: label }), hint ? h('span', { class: 'ctl-hint', text: hint }) : null), sw);
}

function slider(
  label: string,
  min: number,
  max: number,
  step: number,
  fmt: (v: number) => string,
  onValue: (v: number) => void,
  binders: Binder[],
  read: (s: Settings) => number,
): { el: HTMLElement; input: HTMLInputElement } {
  const id = uid('sl');
  const input = h('input', { type: 'range', id, min, max, step, class: 'range' });
  const out = h('output', { class: 'range-val mono', for: id });
  const paint = (v: number): void => {
    out.textContent = fmt(v);
    input.style.setProperty('--fill', `${((v - min) / (max - min)) * 100}%`);
  };
  input.addEventListener('input', () => {
    const v = Number(input.value);
    paint(v);
    onValue(v);
  });
  binders.push((s) => {
    const v = read(s);
    if (Number(input.value) !== v) input.value = String(v);
    paint(v);
  });
  const el = h('div', { class: 'ctl-slider' }, h('div', { class: 'ctl-slider-head' }, h('label', { for: id, class: 'ctl-name', text: label }), out), input);
  return { el, input };
}

function section(title: string, ...children: (Node | null)[]): HTMLElement {
  return h('section', { class: 'sheet-sec' }, h('h3', { class: 'sheet-sec-title', text: title }), ...children);
}

/**
 * Controls: a compact dock (always visible) and a sheet with every setting. On phones the sheet
 * is a draggable bottom sheet. Settings flow one way: a control calls onSettings(patch), the
 * app sanitizes and calls setSettings(), which repaints every control.
 */
export class Dock {
  readonly dock: HTMLElement;
  readonly sheet: HTMLElement;
  readonly scrim: HTMLElement;
  private readonly binders: Binder[] = [];
  private readonly panes = new Map<SheetTab, HTMLElement>();
  private readonly tabButtons = new Map<SheetTab, HTMLButtonElement>();
  private readonly leadCards = new Map<string, CardRefs>();
  private readonly leftCards = new Map<string, CardRefs>();
  private readonly loadStates = new Map<string, InstrumentLoadState>();
  private readonly leadGrid: HTMLElement;
  private readonly leftGrid: HTMLElement;
  private readonly scaleRow: HTMLElement;
  private readonly leadPill: HTMLButtonElement;
  private readonly leftPill: HTMLButtonElement;
  private readonly sensWrap: HTMLElement;
  private readonly leftNote: HTMLElement;
  private readonly roleHint: HTMLElement;
  private readonly trigHint: HTMLElement;
  private readonly leftInstWrap: HTMLElement;
  private readonly gestureRows: HTMLElement;
  private settings: Settings = { ...DEFAULT_SETTINGS };
  private instruments: readonly InstrumentDef[] = [];
  private tab: SheetTab = 'lead';
  private openState = false;
  private resetArmed = 0;
  private drag: { id: number; y0: number; dy: number; t0: number; wasOpen: boolean } | null = null;
  private readonly resetBtn: HTMLButtonElement;

  constructor(private readonly deps: DockDeps) {
    const set = (patch: Partial<Settings>): void => deps.callbacks.onSettings(patch);
    const b = this.binders;

    // ---- Dock ---------------------------------------------------------------------------
    this.dock = h('div', { class: 'dock glass', role: 'toolbar', 'aria-label': 'Quick controls' });
    const handle = h('button', { type: 'button', class: 'dock-handle', 'aria-label': 'Show all controls', 'aria-expanded': 'false' });
    handle.append(h('span', { class: 'grip' }));
    this.bindDrag(handle);

    this.leadPill = this.pill('Lead', () => this.toggleTab('lead'));
    this.leftPill = this.pill('Left', () => this.toggleTab('left'));

    const trig = segmented('Trigger', TRIGGERS, (id) => set({ trigger: id }), b, (s) => s.trigger, 'seg-dock');
    const octave = h('div', { class: 'stepper', role: 'group', 'aria-label': 'Octave' });
    const octDown = h('button', { type: 'button', class: 'step-btn', 'aria-label': 'Octave down' });
    octDown.append(icon('minus'));
    const octVal = h('span', { class: 'step-val mono' });
    const octUp = h('button', { type: 'button', class: 'step-btn', 'aria-label': 'Octave up' });
    octUp.append(icon('plus'));
    octDown.addEventListener('click', () => set({ octave: Math.max(-2, this.settings.octave - 1) }));
    octUp.addEventListener('click', () => set({ octave: Math.min(2, this.settings.octave + 1) }));
    octave.append(h('span', { class: 'step-label', text: 'Oct' }), octDown, octVal, octUp);
    b.push((s) => {
      octVal.textContent = s.octave > 0 ? `+${s.octave}` : String(s.octave);
      octDown.disabled = s.octave <= -2;
      octUp.disabled = s.octave >= 2;
    });

    const groove = h('button', { type: 'button', class: 'dock-toggle', 'aria-pressed': 'false' });
    groove.append(icon('music'), h('span', { text: 'Beat' }));
    groove.addEventListener('click', () => set({ groove: !this.settings.groove }));
    b.push((s) => groove.setAttribute('aria-pressed', String(s.groove)));

    const more = h('button', { type: 'button', class: 'dock-more', 'aria-label': 'All controls' });
    more.append(icon('sliders'), h('span', { text: 'Controls' }));
    more.addEventListener('click', () => this.toggleTab(this.openState ? this.tab : 'play'));
    b.push(() => more.setAttribute('aria-expanded', String(this.openState)));

    this.dock.append(
      handle,
      h('div', { class: 'dock-row' }, this.leadPill, this.leftPill, h('span', { class: 'dock-sep' }), trig, octave, groove, more),
    );

    // ---- Sheet --------------------------------------------------------------------------
    const titleId = uid('sheet-title');
    this.sheet = h('div', { class: 'sheet glass', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': titleId, 'aria-hidden': 'true' });
    this.sheet.inert = true;
    this.scrim = h('div', { class: 'sheet-scrim', 'aria-hidden': 'true' });
    this.scrim.addEventListener('click', () => this.close());
    const sheetHandle = h('button', { type: 'button', class: 'sheet-handle', 'aria-label': 'Close controls' });
    sheetHandle.append(h('span', { class: 'grip' }));
    this.bindDrag(sheetHandle);
    const tabs = h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Control sections' });
    for (const t of TABS) {
      const tb = h('button', { type: 'button', class: 'tab', role: 'tab', 'aria-selected': 'false', id: uid('tab'), text: t.label });
      tb.addEventListener('click', () => this.open(t.id));
      this.tabButtons.set(t.id, tb);
      tabs.append(tb);
    }
    tabs.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      e.preventDefault();
      e.stopPropagation();
      const i = TABS.findIndex((t) => t.id === this.tab);
      const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length]!;
      this.open(next.id);
      this.tabButtons.get(next.id)?.focus();
    });
    const close = h('button', { type: 'button', class: 'icon-btn sheet-close', 'aria-label': 'Close controls' });
    close.append(icon('close'));
    close.addEventListener('click', () => this.close());
    const head = h('div', { class: 'sheet-head' }, h('h2', { class: 'sr-only', id: titleId, text: 'Controls' }), tabs, close);
    const body = h('div', { class: 'sheet-body' });
    this.sheet.append(sheetHandle, head, body);

    // Lead pane: presets + instrument cards.
    const presetRow = h('div', { class: 'preset-row', role: 'list', 'aria-label': 'Presets' });
    for (const p of PRESETS) {
      const pb = h('button', { type: 'button', class: 'preset', role: 'listitem', title: p.description });
      pb.append(h('span', { class: 'preset-glyph', 'aria-hidden': 'true', text: p.glyph }), h('span', { class: 'preset-name', text: p.name }));
      pb.addEventListener('click', () => {
        set(p.settings);
        deps.toast(`${p.glyph} ${p.name}: ${p.description}`);
      });
      presetRow.append(pb);
    }
    this.leadGrid = h('div', { class: 'inst-groups' });
    this.pane('lead', section('Quick setups', presetRow), section('Lead instrument', this.leadGrid));

    // Left-hand pane.
    const roleSeg = segmented('Left hand role', LEFT_ROLES, (id) => set({ leftHand: id }), b, (s) => s.leftHand, 'seg-wide');
    this.roleHint = h('p', { class: 'ctl-hint role-hint' });
    this.leftNote = h('p', { class: 'ctl-note' });
    this.leftGrid = h('div', { class: 'inst-groups' });
    this.leftInstWrap = section('Left-hand instrument', this.leftNote, this.leftGrid);
    this.pane('left', section('What your left hand does', roleSeg, this.roleHint), this.leftInstWrap);
    b.push((s) => {
      this.roleHint.textContent = LEFT_ROLES.find((r) => r.id === s.leftHand)?.hint ?? '';
      const uses = s.leftHand === 'bass' || s.leftHand === 'chords';
      setClass(this.leftInstWrap, 'is-dim', !uses);
      this.leftNote.textContent = uses
        ? s.leftHand === 'chords'
          ? 'Plays the chords. Pads, keys and strings sound best.'
          : 'Plays the bass line. Basses sit best under the melody.'
        : 'Used when the left hand plays bass or chords.';
    });

    // Play pane.
    const trigSeg = segmented('Trigger', TRIGGERS, (id) => set({ trigger: id }), b, (s) => s.trigger, 'seg-wide');
    this.trigHint = h('p', { class: 'ctl-hint role-hint' });
    const sens = slider('Mouth sensitivity', 0, 1, 0.01, (v) => (v < 0.34 ? 'Low' : v < 0.67 ? 'Medium' : 'High') + ` ${Math.round(v * 100)}`, (v) => set({ sensitivity: v }), b, (s) => s.sensitivity);
    this.sensWrap = sens.el;
    b.push((s) => {
      this.trigHint.textContent = TRIGGERS.find((t) => t.id === s.trigger)?.hint ?? '';
      setClass(this.sensWrap, 'is-dim', s.trigger !== 'mouth');
    });
    const keyGrid = h('div', { class: 'key-grid', role: 'radiogroup', 'aria-label': 'Key' });
    const keyBtns = NOTE_NAMES.map((n, i) => {
      const kb = h('button', { type: 'button', class: `key-btn${n.includes('#') ? ' is-sharp' : ''}`, role: 'radio', 'aria-checked': 'false', text: n });
      kb.addEventListener('click', () => set({ key: i }));
      keyGrid.append(kb);
      return kb;
    });
    b.push((s) =>
      keyBtns.forEach((kb, i) => {
        kb.setAttribute('aria-checked', String(i === s.key));
        setClass(kb, 'is-on', i === s.key);
      }),
    );
    this.scaleRow = h('div', { class: 'chip-row', role: 'radiogroup', 'aria-label': 'Scale' });
    const octave2 = h('div', { class: 'stepper stepper-lg', role: 'group', 'aria-label': 'Octave' });
    const o2d = h('button', { type: 'button', class: 'step-btn', 'aria-label': 'Octave down' });
    o2d.append(icon('minus'));
    const o2v = h('span', { class: 'step-val mono' });
    const o2u = h('button', { type: 'button', class: 'step-btn', 'aria-label': 'Octave up' });
    o2u.append(icon('plus'));
    o2d.addEventListener('click', () => set({ octave: Math.max(-2, this.settings.octave - 1) }));
    o2u.addEventListener('click', () => set({ octave: Math.min(2, this.settings.octave + 1) }));
    octave2.append(o2d, o2v, o2u);
    b.push((s) => {
      o2v.textContent = s.octave > 0 ? `+${s.octave}` : String(s.octave);
      o2d.disabled = s.octave <= -2;
      o2u.disabled = s.octave >= 2;
    });
    const span = slider('Notes across the screen', 8, 24, 1, (v) => `${v}`, (v) => set({ span: v }), b, (s) => s.span);
    const tempo = slider('Tempo', 60, 160, 1, (v) => `${v} BPM`, (v) => set({ tempo: v }), b, (s) => s.tempo);
    const reverb = slider('Reverb', 0, 1, 0.01, (v) => `${Math.round(v * 100)}%`, (v) => set({ reverb: v }), b, (s) => s.reverb);
    const volume = slider('Master volume', 0, 1, 0.01, (v) => `${Math.round(v * 100)}%`, (v) => set({ volume: v }), b, (s) => s.volume);
    this.pane(
      'play',
      h(
        'div',
        { class: 'sheet-cols' },
        h(
          'div',
          null,
          section('Trigger', trigSeg, this.trigHint, sens.el),
          section('Key', keyGrid),
          section('Scale', this.scaleRow),
        ),
        h(
          'div',
          null,
          section('Range', h('div', { class: 'ctl-row' }, h('span', { class: 'ctl-name', text: 'Octave' }), octave2), span.el),
          section('Beat', toggle('Backing beat', 'A soft groove that follows the tempo.', (v) => set({ groove: v }), b, (s) => s.groove), tempo.el),
          section('Mix', reverb.el, volume.el),
        ),
      ),
    );

    // Gestures pane.
    this.gestureRows = h('div', { class: 'gesture-list' });
    for (const g of ACTION_GESTURES) {
      const id = uid('g');
      const sel = h('select', { id, class: 'select' });
      for (const a of GESTURE_ACTIONS) sel.append(h('option', { value: a, text: ACTION_LABEL[a] }));
      sel.addEventListener('change', () => set({ gestures: { ...this.settings.gestures, [g]: sel.value as GestureAction } }));
      b.push((s) => {
        if (sel.value !== s.gestures[g]) sel.value = s.gestures[g];
        sel.disabled = !s.gesturesEnabled;
      });
      this.gestureRows.append(
        h(
          'div',
          { class: 'gesture-row' },
          h('span', { class: 'gesture-glyph', 'aria-hidden': 'true', text: GESTURE_GLYPH[g] }),
          h('label', { for: id, class: 'ctl-name', text: GESTURE_NAME[g] }),
          sel,
        ),
      );
    }
    b.push((s) => setClass(this.gestureRows, 'is-dim', !s.gesturesEnabled));
    this.pane(
      'gestures',
      section(
        'Hand gestures',
        toggle('Gesture actions', 'Hold a pose for half a second to trigger its action.', (v) => set({ gesturesEnabled: v }), b, (s) => s.gesturesEnabled),
        this.gestureRows,
        h('p', { class: 'ctl-hint', text: 'Mute works while you hold it. In Chords mode the left hand’s fingers pick chords, so its poses are ignored.' }),
      ),
    );

    // Display / setup pane.
    const shareBtn = h('button', { type: 'button', class: 'btn' });
    shareBtn.append(icon('share'), h('span', { text: 'Share setup' }));
    shareBtn.addEventListener('click', () => void this.share());
    this.resetBtn = h('button', { type: 'button', class: 'btn btn-danger' });
    this.resetBtn.append(icon('refresh'), h('span', { class: 'reset-label', text: 'Reset to defaults' }));
    this.resetBtn.addEventListener('click', () => this.reset());
    const shortcuts = h('dl', { class: 'shortcuts' });
    for (const [k, d] of [
      ['R', 'Record / stop'],
      ['G', 'Beat on / off'],
      ['↑ ↓', 'Octave up / down'],
      ['T', 'Next trigger mode'],
      ['L', 'Next left-hand role'],
      ['H or ?', 'Help'],
      ['F', 'Fullscreen'],
      ['Esc', 'Close panels'],
    ] as const) {
      shortcuts.append(h('div', null, h('dt', null, h('kbd', { text: k })), h('dd', { text: d })));
    }
    this.pane(
      'display',
      h(
        'div',
        { class: 'sheet-cols' },
        h(
          'div',
          null,
          section(
            'Display',
            toggle('Hand skeleton', 'Draw the tracked joints.', (v) => set({ skeleton: v }), b, (s) => s.skeleton),
            toggle('Note lanes', 'Horizontal guides for every note.', (v) => set({ lanes: v }), b, (s) => s.lanes),
            toggle('Low power', 'Fewer tracking frames, no particles. For older devices.', (v) => set({ lowPower: v }), b, (s) => s.lowPower),
          ),
          section('Setup', h('div', { class: 'btn-row' }, shareBtn, this.resetBtn)),
        ),
        h('div', { class: 'hide-touch' }, section('Keyboard shortcuts', shortcuts)),
      ),
    );

    for (const [, p] of this.panes) body.append(p);
    this.open('lead', false);
    this.close();
  }

  // -------------------------------------------------------------------------------------------

  get isOpen(): boolean {
    return this.openState;
  }

  setInstruments(list: readonly InstrumentDef[], scales: readonly ScaleDef[]): void {
    this.instruments = list;
    this.leadCards.clear();
    this.leftCards.clear();
    this.buildGrid(this.leadGrid, this.leadCards, (id) => this.deps.callbacks.onSettings({ lead: id }), null);
    this.buildGrid(this.leftGrid, this.leftCards, (id) => this.deps.callbacks.onSettings({ bass: id }), ['bass', 'keys', 'strings', 'synth', 'organ', 'guitar']);
    this.scaleRow.replaceChildren();
    for (const sc of scales) {
      const c = h('button', { type: 'button', class: 'chip', role: 'radio', 'aria-checked': 'false', 'data-value': sc.id, text: sc.name });
      c.addEventListener('click', () => this.deps.callbacks.onSettings({ scale: sc.id }));
      this.scaleRow.append(c);
    }
    for (const s of this.loadStates.values()) this.setLoadState(s);
    this.setSettings(this.settings);
  }

  setSettings(s: Settings): void {
    this.settings = s;
    for (const fn of this.binders) fn(s);
    for (const [id, c] of this.leadCards) {
      c.btn.setAttribute('aria-pressed', String(id === s.lead));
      setClass(c.btn, 'is-on', id === s.lead);
    }
    for (const [id, c] of this.leftCards) {
      c.btn.setAttribute('aria-pressed', String(id === s.bass));
      setClass(c.btn, 'is-on', id === s.bass);
    }
    for (const c of Array.from(this.scaleRow.children) as HTMLElement[]) {
      const on = c.dataset.value === s.scale;
      c.setAttribute('aria-checked', String(on));
      setClass(c, 'is-on', on);
    }
    this.paintPills();
  }

  setLoadState(st: InstrumentLoadState): void {
    if (st.loading || st.error) this.loadStates.set(st.id, st);
    else this.loadStates.delete(st.id);
    for (const map of [this.leadCards, this.leftCards]) {
      const c = map.get(st.id);
      if (!c) continue;
      setClass(c.btn, 'is-loading', st.loading);
      setClass(c.btn, 'is-error', !!st.error);
      c.bar.style.transform = `scaleX(${st.loading ? Math.max(0.04, st.progress) : 0})`;
      if (st.error) c.btn.title = `Could not load: ${st.error}`;
      else c.btn.removeAttribute('title');
    }
    this.paintPills();
  }

  open(tab: SheetTab, focus = true): void {
    this.tab = tab;
    for (const [id, p] of this.panes) {
      const on = id === tab;
      p.hidden = !on;
      const tb = this.tabButtons.get(id)!;
      tb.setAttribute('aria-selected', String(on));
      tb.tabIndex = on ? 0 : -1;
      setClass(tb, 'is-on', on);
    }
    if (!this.openState) {
      this.openState = true;
      this.sheet.inert = false;
      this.sheet.setAttribute('aria-hidden', 'false');
      this.sheet.style.transform = '';
      setClass(this.sheet, 'is-open', true);
      setClass(this.scrim, 'is-open', true);
      setClass(this.dock, 'sheet-open', true);
      if (focus) this.tabButtons.get(tab)?.focus({ preventScroll: true });
    }
    this.syncExpanded();
  }

  close(): void {
    if (!this.openState && this.sheet.inert) return;
    const hadFocus = this.sheet.contains(document.activeElement);
    this.openState = false;
    this.sheet.inert = true;
    this.sheet.setAttribute('aria-hidden', 'true');
    this.sheet.style.transform = '';
    setClass(this.sheet, 'is-open', false);
    setClass(this.scrim, 'is-open', false);
    setClass(this.dock, 'sheet-open', false);
    this.syncExpanded();
    if (hadFocus) this.dock.querySelector<HTMLElement>('.dock-more')?.focus({ preventScroll: true });
  }

  destroy(): void {
    window.clearTimeout(this.resetArmed);
  }

  // -------------------------------------------------------------------------------------------

  private toggleTab(tab: SheetTab): void {
    if (this.openState && this.tab === tab) this.close();
    else this.open(tab);
  }

  private syncExpanded(): void {
    this.dock.querySelector('.dock-handle')?.setAttribute('aria-expanded', String(this.openState));
    this.dock.querySelector('.dock-more')?.setAttribute('aria-expanded', String(this.openState));
    this.leadPill.setAttribute('aria-expanded', String(this.openState && this.tab === 'lead'));
    this.leftPill.setAttribute('aria-expanded', String(this.openState && this.tab === 'left'));
  }

  private pane(id: SheetTab, ...children: Node[]): void {
    const tb = this.tabButtons.get(id)!;
    const p = h('div', { class: 'pane', role: 'tabpanel', 'aria-labelledby': tb.id, 'data-pane': id }, ...children);
    tb.setAttribute('aria-controls', p.id || (p.id = uid('pane')));
    this.panes.set(id, p);
  }

  private pill(role: string, onClick: () => void): HTMLButtonElement {
    const btn = h('button', { type: 'button', class: 'pill', 'aria-expanded': 'false' });
    btn.append(
      h('span', { class: 'pill-glyph', 'aria-hidden': 'true' }),
      h('span', { class: 'pill-text' }, h('span', { class: 'pill-role', text: role }), h('span', { class: 'pill-name' })),
      h('span', { class: 'pill-load', 'aria-hidden': 'true' }),
    );
    btn.addEventListener('click', onClick);
    return btn;
  }

  private paintPills(): void {
    const s = this.settings;
    const paint = (btn: HTMLButtonElement, inst: InstrumentDef | undefined, name: string, roleText: string, dim: boolean): void => {
      (btn.querySelector('.pill-glyph') as HTMLElement).textContent = inst?.glyph ?? '·';
      (btn.querySelector('.pill-name') as HTMLElement).textContent = name;
      (btn.querySelector('.pill-role') as HTMLElement).textContent = roleText;
      btn.style.setProperty('--c', inst?.color ?? '#3cf2ff');
      const ls = inst ? this.loadStates.get(inst.id) : undefined;
      setClass(btn, 'is-loading', !!ls?.loading);
      setClass(btn, 'is-dim', dim);
      btn.setAttribute('aria-label', `${roleText}: ${name}. Change`);
    };
    const lead = this.instruments.find((i) => i.id === s.lead);
    paint(this.leadPill, lead, lead?.name ?? s.lead, 'Lead', false);
    const uses = s.leftHand === 'bass' || s.leftHand === 'chords';
    const left = uses ? this.instruments.find((i) => i.id === s.bass) : undefined;
    const roleName = LEFT_ROLES.find((r) => r.id === s.leftHand)?.label ?? 'Left';
    paint(this.leftPill, left, uses ? (left?.name ?? s.bass) : roleName, uses ? `Left · ${roleName}` : 'Left hand', !uses && s.leftHand === 'off');
    if (!uses) {
      (this.leftPill.querySelector('.pill-glyph') as HTMLElement).textContent = s.leftHand === 'volume' ? '◐' : '–';
      this.leftPill.style.setProperty('--c', '#3cf2ff');
    }
  }

  private buildGrid(
    grid: HTMLElement,
    map: Map<string, CardRefs>,
    onPick: (id: string) => void,
    familyOrder: readonly string[] | null,
  ): void {
    grid.replaceChildren();
    const fams = familyOrder
      ? [...FAMILIES].sort((a, b) => {
          const ia = familyOrder.indexOf(a.id);
          const ib = familyOrder.indexOf(b.id);
          return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
        })
      : FAMILIES;
    for (const fam of fams) {
      const items = this.instruments.filter((i) => i.family === fam.id);
      if (!items.length) continue;
      const meta = familyMeta(fam.id);
      const cards = h('div', { class: 'inst-grid' });
      for (const inst of items) {
        const bar = h('span', { class: 'card-bar' });
        const btn = h('button', { type: 'button', class: 'inst-card', 'aria-pressed': 'false', style: `--c:${inst.color}` });
        const size = inst.kind === 'synth' || inst.sizeKB === 0 ? 'synth' : inst.sizeKB >= 1024 ? `${(inst.sizeKB / 1024).toFixed(1)} MB` : `${inst.sizeKB} KB`;
        btn.append(
          h('span', { class: 'card-glyph', 'aria-hidden': 'true', text: inst.glyph }),
          h('span', { class: 'card-text' }, h('span', { class: 'card-name', text: inst.name }), h('span', { class: 'card-blurb', text: inst.blurb })),
          h('span', { class: 'card-meta mono', text: size }),
          h('span', { class: 'card-check', 'aria-hidden': 'true' }),
          bar,
        );
        (btn.querySelector('.card-check') as HTMLElement).append(icon('check'));
        btn.addEventListener('click', () => onPick(inst.id));
        cards.append(btn);
        map.set(inst.id, { btn, bar });
      }
      grid.append(h('div', { class: 'inst-group', style: `--c:${meta.color}` }, h('h4', { class: 'inst-group-title' }, h('span', { class: 'dot' }), meta.label), cards));
    }
  }

  private async share(): Promise<void> {
    const url = shareUrl(this.settings);
    const touch = matchMedia('(pointer: coarse)').matches;
    if (touch && typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: 'My Orchestrator setup', url });
        return;
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        // fall through to the clipboard
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      this.deps.toast('Setup link copied to the clipboard');
    } catch {
      this.deps.toast(`Copy this link to share your setup: ${url}`);
    }
  }

  private reset(): void {
    const label = this.resetBtn.querySelector('.reset-label') as HTMLElement;
    if (!this.resetArmed) {
      label.textContent = 'Press again to reset';
      this.resetBtn.classList.add('is-armed');
      this.resetArmed = window.setTimeout(() => {
        this.resetArmed = 0;
        label.textContent = 'Reset to defaults';
        this.resetBtn.classList.remove('is-armed');
      }, 3500);
      return;
    }
    window.clearTimeout(this.resetArmed);
    this.resetArmed = 0;
    label.textContent = 'Reset to defaults';
    this.resetBtn.classList.remove('is-armed');
    this.deps.callbacks.onSettings({ ...DEFAULT_SETTINGS, gestures: { ...DEFAULT_SETTINGS.gestures } });
    this.deps.toast('Settings reset to defaults');
  }

  /** Bottom-sheet drag on phones: follow the finger, then snap open or closed. */
  private bindDrag(handle: HTMLElement): void {
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this.drag = { id: e.pointerId, y0: e.clientY, dy: 0, t0: performance.now(), wasOpen: this.openState };
      handle.setPointerCapture(e.pointerId);
      if (!this.openState) this.open(this.tab, false);
      setClass(this.sheet, 'is-dragging', true);
      this.sheet.style.transform = this.drag.wasOpen ? 'translateY(0)' : `translateY(${this.sheet.offsetHeight}px)`;
    });
    handle.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d || d.id !== e.pointerId) return;
      d.dy = e.clientY - d.y0;
      const hgt = this.sheet.offsetHeight;
      const y = d.wasOpen ? Math.max(0, d.dy) : Math.max(0, hgt + d.dy);
      this.sheet.style.transform = `translateY(${Math.min(hgt, y)}px)`;
    });
    const end = (e: PointerEvent): void => {
      const d = this.drag;
      if (!d || d.id !== e.pointerId) return;
      this.drag = null;
      setClass(this.sheet, 'is-dragging', false);
      this.sheet.style.transform = '';
      const tap = Math.abs(d.dy) < 6 && performance.now() - d.t0 < 400;
      if (tap) {
        if (d.wasOpen) this.close();
        else this.open(this.tab);
        return;
      }
      const shouldOpen = d.wasOpen ? d.dy < 80 : d.dy < -50;
      if (shouldOpen) this.open(this.tab, false);
      else this.close();
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }
}

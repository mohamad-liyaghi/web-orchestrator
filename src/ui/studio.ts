import type { Settings } from '../types';
import { DEFAULT_SETTINGS } from '../settings';
import { type Binder, type Option, chips, confirmButton, optionHint, radios, section, segmented, slider, stepper, toggle } from './controls';
import { NOTE_NAMES, h } from './dom';
import {
  CURVE_OPTS,
  RATE_OPTS,
  REVERB_OPTS,
  STUDIO_KEYS,
  TIME_SIG_OPTS,
  centsFrom440,
  curveIcon,
  pct,
  pickDefaults,
  semis,
  signedDb,
} from './musician';

export interface StudioDeps {
  set(patch: Partial<Settings>): void;
  binders: Binder[];
  toast(message: string): void;
}

const TUNING_CHIPS: ReadonlyArray<Option<number>> = [
  { id: 432, label: '432', hint: 'A = 432 Hz: the “Verdi” pitch, a little darker.' },
  { id: 440, label: '440', hint: 'A = 440 Hz: international standard concert pitch.' },
  { id: 442, label: '442', hint: 'A = 442 Hz: many European orchestras tune a touch brighter.' },
];

/** Sounding note names, spelled the way players of transposing instruments say them. */
const SOUNDING = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];

/** Familiar transposing instruments for the "sounds as" line. */
const TRANSPOSING: Record<number, string> = {
  0: 'concert pitch',
  [-2]: 'like a B♭ trumpet or clarinet',
  [-7]: 'like a horn in F',
  [-9]: 'like an E♭ alto sax',
  [-12]: 'an octave down',
  12: 'an octave up',
};

const releaseText = (v: number): string => (Math.abs(v - 0.5) < 0.005 ? 'Natural' : v < 0.5 ? `Shorter ${pct((0.5 - v) * 2)}` : `Longer ${pct((v - 0.5) * 2)}`);
const widthText = (v: number): string => (v < 0.005 ? 'Mono' : Math.abs(v - 0.5) < 0.005 ? 'Natural 100%' : `${v > 0.5 ? 'Wide' : 'Narrow'} ${Math.round(v * 200)}%`);
const offOr = (v: number, f: (v: number) => string): string => (v < 0.005 ? 'Off' : f(v));

/**
 * Studio tab: tuning, transpose, timing, dynamics and the effects rack. Values are shown in
 * musician units; every slider double-clicks back to its default.
 */
export function buildStudio(d: StudioDeps): { el: HTMLElement; destroy(): void } {
  const { set, binders: b } = d;
  const D = DEFAULT_SETTINGS;

  // ---- Pitch ----------------------------------------------------------------------------------
  const tuneHz = h('span', { class: 'st-big mono' });
  const tuneCents = h('span', { class: 'st-sub mono' });
  const tuneChips = chips('Tuning presets', TUNING_CHIPS, (id) => set({ tuning: id }), b, (s) => s.tuning, 'tune-chips');
  const tuneHint = h('p', { class: 'ctl-hint opt-hint' });
  const tune = slider('Fine tuning', 415, 466, 1, (v) => `A4 = ${v} Hz`, (v) => set({ tuning: v }), b, (s) => s.tuning, { reset: 440, center: 440 });
  b.push((s) => {
    tuneHz.textContent = `A4 = ${s.tuning} Hz`;
    tuneCents.textContent = centsFrom440(s.tuning);
    tuneHint.textContent = TUNING_CHIPS.find((c) => c.id === s.tuning)?.hint ?? (s.tuning === 415 ? 'A = 415 Hz: baroque pitch, a half step below modern.' : 'Custom concert pitch.');
  });
  const transpose = stepper('Transpose', -12, 12, semis, (v) => set({ transpose: v }), b, (s) => s.transpose);
  const soundsAs = h('p', { class: 'ctl-hint st-sounds', 'aria-live': 'polite' });
  b.push((s) => {
    const written = NOTE_NAMES[s.key] ?? 'C';
    const sounding = SOUNDING[(((s.key + s.transpose) % 12) + 12) % 12] ?? 'C';
    const extra = TRANSPOSING[s.transpose];
    soundsAs.textContent =
      s.transpose === 0 ? `Key of ${written} sounds as written (concert pitch).` : `You play in ${written}, it sounds as ${sounding}${extra ? `: ${extra}` : ''}. The lanes keep the written names.`;
  });
  const pitchSec = section(
    'Pitch',
    h('div', { class: 'st-readout' }, h('span', { class: 'ctl-name', text: 'Tuning' }), h('span', { class: 'st-readout-v' }, tuneHz, tuneCents)),
    tuneChips,
    tuneHint,
    tune.el,
    h('div', { class: 'ctl-row' }, h('div', { class: 'ctl-text' }, h('span', { class: 'ctl-name', text: 'Transpose' }), soundsAs), transpose),
  );

  // ---- Time -----------------------------------------------------------------------------------
  const tsSeg = segmented('Time signature', TIME_SIG_OPTS, (id) => set({ timeSignature: id }), b, (s) => s.timeSignature, 'seg-wide ts-seg');
  const swing = slider('Swing', 0, 0.6, 0.01, (v) => (v < 0.005 ? 'Straight' : pct(v / 0.6)), (v) => set({ swing: v }), b, (s) => s.swing, {
    reset: D.swing,
    hint: 'Delays every off-beat for a shuffle feel: beat, arpeggio and looper.',
  });
  const click = slider('Click volume', 0, 1, 0.01, (v) => offOr(v, pct), (v) => set({ clickVolume: v }), b, (s) => s.clickVolume, { reset: D.clickVolume });
  const timeSec = section(
    'Time',
    h('div', { class: 'ctl-sub ctl-sub-first' }, h('span', { class: 'ctl-name', text: 'Time signature' }), tsSeg, optionHint(TIME_SIG_OPTS, b, (s) => s.timeSignature)),
    swing.el,
    toggle('Count-in', 'One bar of clicks before a loop take or a song in tempo mode.', (v) => set({ countIn: v }), b, (s) => s.countIn),
    click.el,
  );

  // ---- Dynamics -------------------------------------------------------------------------------
  const curves = radios('Velocity curve', CURVE_OPTS, (id) => set({ velocityCurve: id }), b, (s) => s.velocityCurve, {
    cls: 'seg seg-wide curve-seg',
    btnCls: 'seg-btn curve-btn',
    content: (o) => [curveIcon(o.id), h('span', { text: o.label })],
  });
  const attack = slider('Attack', 0, 1, 0.01, (v) => (v < 0.005 ? 'Natural' : `Slower ${pct(v)}`), (v) => set({ attack: v }), b, (s) => s.attack, {
    reset: D.attack,
    hint: 'How fast a note starts: natural, up to a slow swell.',
  });
  const release = slider('Release', 0, 1, 0.01, releaseText, (v) => set({ release: v }), b, (s) => s.release, {
    reset: D.release,
    center: 0.5,
    hint: 'How long a note rings after you stop.',
  });
  const dynSec = section(
    'Touch & envelope',
    h('div', { class: 'ctl-sub ctl-sub-first' }, h('span', { class: 'ctl-name', text: 'Velocity curve' }), curves, optionHint(CURVE_OPTS, b, (s) => s.velocityCurve)),
    attack.el,
    release.el,
  );

  // ---- Effects rack ---------------------------------------------------------------------------
  const revType = segmented('Reverb type', REVERB_OPTS, (id) => set({ reverbType: id }), b, (s) => s.reverbType, 'seg-wide');
  const revAmt = slider('Reverb amount', 0, 1, 0.01, (v) => offOr(v, pct), (v) => set({ reverb: v }), b, (s) => s.reverb, { reset: D.reverb });
  const delayAmt = slider('Delay amount', 0, 1, 0.01, (v) => offOr(v, pct), (v) => set({ delay: v }), b, (s) => s.delay, { reset: D.delay });
  const delayTime = chips('Delay time', RATE_OPTS, (id) => set({ delayTime: id }), b, (s) => s.delayTime, 'rate-row');
  const delayFb = slider('Feedback', 0, 0.9, 0.01, (v) => (v < 0.005 ? 'One echo' : pct(v)), (v) => set({ delayFeedback: v }), b, (s) => s.delayFeedback, {
    reset: D.delayFeedback,
    hint: 'How many echoes repeat.',
  });
  const chorus = slider('Chorus', 0, 1, 0.01, (v) => offOr(v, pct), (v) => set({ chorus: v }), b, (s) => s.chorus, {
    reset: D.chorus,
    hint: 'Doubles the sound with slight detune: shimmer and width.',
  });
  const delayBox = h(
    'div',
    { class: 'fx-unit' },
    h('div', { class: 'fx-head' }, h('span', { class: 'fx-name', text: 'Delay' }), h('span', { class: 'fx-tag mono', text: 'tempo synced' })),
    delayAmt.el,
    h('div', { class: 'ctl-sub' }, h('span', { class: 'ctl-name', text: 'Time' }), delayTime),
    delayFb.el,
  );
  const reverbBox = h(
    'div',
    { class: 'fx-unit' },
    h('div', { class: 'fx-head' }, h('span', { class: 'fx-name', text: 'Reverb' })),
    revType,
    optionHint(REVERB_OPTS, b, (s) => s.reverbType),
    revAmt.el,
  );
  const fxSec = section('Effects', reverbBox, delayBox, h('div', { class: 'fx-unit' }, chorus.el));

  const eqBand = (label: string, key: 'eqLow' | 'eqMid' | 'eqHigh', freq: string): HTMLElement =>
    slider(label, -12, 12, 0.5, signedDb, (v) => set({ [key]: v }), b, (s) => s[key], { reset: 0, center: 0, hint: freq, cls: 'eq-band' }).el;
  const eqSec = section(
    'EQ',
    h('div', { class: 'eq' }, eqBand('Low', 'eqLow', 'Bass and warmth'), eqBand('Mid', 'eqMid', 'Body and presence'), eqBand('High', 'eqHigh', 'Air and sparkle')),
    h('p', { class: 'ctl-hint', text: 'Double-click a band to set it back to 0 dB.' }),
  );
  const comp = slider('Compressor', 0, 1, 0.01, (v) => offOr(v, pct), (v) => set({ compressor: v }), b, (s) => s.compressor, {
    reset: D.compressor,
    hint: 'Evens out loud and soft: punchier, more present.',
  });
  const width = slider('Stereo width', 0, 1, 0.01, widthText, (v) => set({ width: v }), b, (s) => s.width, { reset: D.width, center: 0.5 });
  const masterSec = section('Master', comp.el, width.el);

  const reset = confirmButton('Reset studio', 'Press again to reset studio', () => {
    set(pickDefaults(STUDIO_KEYS, DEFAULT_SETTINGS));
    d.toast('Studio reset to defaults');
  });

  const el = h(
    'div',
    { class: 'studio' },
    h(
      'div',
      { class: 'sheet-cols' },
      h('div', null, pitchSec, timeSec, dynSec),
      h('div', null, fxSec, eqSec, masterSec, h('section', { class: 'sheet-sec' }, h('div', { class: 'btn-row' }, reset.el))),
    ),
  );
  return { el, destroy: reset.destroy };
}

import type { ChordPlay, InstrumentDef, Settings } from '../types';
import { DEFAULT_SETTINGS } from '../settings';
import { type Binder, chips, confirmButton, optionHint, radios, section, segmented, slider, stepper, toggle } from './controls';
import { h, setClass } from './dom';
import {
  ARP_OPTS,
  BASS_OPTS,
  HARMONY_OPTS,
  KIND_TEXT,
  PEDAL_OPTS,
  PLAY_STYLE_OPTS,
  RATE_OPTS,
  STRUM_OPTS,
  TECHNIQUE_KEYS,
  VOICING_OPTS,
  contourIcon,
  pct,
  pickDefaults,
  strumSpoken,
  techniqueKind,
  voicePlan,
} from './musician';

export interface TechniqueDeps {
  set(patch: Partial<Settings>): void;
  binders: Binder[];
  instrument(id: string): InstrumentDef | undefined;
  toast(message: string): void;
}

const CHORD_PLAY: ReadonlyArray<{ id: ChordPlay; label: string; hint: string }> = [
  { id: 'block', label: 'Block', hint: 'All notes of the chord together.' },
  { id: 'strum', label: 'Strum', hint: 'Strummed in rhythm with the pattern below.' },
  { id: 'arp', label: 'Arp', hint: 'One note at a time, in time with the tempo.' },
];

/** Eight-step strum diagram: D / U / rest cells, beats brighter. */
function strumDiagram(steps: string): HTMLElement {
  const el = h('span', { class: 'strum-steps', 'aria-hidden': 'true' });
  for (let i = 0; i < steps.length; i++) {
    const c = steps[i]!;
    el.append(h('span', { class: `st${i % 2 === 0 ? ' st-beat' : ''}${c === '·' ? ' st-rest' : c === 'D' ? ' st-d' : ' st-u'}`, text: c }));
  }
  return el;
}

/**
 * Technique section: the playing-technique controls that matter for the instruments that sound
 * right now (lead, chord and bass voices), with plain-language hints. Groups appear and hide as
 * the instruments, the mode and the chord play change.
 */
export function buildTechnique(d: TechniqueDeps): { el: HTMLElement; destroy(): void } {
  const { set, binders: b } = d;

  // ---- Banner: who plays, and Auto / Manual ------------------------------------------------
  const voices = h('ul', { class: 'tq-voices', 'aria-label': 'Instruments playing' });
  const styleSeg = segmented('Play style', PLAY_STYLE_OPTS, (id) => set({ playStyle: id }), b, (s) => s.playStyle, 'seg-wide tq-style');
  const styleHint = optionHint(PLAY_STYLE_OPTS, b, (s) => s.playStyle);
  const autoNote = h('p', { class: 'tq-auto' });
  const banner = h(
    'div',
    { class: 'tq-banner' },
    h('div', { class: 'tq-banner-l' }, h('span', { class: 'sheet-sec-title', text: 'Playing now' }), voices),
    h('div', { class: 'tq-banner-r' }, h('span', { class: 'sheet-sec-title', text: 'Play style' }), styleSeg),
    h('div', { class: 'tq-banner-hints' }, styleHint, autoNote),
  );

  // ---- Chords: chord play + voicing ----------------------------------------------------------
  const chordPlaySeg = segmented('Chord play', CHORD_PLAY, (id) => set({ chordPlay: id }), b, (s) => s.chordPlay, 'seg-wide');
  const chordPlayHint = optionHint(CHORD_PLAY, b, (s) => s.chordPlay);
  const voicingChips = chips('Voicing', VOICING_OPTS, (id) => set({ voicing: id }), b, (s) => s.voicing);
  const voicingHint = optionHint(VOICING_OPTS, b, (s) => s.voicing);
  const chordsTitle = h('h3', { class: 'sheet-sec-title' });
  const chordsSec = h(
    'section',
    { class: 'sheet-sec tq-o1' },
    chordsTitle,
    chordPlaySeg,
    chordPlayHint,
    h('div', { class: 'ctl-sub' }, h('span', { class: 'ctl-name', text: 'Voicing' }), voicingChips, voicingHint),
  );

  // ---- Strumming ---------------------------------------------------------------------------
  const strumGrid = radios('Strum pattern', STRUM_OPTS, (id) => set({ strumPattern: id }), b, (s) => s.strumPattern, {
    cls: 'strum-grid',
    btnCls: 'strum-card',
    content: (o) => {
      const opt = STRUM_OPTS.find((x) => x.id === o.id)!;
      return [h('span', { class: 'strum-name', text: o.label }), strumDiagram(opt.steps)];
    },
  });
  // Spoken rhythm on each card for screen readers.
  for (const btn of Array.from(strumGrid.children) as HTMLElement[]) {
    const opt = STRUM_OPTS.find((x) => x.id === btn.dataset.value);
    if (opt) btn.setAttribute('aria-label', `${opt.label}: ${strumSpoken(opt.id)}`);
  }
  const strumHint = optionHint(STRUM_OPTS, b, (s) => s.strumPattern);
  const strumNote = h('p', { class: 'ctl-note tq-note' });
  const strumUse = h('button', { type: 'button', class: 'btn btn-sm', text: 'Strum the chords' });
  strumUse.addEventListener('click', () => set({ chordPlay: 'strum' }));
  const strumNoteRow = h('div', { class: 'tq-note-row' }, strumNote, strumUse);
  const strumBlock = h('div', { class: 'tq-strum' }, strumNoteRow, strumGrid, strumHint);
  const palmMute = toggle('Palm mute', 'Rest your palm on the strings: short, chunky, muted strums.', (v) => set({ palmMute: v }), b, (s) => s.palmMute);
  const strumTitle = h('h3', { class: 'sheet-sec-title' });
  const strumSec = h('section', { class: 'sheet-sec tq-o2' }, strumTitle, strumBlock, palmMute);

  // ---- Keys: sustain pedal -----------------------------------------------------------------
  const pedalTitle = h('h3', { class: 'sheet-sec-title' });
  const pedalSec = h(
    'section',
    { class: 'sheet-sec tq-o3' },
    pedalTitle,
    segmented('Sustain pedal', PEDAL_OPTS, (id) => set({ sustainPedal: id }), b, (s) => s.sustainPedal, 'seg-wide'),
    optionHint(PEDAL_OPTS, b, (s) => s.sustainPedal),
  );

  // ---- Arpeggio ------------------------------------------------------------------------------
  const arpPattern = radios('Arpeggio pattern', ARP_OPTS, (id) => set({ arpPattern: id }), b, (s) => s.arpPattern, {
    cls: 'chip-row arp-row',
    btnCls: 'chip chip-ic',
    content: (o) => {
      const opt = ARP_OPTS.find((x) => x.id === o.id)!;
      return [contourIcon(opt.contour), h('span', { text: o.label })];
    },
  });
  const arpRate = chips('Arpeggio rate', RATE_OPTS, (id) => set({ arpRate: id }), b, (s) => s.arpRate, 'rate-row');
  const arpOct = stepper('Octaves', 1, 3, (v) => `${v} oct`, (v) => set({ arpOctaves: v }), b, (s) => s.arpOctaves);
  const arpSec = h(
    'section',
    { class: 'sheet-sec tq-o2' },
    h('h3', { class: 'sheet-sec-title', text: 'Arpeggio' }),
    arpPattern,
    optionHint(ARP_OPTS, b, (s) => s.arpPattern),
    h('div', { class: 'ctl-sub' }, h('span', { class: 'ctl-name', text: 'Rate' }), arpRate, optionHint(RATE_OPTS, b, (s) => s.arpRate)),
    h('div', { class: 'ctl-row' }, h('div', { class: 'ctl-text' }, h('span', { class: 'ctl-name', text: 'Octaves' }), h('span', { class: 'ctl-hint', text: 'How far the arpeggio climbs.' })), arpOct),
  );

  // ---- Bass line -----------------------------------------------------------------------------
  const bassTitle = h('h3', { class: 'sheet-sec-title' });
  const bassSec = h(
    'section',
    { class: 'sheet-sec tq-o4' },
    bassTitle,
    chips('Bass pattern', BASS_OPTS, (id) => set({ bassPattern: id }), b, (s) => s.bassPattern),
    optionHint(BASS_OPTS, b, (s) => s.bassPattern),
  );

  // ---- Melody harmony ----------------------------------------------------------------------
  const harmonySec = h('section', { class: 'sheet-sec tq-o5' }, h('h3', { class: 'sheet-sec-title', text: 'Harmony' }),
    chips('Harmony', HARMONY_OPTS, (id) => set({ harmony: id }), b, (s) => s.harmony),
    optionHint(HARMONY_OPTS, b, (s) => s.harmony),
  );

  // ---- Feel ----------------------------------------------------------------------------------
  const glide = slider('Glide', 0, 1, 0.01, (v) => (v < 0.005 ? 'Off' : pct(v)), (v) => set({ glide: v }), b, (s) => s.glide, {
    reset: DEFAULT_SETTINGS.glide,
    hint: 'Slide between connected notes, like a bow or a singer.',
  });
  const humanize = slider('Humanize', 0, 1, 0.01, (v) => (v < 0.005 ? 'Off · machine tight' : pct(v)), (v) => set({ humanize: v }), b, (s) => s.humanize, {
    reset: DEFAULT_SETTINGS.humanize,
    hint: 'Tiny timing and loudness differences, like a real player.',
  });
  const feelSec = section('Feel', glide.el, humanize.el);
  feelSec.classList.add('tq-o6');

  // ---- Nothing special to set ----------------------------------------------------------------
  const emptyNote = h('p', { class: 'ctl-note tq-empty tq-o7' });

  const reset = confirmButton('Reset technique', 'Press again to reset technique', () => {
    set(pickDefaults(TECHNIQUE_KEYS, DEFAULT_SETTINGS));
    d.toast('Technique reset to defaults');
  });

  const left = h('div', null, chordsSec, bassSec, harmonySec, pedalSec, emptyNote);
  const right = h('div', null, strumSec, arpSec, feelSec, h('section', { class: 'sheet-sec tq-o9' }, h('div', { class: 'btn-row' }, reset.el)));
  const el = h('div', { class: 'tq' }, banner, h('div', { class: 'sheet-cols' }, left, right));

  let voicesKey = '';
  b.push((s) => {
    const plan = voicePlan(s);
    const inst = (id: string | null): InstrumentDef | undefined => (id ? d.instrument(id) : undefined);
    const name = (id: string | null): string => inst(id)?.name ?? id ?? '';
    const chordInst = inst(plan.chordInst);
    const melodyInst = inst(plan.melodyInst);
    const kinds = plan.sounding.map((id) => techniqueKind(inst(id)));
    const chordKind = plan.chordInst ? techniqueKind(chordInst) : null;
    const mainKind = chordKind ?? techniqueKind(melodyInst);

    // Banner: each sounding instrument with its role.
    const roles: Array<[string, string]> = [];
    if (s.mode === 'chords') roles.push([s.lead, 'Chords'], [s.bass, 'Bass line']);
    else {
      roles.push([s.lead, 'Melody']);
      if (s.leftHand === 'bass') roles.push([s.bass, 'Left hand · bass']);
      if (s.leftHand === 'chords') roles.push([s.bass, 'Left hand · chords']);
    }
    const key = roles.map((r) => r.join('=')).join('|') + `|${inst(s.lead)?.name ?? ''}`;
    if (key !== voicesKey) {
      voicesKey = key;
      voices.replaceChildren(
        ...roles.map(([id, role]) => {
          const i = inst(id);
          const k = techniqueKind(i);
          return h(
            'li',
            { class: 'tq-voice', style: `--c:${i?.color ?? '#3cf2ff'}` },
            h('span', { class: 'tq-glyph', 'aria-hidden': 'true', text: i?.glyph ?? '·' }),
            h('span', { class: 'tq-vtext' }, h('span', { class: 'tq-vname', text: i?.name ?? id }), h('span', { class: 'tq-vrole', text: `${role} · ${KIND_TEXT[k].title}` })),
          );
        }),
      );
    }
    autoNote.textContent = s.playStyle === 'auto' ? KIND_TEXT[mainKind].auto : '';
    autoNote.hidden = s.playStyle !== 'auto';

    // Chords group.
    const chords = !!plan.chordInst;
    chordsSec.hidden = !chords;
    chordsTitle.textContent = chords ? `Chords · ${name(plan.chordInst)}` : 'Chords';
    // Guitar shapes first for guitars, last for everything else.
    const guitarFirst = chordKind === 'guitar';
    const gBtn = voicingChips.querySelector<HTMLElement>('[data-value="guitar"]');
    if (gBtn && (voicingChips.firstElementChild === gBtn) !== guitarFirst) {
      if (guitarFirst) voicingChips.prepend(gBtn);
      else voicingChips.append(gBtn);
    }

    // Strumming: for guitars always (with chords), for any chord instrument when strumming.
    const guitarSounding = kinds.includes('guitar');
    const strumRelevant = chords && (chordKind === 'guitar' || s.chordPlay === 'strum');
    strumBlock.hidden = !strumRelevant;
    palmMute.hidden = !guitarSounding;
    strumSec.hidden = strumBlock.hidden && palmMute.hidden;
    const guitarName = plan.sounding.map((id) => inst(id)).find((i) => techniqueKind(i) === 'guitar')?.name;
    strumTitle.textContent = strumRelevant ? `Strumming · ${name(plan.chordInst)}` : `Guitar · ${guitarName ?? ''}`;
    const strumming = s.chordPlay === 'strum';
    strumNoteRow.hidden = strumming;
    strumNote.textContent = s.chordPlay === 'arp' ? 'Chords are arpeggiated now. The pattern plays when Chord play is Strum.' : 'Chords play as blocks now. The pattern plays when Chord play is Strum.';
    setClass(strumGrid, 'is-dim', !strumming);

    // Keys.
    const keysInst = plan.sounding.map((id) => inst(id)).find((i) => techniqueKind(i) === 'keys');
    pedalSec.hidden = !keysInst;
    pedalTitle.textContent = `Sustain pedal · ${keysInst?.name ?? ''}`;

    // Arpeggio.
    arpSec.hidden = !(chords && s.chordPlay === 'arp');

    // Bass line under chords.
    bassSec.hidden = !plan.bassUnderChords;
    bassTitle.textContent = `Bass line · ${name(s.bass)}`;

    // Harmony on melody notes.
    harmonySec.hidden = !plan.melodyInst;

    // Glide only where notes connect.
    glide.el.hidden = !kinds.includes('legato');

    const anyFamily = !chordsSec.hidden || !strumSec.hidden || !pedalSec.hidden || !arpSec.hidden;
    emptyNote.hidden = anyFamily;
    emptyNote.textContent = `${name(s.lead)}: nothing instrument-specific to set here. Switch to Chords mode (or let the left hand play chords) for voicing, strumming and arpeggios.`;
  });

  return { el, destroy: reset.destroy };
}

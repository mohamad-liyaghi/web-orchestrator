import type { MusicMetrics, Settings } from '../types';
import { TextSlot, frag, h, setClass } from './dom';
import { chordPlayLabel, strumSpoken, strumSteps } from './musician';

/** Finger patterns [thumb, index, middle, ring, pinky] that pick each scale degree in chords mode. */
export const DEGREE_PATTERNS: ReadonlyArray<readonly [boolean, boolean, boolean, boolean, boolean]> = [
  [false, true, false, false, false],
  [false, true, true, false, false],
  [false, true, true, true, false],
  [false, true, true, true, true],
  [true, true, true, true, true],
  [false, true, false, false, true],
  [true, true, false, false, true],
];

export const DEGREE_FINGERS = ['1 finger', '2 fingers', '3 fingers', '4 fingers', '5 fingers', 'Index + pinky', 'Thumb + index + pinky'];

/** Right-hand finger count -> chord style in chords mode. */
export const STYLES: ReadonlyArray<{ n: number; label: string }> = [
  { n: 1, label: 'Triad' },
  { n: 2, label: '7th' },
  { n: 3, label: 'add9' },
  { n: 4, label: 'sus4' },
  { n: 5, label: 'Open' },
];

const DEFAULT_ROMANS = ['I', 'ii', 'iii', 'IV', 'V', 'vi', 'vii°'];
const UPPER = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII'];

/** Roman numeral for degree i (0-based) from the chord's quality ("Am" -> vi, "Bdim" -> vii°). */
export function romanFor(i: number, chord: string | undefined): string {
  if (!chord) return DEFAULT_ROMANS[i] ?? '';
  const quality = chord.replace(/^[A-G][#b♯♭]?/, '');
  const up = UPPER[i] ?? '';
  if (/^(dim|°|o)/.test(quality)) return `${up.toLowerCase()}°`;
  if (/^m(?!aj)/.test(quality)) return up.toLowerCase();
  return up;
}

/** Tiny hand glyph: five finger bars, the raised ones lit. Static markup built from booleans. */
export function fingerIcon(p: readonly boolean[]): DocumentFragment {
  const xs = [3, 8, 13, 18, 23];
  const tops = [11, 2, 1, 2, 5];
  const bars = xs
    .map((x, i) => {
      const up = !!p[i];
      const y = up ? tops[i]! : 13;
      const tilt = i === 0 ? ' transform="rotate(-24 4 18)"' : '';
      return `<rect x="${x - 1.6}" y="${y}" width="3.2" height="${21 - y}" rx="1.6" class="${up ? 'f-up' : 'f-down'}"${tilt}/>`;
    })
    .join('');
  return frag(`<svg class="finger-ic" viewBox="0 0 26 28" aria-hidden="true" focusable="false">${bars}<rect x="5" y="18" width="18" height="9" rx="4" class="f-palm"/></svg>`);
}

/**
 * Chords-mode deck: the big current chord (roman numeral, name, style, borrowed badge), the
 * degree guide with the key's chords and the finger pattern for each, and the right-hand style
 * legend. Text changes only when a value changes.
 */
export class ChordDeck {
  readonly el: HTMLElement;
  private readonly roman: TextSlot;
  private readonly name: TextSlot;
  private readonly style: TextSlot;
  private readonly borrowed: HTMLElement;
  private readonly cells: Array<{ el: HTMLElement; roman: TextSlot; chord: TextSlot }> = [];
  private readonly styleCells: HTMLElement[] = [];
  private degree = -1;
  private styleIx = -2;
  private diatonicKey = '';
  private readonly play: HTMLElement;
  private readonly playText: TextSlot;
  private readonly playSteps: HTMLElement;
  private playKey = '';

  constructor() {
    this.roman = new TextSlot(h('span', { class: 'cd-roman' }));
    this.name = new TextSlot(h('span', { class: 'cd-name' }));
    this.style = new TextSlot(h('span', { class: 'cd-style' }));
    this.borrowed = h('span', { class: 'cd-borrowed', text: 'borrowed', hidden: true });
    // How the chord is played: strum pattern with its rhythm, or the arpeggio rate.
    this.playText = new TextSlot(h('span', { class: 'cd-play-text' }));
    this.playSteps = h('span', { class: 'cd-steps', 'aria-hidden': 'true' });
    this.play = h('div', { class: 'cd-play', hidden: true }, this.playText.el, this.playSteps);
    const big = h(
      'div',
      { class: 'cd-big' },
      this.roman.el,
      h('div', { class: 'cd-meta' }, this.name.el, h('div', { class: 'cd-tags' }, this.style.el, this.borrowed), this.play),
    );

    const guide = h('ol', { class: 'cd-guide', 'aria-label': 'Left hand: finger patterns for each chord' });
    for (let i = 0; i < 7; i++) {
      const roman = new TextSlot(h('span', { class: 'cd-c-roman', text: DEFAULT_ROMANS[i] }));
      const chord = new TextSlot(h('span', { class: 'cd-c-chord', text: '' }));
      const el = h('li', { class: 'cd-cell', title: DEGREE_FINGERS[i] }, roman.el, chord.el);
      el.append(fingerIcon(DEGREE_PATTERNS[i]!));
      guide.append(el);
      this.cells.push({ el, roman, chord });
    }

    const legend = h('ul', { class: 'cd-legend', 'aria-label': 'Right hand: fingers pick the chord style' });
    for (const s of STYLES) {
      const li = h('li', { class: 'cd-st' }, h('span', { class: 'cd-st-n mono', text: String(s.n) }), h('span', { text: s.label }));
      this.styleCells.push(li);
      legend.append(li);
    }
    const legendWrap = h('div', { class: 'cd-legend-wrap' }, h('span', { class: 'm-label', text: 'Right hand · style' }), legend);
    const guideWrap = h('div', { class: 'cd-guide-wrap' }, h('span', { class: 'm-label', text: 'Left hand · chord' }), guide);

    this.el = h('section', { class: 'chord-deck glass', 'aria-label': 'Chord player', hidden: true }, big, guideWrap, legendWrap);
  }

  setVisible(on: boolean): void {
    if (this.el.hidden === !on) return;
    this.el.hidden = !on;
  }

  private paintPlay(s: Settings): void {
    const key = `${s.chordPlay}|${s.strumPattern}|${s.arpRate}|${s.arpPattern}`;
    if (key === this.playKey) return;
    this.playKey = key;
    this.play.hidden = s.chordPlay === 'block';
    this.playText.set(chordPlayLabel(s));
    const steps = s.chordPlay === 'strum' ? strumSteps(s.strumPattern) : '';
    this.playSteps.replaceChildren(...steps.split('').map((c) => h('span', { class: c === '·' ? 'cs-rest' : c === 'D' ? 'cs-d' : 'cs-u', text: c })));
    this.playSteps.hidden = !steps;
    this.play.setAttribute('aria-label', s.chordPlay === 'strum' ? `${chordPlayLabel(s)}: ${strumSpoken(s.strumPattern)}` : chordPlayLabel(s));
  }

  update(m: MusicMetrics, settings: Settings): void {
    if (this.el.hidden) return;
    // Diatonic names change only with the key/scale.
    const dk = m.diatonic.length ? m.diatonic[0]! + m.diatonic[1]! + m.diatonic[6]! + m.diatonic.length : '';
    if (dk !== this.diatonicKey) {
      this.diatonicKey = dk;
      for (let i = 0; i < 7; i++) {
        const c = m.diatonic[i];
        this.cells[i]!.chord.set(c ?? '');
        this.cells[i]!.roman.set(romanFor(i, c));
      }
    }
    const deg = m.degree >= 1 && m.degree <= 7 ? m.degree - 1 : -1;
    if (deg !== this.degree) {
      if (this.degree >= 0) setClass(this.cells[this.degree]!.el, 'is-on', false);
      if (deg >= 0) setClass(this.cells[deg]!.el, 'is-on', true);
      this.degree = deg;
    }
    this.roman.set(m.roman || (deg >= 0 ? romanFor(deg, m.diatonic[deg]) : '—'));
    this.name.set(m.chord || (deg >= 0 ? (m.diatonic[deg] ?? '') : 'Raise your left hand'));
    this.style.set(m.chordStyle || settings.chordPlay);
    if (this.borrowed.hidden === m.borrowed) this.borrowed.hidden = !m.borrowed;
    this.paintPlay(settings);
    setClass(this.el, 'is-empty', deg < 0 && !m.chord);

    const sl = m.chordStyle.toLowerCase();
    const si = sl ? STYLES.findIndex((s) => sl.startsWith(s.label.toLowerCase())) : -1;
    if (si !== this.styleIx) {
      this.styleCells.forEach((c, i) => setClass(c, 'is-on', i === si));
      this.styleIx = si;
    }
  }
}

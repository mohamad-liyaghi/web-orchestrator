import type { LearnMode, LearnNote, LearnState, SongInfo } from '../types';
import { loadLearnMode, saveLearnMode } from '../learn';
import { TextSlot, h, prefersReducedMotion, setClass } from './dom';
import { icon } from './icons';

/**
 * Learn mode UI:
 *  - LearnPane: the song list in the controls sheet (difficulty dots, best stars, wait / tempo).
 *  - LearnOverlay: the live panel under the top bar (progress, upcoming-notes ribbon, hits /
 *    misses / streak / accuracy) and the finished card (stars, Retry / Next song / Exit).
 * The HUD draws the target lane and the reticle guide (hud.ts). DOM is built once and only
 * touched when a value changes.
 */

const RIBBON = 7;
const DIFFICULTY = ['', 'Easy', 'Medium', 'Hard'] as const;
const MODES: ReadonlyArray<{ id: LearnMode; label: string; hint: string }> = [
  { id: 'wait', label: 'Wait for me', hint: 'Each note waits until you play it. Best for learning.' },
  { id: 'tempo', label: 'Follow the beat', hint: 'Notes move on at the song’s tempo after a one-bar count-in.' },
];

function dots(level: number): HTMLElement {
  const el = h('span', { class: 'lp-dots', role: 'img', 'aria-label': `Difficulty: ${DIFFICULTY[level] ?? ''}` });
  for (let i = 1; i <= 3; i++) el.append(h('span', { class: i <= level ? 'lp-dot is-on' : 'lp-dot' }));
  return el;
}

function stars(count: number, cls: string): HTMLElement {
  const el = h('span', { class: cls, role: 'img', 'aria-label': `${count} of 3 stars` });
  for (let i = 0; i < 3; i++) {
    const s = h('span', { class: i < count ? 'star is-on' : 'star' });
    s.append(icon('star'));
    el.append(s);
  }
  return el;
}

// ---------------------------------------------------------------------------------------------

interface PaneDeps {
  onPick(songId: string, mode: LearnMode): void;
  onStop(): void;
}

/** Song list for the controls sheet. */
export class LearnPane {
  readonly el: HTMLElement;
  private readonly list: HTMLElement;
  private readonly modeBtns: HTMLButtonElement[] = [];
  private readonly modeHint: HTMLElement;
  private readonly stopRow: HTMLElement;
  private readonly stopTitle: TextSlot;
  private readonly rows = new Map<string, HTMLButtonElement>();
  private mode: LearnMode = loadLearnMode();
  private active: string | null = null;

  constructor(private readonly deps: PaneDeps) {
    const seg = h('div', { class: 'seg seg-wide', role: 'radiogroup', 'aria-label': 'Learn mode' });
    for (const m of MODES) {
      const b = h('button', { type: 'button', class: 'seg-btn', role: 'radio', 'aria-checked': 'false', 'data-value': m.id, text: m.label });
      b.addEventListener('click', () => this.setMode(m.id));
      seg.append(b);
      this.modeBtns.push(b);
    }
    this.modeHint = h('p', { class: 'ctl-hint role-hint' });
    this.stopTitle = new TextSlot(h('span', { class: 'lp-now-title' }));
    const stop = h('button', { type: 'button', class: 'btn lp-stop' });
    stop.append(icon('stop'), h('span', { text: 'Stop' }));
    stop.addEventListener('click', () => deps.onStop());
    this.stopRow = h('div', { class: 'lp-now', hidden: true }, h('span', { class: 'lp-now-label', text: 'Learning' }), this.stopTitle.el, stop);
    this.list = h('div', { class: 'lp-list', role: 'list', 'aria-label': 'Songs' });
    this.el = h(
      'div',
      { class: 'learn-pane' },
      h(
        'section',
        { class: 'sheet-sec' },
        h('h3', { class: 'sheet-sec-title', text: 'Play along' }),
        h('p', { class: 'ctl-hint', text: 'Pick a song: the key, lanes and instrument are set up for you. Play the glowing lane; the arrow on your fingertip shows the way.' }),
        seg,
        this.modeHint,
        this.stopRow,
      ),
      h('section', { class: 'sheet-sec' }, h('h3', { class: 'sheet-sec-title', text: 'Songs' }), this.list),
    );
    this.paintMode();
  }

  get currentMode(): LearnMode {
    return this.mode;
  }

  setSongs(list: readonly SongInfo[]): void {
    this.rows.clear();
    this.list.replaceChildren();
    for (const s of list) {
      const btn = h('button', { type: 'button', class: 'lp-song', role: 'listitem', 'data-id': s.id });
      const meta = `${s.credit} · ${s.keyName} · ${s.length} notes`;
      btn.append(
        h('span', { class: 'lp-play', 'aria-hidden': 'true' }),
        h('span', { class: 'lp-text' }, h('span', { class: 'lp-title', text: s.title }), h('span', { class: 'lp-meta', text: meta })),
        h('span', { class: 'lp-side' }, dots(s.difficulty), s.best ? stars(s.best.stars, 'lp-stars') : h('span', { class: 'lp-new', text: 'New' })),
      );
      (btn.querySelector('.lp-play') as HTMLElement).append(icon('play'));
      const best = s.best ? `, best ${s.best.stars} stars at ${Math.round(s.best.accuracy * 100)}%` : '';
      btn.setAttribute('aria-label', `${s.title}, ${DIFFICULTY[s.difficulty]}${best}. Play`);
      btn.addEventListener('click', () => this.deps.onPick(s.id, this.mode));
      this.rows.set(s.id, btn);
      this.list.append(btn);
    }
    this.paintActive();
  }

  setActive(songId: string | null, title = ''): void {
    if (songId === this.active) return;
    this.active = songId;
    this.stopTitle.set(title);
    this.paintActive();
  }

  private setMode(mode: LearnMode): void {
    this.mode = mode;
    saveLearnMode(mode);
    this.paintMode();
  }

  private paintMode(): void {
    for (const b of this.modeBtns) {
      const on = b.dataset.value === this.mode;
      b.setAttribute('aria-checked', String(on));
      setClass(b, 'is-on', on);
    }
    this.modeHint.textContent = MODES.find((m) => m.id === this.mode)?.hint ?? '';
  }

  private paintActive(): void {
    this.stopRow.hidden = !this.active;
    for (const [id, b] of this.rows) setClass(b, 'is-on', id === this.active);
  }
}

// ---------------------------------------------------------------------------------------------

interface OverlayDeps {
  onLearn(songId: string | null, mode: LearnMode): void;
  /** Current song list (for "Next song"). */
  songs(): readonly SongInfo[];
}

/** Live learn panel + finished card. */
export class LearnOverlay {
  readonly panel: HTMLElement;
  readonly card: HTMLElement;
  private readonly reduced = prefersReducedMotion();
  private readonly title: TextSlot;
  private readonly modeTag: TextSlot;
  private readonly count: TextSlot;
  private readonly fill: HTMLElement;
  private readonly ribbon: HTMLElement;
  private readonly chips: Array<{ el: HTMLElement; text: TextSlot }> = [];
  private readonly meter: HTMLElement;
  private readonly stats: HTMLElement;
  private readonly hits: TextSlot;
  private readonly misses: TextSlot;
  private readonly streak: TextSlot;
  private readonly acc: TextSlot;
  private readonly hint: TextSlot;
  private readonly count3: TextSlot;
  private readonly cardStars: HTMLElement;
  private readonly cardTitle: TextSlot;
  private readonly cardAcc: TextSlot;
  private readonly cardStats: TextSlot;
  private readonly cardBest: HTMLElement;
  private readonly cardHead: TextSlot;
  private readonly nextBtn: HTMLButtonElement;
  private st: LearnState | null = null;
  private songId = '';
  private index = -1;
  private upcoming: readonly LearnNote[] | null = null;
  private hitT = 0;
  private missT = 0;
  private done = false;
  private shownHits = -1;
  private shownMisses = -1;
  private shownStreak = -1;
  private shownAcc = -1;
  private shownCount = '';
  private meterShown = -1;
  private onLanes = true;
  private startedT = 0;

  constructor(private readonly deps: OverlayDeps) {
    this.title = new TextSlot(h('span', { class: 'lh-title' }));
    this.modeTag = new TextSlot(h('span', { class: 'lh-mode' }));
    this.count = new TextSlot(h('span', { class: 'lh-count mono' }));
    const close = h('button', { type: 'button', class: 'icon-btn lh-close', 'aria-label': 'Stop learning', title: 'Stop learning' });
    close.append(icon('close'));
    close.addEventListener('click', () => deps.onLearn(null, this.st?.mode ?? 'wait'));
    this.fill = h('span', { class: 'lh-fill' });
    this.ribbon = h('div', { class: 'lh-ribbon', 'aria-label': 'Next notes' });
    for (let i = 0; i < RIBBON; i++) {
      const text = new TextSlot(h('span', { class: 'lh-note mono' }));
      const el = h('span', { class: i === 0 ? 'lh-chip is-target' : 'lh-chip' }, text.el);
      this.chips.push({ el, text });
      this.ribbon.append(el);
    }
    this.meter = h('span', { class: 'lh-meter' });
    this.chips[0]!.el.append(this.meter);
    this.count3 = new TextSlot(h('span', { class: 'lh-countin mono', 'aria-live': 'polite' }));
    this.stats = h('div', { class: 'lh-stats' });
    const stat = (label: string, cls: string): TextSlot => {
      const v = new TextSlot(h('span', { class: 'lh-val mono' }));
      this.stats.append(h('span', { class: `lh-stat ${cls}` }, v.el, h('span', { class: 'lh-lab', text: label })));
      return v;
    };
    this.hits = stat('Hits', 'is-hits');
    this.misses = stat('Misses', 'is-miss');
    this.streak = stat('Streak', 'is-streak');
    this.acc = stat('Accuracy', 'is-acc');
    this.hint = new TextSlot(h('p', { class: 'lh-hint', hidden: true }));
    this.panel = h(
      'section',
      { class: 'learn-hud glass', 'aria-label': 'Learn mode', hidden: true },
      h('div', { class: 'lh-head' }, h('span', { class: 'lh-icon', 'aria-hidden': 'true' }), this.title.el, this.modeTag.el, this.count.el, close),
      h('div', { class: 'lh-bar', 'aria-hidden': 'true' }, this.fill),
      h('div', { class: 'lh-play' }, this.ribbon, this.count3.el),
      this.stats,
      this.hint.el,
    );
    this.panel.querySelector('.lh-icon')!.append(icon('learn'));

    // Finished card.
    const headId = `learn-done-${Math.random().toString(36).slice(2, 8)}`;
    this.cardHead = new TextSlot(h('p', { class: 'ld-kicker' }));
    this.cardTitle = new TextSlot(h('h2', { class: 'ld-title', id: headId }));
    this.cardStars = h('div', { class: 'ld-stars' });
    this.cardAcc = new TextSlot(h('p', { class: 'ld-acc mono' }));
    this.cardStats = new TextSlot(h('p', { class: 'ld-stats' }));
    this.cardBest = h('p', { class: 'ld-best', text: 'New personal best', hidden: true });
    const retry = h('button', { type: 'button', class: 'btn' });
    retry.append(icon('refresh'), h('span', { text: 'Retry' }));
    retry.addEventListener('click', () => this.st && deps.onLearn(this.st.songId, this.st.mode));
    this.nextBtn = h('button', { type: 'button', class: 'btn btn-primary' });
    this.nextBtn.append(icon('next'), h('span', { text: 'Next song' }));
    this.nextBtn.addEventListener('click', () => {
      if (!this.st) return;
      const list = deps.songs();
      const i = list.findIndex((s) => s.id === this.st!.songId);
      const next = list[(i + 1) % Math.max(1, list.length)];
      if (next) deps.onLearn(next.id, this.st.mode);
    });
    const exit = h('button', { type: 'button', class: 'btn' });
    exit.append(icon('exit'), h('span', { text: 'Exit' }));
    exit.addEventListener('click', () => deps.onLearn(null, this.st?.mode ?? 'wait'));
    this.card = h(
      'div',
      { class: 'learn-done', role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': headId, hidden: true },
      h(
        'div',
        { class: 'ld-card glass' },
        this.cardHead.el,
        this.cardTitle.el,
        this.cardStars,
        this.cardAcc.el,
        this.cardStats.el,
        this.cardBest,
        h('div', { class: 'btn-row ld-actions' }, retry, this.nextBtn, exit),
      ),
    );
  }

  get active(): boolean {
    return !!this.st;
  }

  /** Escape on the finished card leaves Learn mode. Returns true when it handled the key. */
  escape(): boolean {
    if (!this.st?.done) return false;
    this.deps.onLearn(null, this.st.mode);
    return true;
  }

  update(st: LearnState | null): void {
    this.st = st;
    if (!st) {
      if (this.songId) {
        this.songId = '';
        this.panel.hidden = true;
        this.card.hidden = true;
        this.done = false;
      }
      return;
    }
    if (st.songId !== this.songId || st.startedT !== this.startedT) this.reset(st);

    if (st.upcoming !== this.upcoming || st.index !== this.index) this.paintRibbon(st);
    this.paintStats(st);
    this.paintMeter(st);

    if (st.lastHitT !== this.hitT) {
      this.hitT = st.lastHitT;
      this.pulse('is-hit');
    }
    if (st.lastMissT !== this.missT) {
      this.missT = st.lastMissT;
      this.pulse('is-miss');
    }
    if (st.onLanes !== this.onLanes) {
      this.onLanes = st.onLanes;
      this.hint.set(st.onLanes ? '' : 'Some notes are off the lanes now. Retry to restore the song’s setup.');
      this.hint.el.hidden = st.onLanes;
    }
    if (st.done && !this.done) this.finish(st);
  }

  private reset(st: LearnState): void {
    this.songId = st.songId;
    this.startedT = st.startedT;
    this.done = false;
    this.index = -1;
    this.upcoming = null;
    this.hitT = st.lastHitT;
    this.missT = st.lastMissT;
    this.shownHits = this.shownMisses = this.shownStreak = this.shownAcc = -1;
    this.shownCount = '';
    this.meterShown = -1;
    this.onLanes = true;
    this.hint.el.hidden = true;
    this.title.set(st.title);
    this.modeTag.set(st.mode === 'tempo' ? 'Tempo' : 'Wait');
    setClass(this.panel, 'is-tempo', st.mode === 'tempo');
    this.card.hidden = true;
    this.panel.hidden = false;
  }

  private paintRibbon(st: LearnState): void {
    const advanced = this.index >= 0 && st.index > this.index;
    this.index = st.index;
    this.upcoming = st.upcoming;
    for (let i = 0; i < RIBBON; i++) {
      const n = st.upcoming[i];
      const c = this.chips[i]!;
      c.text.set(n ? n.note : '');
      setClass(c.el, 'is-empty', !n);
      setClass(c.el, 'is-off', !!n && n.laneIndex < 0);
    }
    this.count.set(`${Math.min(st.index + 1, st.total)} / ${st.total}`);
    this.fill.style.transform = `scaleX(${st.progress})`;
    this.chips[0]!.el.setAttribute('aria-label', st.target ? `Play ${st.target.note}` : '');
    if (advanced && !this.reduced) {
      this.ribbon.classList.remove('is-advance');
      void this.ribbon.offsetWidth; // restart the slide
      this.ribbon.classList.add('is-advance');
    }
  }

  private paintStats(st: LearnState): void {
    if (st.hits !== this.shownHits) this.hits.set(String((this.shownHits = st.hits)));
    if (st.misses !== this.shownMisses) this.misses.set(String((this.shownMisses = st.misses)));
    if (st.streak !== this.shownStreak) {
      this.shownStreak = st.streak;
      this.streak.set(String(st.streak));
      setClass(this.panel, 'is-hot', st.streak >= 5);
    }
    const pct = Math.round(st.accuracy * 100);
    if (pct !== this.shownAcc) this.acc.set(`${(this.shownAcc = pct)}%`);
  }

  /** Tempo mode: count-in beats, and how much of the target note's time has gone by. */
  private paintMeter(st: LearnState): void {
    if (st.mode !== 'tempo' || st.done) {
      if (this.shownCount) this.count3.set((this.shownCount = ''));
      return;
    }
    const countIn = st.songMs < 0 ? String(Math.ceil(-st.songMs / st.msPerBeat)) : '';
    if (countIn !== this.shownCount) {
      this.shownCount = countIn;
      this.count3.set(countIn);
      setClass(this.panel, 'is-countin', !!countIn);
    }
    const len = (st.target?.beats ?? 1) * st.msPerBeat;
    const f = Math.max(0, Math.min(1, (st.songMs - st.targetStartMs) / len));
    const q = Math.round(f * 100) / 100;
    if (q !== this.meterShown) {
      this.meterShown = q;
      this.meter.style.transform = `scaleX(${1 - q})`;
    }
  }

  private pulse(cls: 'is-hit' | 'is-miss'): void {
    if (this.reduced) return;
    this.panel.classList.remove(cls);
    void this.panel.offsetWidth;
    this.panel.classList.add(cls);
  }

  private finish(st: LearnState): void {
    this.done = true;
    const perfect = st.misses === 0 && st.hits === st.total;
    this.cardHead.set(perfect ? 'Flawless' : st.stars >= 2 ? 'Well played' : st.stars === 1 ? 'Song complete' : 'Keep practising');
    this.cardTitle.set(st.title);
    this.cardStars.replaceChildren(stars(st.stars, 'ld-star-row'));
    this.cardAcc.set(`${Math.round(st.accuracy * 100)}%`);
    const secs = Math.max(0, Math.round((st.finishedT - st.startedT) / 1000));
    const plural = (n: number, word: string, many: string): string => `${n} ${n === 1 ? word : many}`;
    this.cardStats.set(
      `${plural(st.hits, 'hit', 'hits')} · ${plural(st.misses, 'miss', 'misses')} · best streak ${st.bestStreak} · ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`,
    );
    this.cardBest.hidden = !st.newBest;
    this.count.set(`${st.total} / ${st.total}`);
    this.fill.style.transform = 'scaleX(1)';
    this.card.hidden = false;
    this.nextBtn.focus({ preventScroll: true });
  }
}

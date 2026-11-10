import type { InstrumentDef, Lane, ScaleDef, Settings, StageRenderData, VoiceState } from '../types';
import { NOTE_NAMES, TextSlot, formatClock, h, midiName, midiToHz, setClass } from './dom';

const BLACK = [false, true, false, true, false, false, true, false, true, false, true, false];

interface Cell {
  el: HTMLElement;
  value: TextSlot;
  sub: TextSlot;
}

function cell(label: string, cls: string): Cell {
  const value = h('span', { class: 'm-value' });
  const sub = h('span', { class: 'm-sub' });
  const el = h('div', { class: `m-cell ${cls}` }, h('span', { class: 'm-label', text: label }), h('span', { class: 'm-line' }, value, sub));
  return { el, value: new TextSlot(value), sub: new TextSlot(sub) };
}

/**
 * The musician's strip: key, chord, notes, volume, expression, tempo, counters, session time,
 * instruments, plus a mini keyboard. DOM text changes only when a value changes; meters move with
 * transforms (compositor only).
 */
export class MetricsStrip {
  readonly el: HTMLElement;
  private readonly key = cell('Key', 'm-key');
  private readonly chord = cell('Chord', 'm-chord');
  private readonly lead = cell('Lead', 'm-lead');
  private readonly left = cell('Left', 'm-left');
  private readonly vol = cell('Level', 'm-vol');
  private readonly expr = cell('Expression', 'm-expr');
  private readonly tempo = cell('Tempo', 'm-tempo');
  private readonly notes = cell('Notes', 'm-notes');
  private readonly session = cell('Session', 'm-session');
  private readonly inst = cell('Instruments', 'm-inst');
  private readonly volFill: HTMLElement;
  private readonly exprFill: HTMLElement;
  private readonly beatDots: HTMLElement[] = [];
  private readonly piano: MiniPiano;
  private readonly leftLabel: TextSlot;
  private lastBeat = -1;
  private lastBar = -1;
  private lastSlowAt = 0;
  private volShown = -1;
  private exprShown = -1;
  private lastDbAt = 0;
  private dbShown = 0;
  private vSmooth = 0;
  private instKey = '';

  constructor(private readonly instruments: Map<string, InstrumentDef>) {
    this.el = h('section', { class: 'metrics glass', 'aria-label': 'Live music metrics' });
    const row = h('div', { class: 'metrics-row' });

    this.volFill = h('span', { class: 'meter-fill' });
    this.vol.el.append(h('span', { class: 'meter seg', 'aria-hidden': 'true' }, this.volFill));
    this.exprFill = h('span', { class: 'meter-fill' });
    this.expr.el.append(h('span', { class: 'meter', 'aria-hidden': 'true' }, this.exprFill));
    const beats = h('span', { class: 'beats', 'aria-hidden': 'true' });
    for (let i = 0; i < 4; i++) {
      const d = h('span', { class: 'beat' });
      this.beatDots.push(d);
      beats.append(d);
    }
    this.tempo.el.append(beats);
    this.leftLabel = new TextSlot(this.left.el.querySelector('.m-label') as HTMLElement);

    row.append(
      this.key.el,
      this.chord.el,
      this.lead.el,
      this.left.el,
      this.vol.el,
      this.expr.el,
      this.tempo.el,
      this.notes.el,
      this.session.el,
      this.inst.el,
    );
    this.piano = new MiniPiano();
    this.el.append(row, this.piano.el);
  }

  setScale(settings: Settings, scales: readonly ScaleDef[]): void {
    const sc = scales.find((s) => s.id === settings.scale);
    this.piano.setScale(settings.key, sc?.intervals ?? []);
  }

  update(data: StageRenderData, settings: Settings, now: number): void {
    const m = data.metrics;
    let lead: VoiceState | null = null;
    let bass: VoiceState | null = null;
    for (const v of data.voices) {
      if (v.voice === 'lead') lead = v;
      else bass = v;
    }

    // Note names and the chord update every frame (they must stay in sync with the sound);
    // the numeric cells are refreshed ~12 times a second to keep string work low.
    const slow = now - this.lastSlowAt >= 80;
    if (slow) this.lastSlowAt = now;
    this.key.value.set(m.keyName || NOTE_NAMES[settings.key] || 'C');
    this.key.sub.set(m.scaleName);
    this.chord.value.set(m.chord || '—');
    this.chord.sub.set(m.roman);

    if (lead && lead.midi !== null) {
      this.lead.value.set(lead.note || midiName(lead.midi));
      if (slow) this.lead.sub.set(`${midiToHz(lead.midi).toFixed(lead.midi % 1 ? 1 : 0)} Hz`);
    } else {
      this.lead.value.set('—');
      this.lead.sub.set(lead?.active ? 'ready' : 'no hand');
    }
    setClass(this.lead.el, 'is-on', !!lead?.gate);

    switch (settings.mode === 'chords' ? 'style' : settings.leftHand) {
      case 'style':
        this.leftLabel.set('Style');
        this.left.value.set(m.chordStyle || '—');
        if (slow) this.left.sub.set(m.volumeHandId !== null ? `vol ${Math.round(m.handVolume * 100)}%` : '');
        break;
      case 'volume':
        this.leftLabel.set('Hand vol');
        if (slow) this.left.value.set(m.volumeHandId !== null ? `${Math.round(m.handVolume * 100)}%` : '—');
        this.left.sub.set(m.volumeHandId !== null ? '' : 'raise left');
        break;
      case 'bass':
        this.leftLabel.set('Bass');
        this.left.value.set(bass?.note || '—');
        this.left.sub.set(bass?.active ? '' : 'raise left');
        break;
      case 'chords':
        this.leftLabel.set('Chords');
        this.left.value.set(bass?.note || '—');
        this.left.sub.set(bass?.active ? '' : '1–5 fingers');
        break;
      default:
        this.leftLabel.set('Left');
        this.left.value.set('off');
        this.left.sub.set('');
    }
    setClass(this.left.el, 'is-on', !!bass?.gate);

    // Level: dB text at ~8 Hz, meter every frame (transform only).
    const db = m.levelDb;
    const norm = Number.isFinite(db) ? Math.max(0, Math.min(1, (db + 60) / 60)) : 0;
    this.vSmooth = norm > this.vSmooth ? norm : this.vSmooth + (norm - this.vSmooth) * 0.12;
    if (Math.abs(this.vSmooth - this.volShown) > 0.004) {
      this.volShown = this.vSmooth;
      this.volFill.style.transform = `scaleX(${this.vSmooth.toFixed(3)})`;
    }
    if (now - this.lastDbAt > 125) {
      this.lastDbAt = now;
      this.dbShown = Number.isFinite(db) && db > -90 ? Math.round(db) : -Infinity;
      this.vol.value.set(Number.isFinite(this.dbShown) ? `${this.dbShown}` : '-∞');
      this.vol.sub.set('dB');
    }
    const ex = Math.max(0, Math.min(1, m.expression));
    if (Math.abs(ex - this.exprShown) > 0.004) {
      this.exprShown = ex;
      this.exprFill.style.transform = `scaleX(${ex.toFixed(3)})`;
    }
    if (slow) {
      this.expr.value.set(`${Math.round(ex * 100)}`);
      this.expr.sub.set('%');
      this.tempo.value.set(`${m.bpm || settings.tempo}`);
      this.notes.value.set(`${m.notesPlayed}`);
      this.notes.sub.set(`${Math.round(m.notesPerMinute)}/min`);
      this.session.value.set(formatClock(m.sessionMs));
    }
    if (settings.groove && m.bar > 0) {
      if (m.beat !== this.lastBeat || m.bar !== this.lastBar) {
        this.lastBeat = m.beat;
        this.lastBar = m.bar;
        this.tempo.sub.set(`BPM ${m.bar}:${m.beat}`);
        this.beatDots.forEach((d, i) => setClass(d, 'on', i === (m.beat - 1) % 4));
      }
    } else {
      this.tempo.sub.set('BPM · off');
      if (this.lastBeat !== -1) {
        this.lastBeat = -1;
        for (const d of this.beatDots) setClass(d, 'on', false);
      }
    }
    setClass(this.tempo.el, 'is-off', !settings.groove);

    const lk = settings.leftHand === 'bass' || settings.leftHand === 'chords';
    const key = `${settings.lead}|${lk ? settings.bass : ''}`;
    if (key !== this.instKey) {
      this.instKey = key;
      const li = this.instruments.get(settings.lead);
      const bi = lk ? this.instruments.get(settings.bass) : undefined;
      this.inst.value.set(li?.name ?? settings.lead);
      this.inst.sub.set(bi ? `+ ${bi.name}` : '');
      this.el.style.setProperty('--lead', li?.color ?? '#3cf2ff');
      this.el.style.setProperty('--bass', bi?.color ?? '#ff6b8b');
    }

    this.piano.update(data.lanes.lead, m.activeMidi, lead);
  }
}

/** 2..4 octave keyboard around the lead play range; sounding keys light up. */
class MiniPiano {
  readonly el: HTMLElement;
  private lo = -1;
  private hi = -1;
  private keys: HTMLElement[] = [];
  private readonly state = new Uint8Array(128);
  private readonly want = new Uint8Array(128);
  private root = 0;
  private intervals: readonly number[] = [];

  constructor() {
    this.el = h('div', { class: 'piano', 'aria-hidden': 'true' });
  }

  setScale(root: number, intervals: readonly number[]): void {
    this.root = root;
    this.intervals = intervals;
    this.markScale();
  }

  update(lanes: readonly Lane[], active: readonly number[], lead: VoiceState | null): void {
    // Range from the lead lanes, whole octaves, 2..4 octaves.
    let mn = 60;
    let mx = 83;
    if (lanes.length) {
      mn = 127;
      mx = 0;
      for (const l of lanes) {
        if (l.midi < mn) mn = l.midi;
        if (l.midi > mx) mx = l.midi;
      }
    }
    let lo = Math.floor(Math.round(mn) / 12) * 12;
    let hi = Math.ceil((Math.round(mx) + 1) / 12) * 12 - 1;
    if (hi - lo + 1 < 24) hi = lo + 23;
    if (hi - lo + 1 > 48) hi = lo + 47;
    lo = Math.max(0, lo);
    hi = Math.min(127, hi);
    if (lo !== this.lo || hi !== this.hi) this.build(lo, hi);

    this.want.fill(0, this.lo, this.hi + 1);
    const leadMidi = lead && lead.midi !== null ? Math.round(lead.midi) : -1;
    for (const raw of active) {
      let n = Math.round(raw);
      const isLead = n === leadMidi;
      while (n < this.lo) n += 12;
      while (n > this.hi) n -= 12;
      if (n < this.lo) continue;
      this.want[n] = isLead ? 1 : this.want[n] === 1 ? 1 : 2;
    }
    for (let n = this.lo; n <= this.hi; n++) {
      const w = this.want[n]!;
      if (w === this.state[n]) continue;
      this.state[n] = w;
      const k = this.keys[n - this.lo]!;
      setClass(k, 'on-lead', w === 1);
      setClass(k, 'on-bass', w === 2);
    }
  }

  private build(lo: number, hi: number): void {
    this.lo = lo;
    this.hi = hi;
    this.state.fill(0);
    this.keys = [];
    const whites = h('div', { class: 'piano-keys' });
    let whiteCount = 0;
    for (let n = lo; n <= hi; n++) if (!BLACK[n % 12]) whiteCount++;
    let wi = 0;
    for (let n = lo; n <= hi; n++) {
      const black = BLACK[n % 12]!;
      const k = h('span', { class: black ? 'pk pk-b' : 'pk pk-w' });
      if (black) k.style.left = `${(wi / whiteCount) * 100}%`;
      else {
        wi++;
        if (n % 12 === 0) k.append(h('span', { class: 'pk-c', text: `C${n / 12 - 1}` }));
      }
      this.keys.push(k);
      whites.append(k);
    }
    this.el.style.setProperty('--whites', String(whiteCount));
    this.el.replaceChildren(whites);
    this.markScale();
  }

  private markScale(): void {
    if (this.lo < 0) return;
    const set = new Set(this.intervals.map((i) => (i + this.root) % 12));
    const all = this.intervals.length === 0;
    for (let n = this.lo; n <= this.hi; n++) {
      const pc = n % 12;
      const k = this.keys[n - this.lo]!;
      setClass(k, 'in-scale', !all && set.has(pc));
      setClass(k, 'is-root', pc === this.root);
    }
  }
}

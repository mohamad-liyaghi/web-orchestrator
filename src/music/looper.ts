/**
 * Note-event looper: up to four tracks of recorded notes, locked to the Transport.
 *
 * Recording taps the live players (both voices, every instrument), so a track holds exactly what
 * was played: pitch, velocity, the loudness the live channel had, duration and the instrument.
 * Start times are pulled halfway to the nearest sixteenth (the swung one when the beat swings),
 * so loops tighten up but still sound played. Each track plays back through its own player
 * instances, so the live voices stay free and changing the live instrument never changes a loop.
 *
 * Timing: the engine calls onGrid() one sixteenth ahead of every Transport sixteenth (the same
 * clock as the beat), and the looper schedules the notes of that sixteenth at exact audio times.
 * Notes are stored in Transport ticks, so loops follow tempo changes.
 *
 * A take lasts one loop: it starts at once when loops are already playing (overdub), at the next
 * bar when only the beat runs, or after a one-bar metronome count-in from silence. It stops by
 * itself after one pass, or earlier on request. Every take (and every clear) can be undone.
 */
import { Synth } from 'tone/build/esm/classes.js';
import type { Context } from 'tone/build/esm/core/context/Context.js';
import type { InputNode } from 'tone/build/esm/core/context/ToneAudioNode.js';
import type { LoopBars, LoopCommand, LoopNoteView, LooperState, LoopTrackState, VoiceId } from '../types';
import type { Player } from './players';

export const LOOP_TRACKS = 4;
/** Recorded notes per track (memory bound). */
const MAX_EVENTS = 384;
/** Different instruments per track (each needs its own player). */
const MAX_INSTRUMENTS = 6;
/** Notes the looper may hold at once across all tracks. */
const MAX_SOUNDING = 48;
const MAX_UNDO = 12;
/** How far a start moves toward the nearest sixteenth (0 = as played, 1 = hard quantize). */
const QUANTIZE = 0.5;
/** A press this close after a bar line still starts the take on that bar (ticks = a sixteenth). */
const LATE_PRESS_SIXTEENTHS = 1;

interface LoopEvent {
  /** Start in ticks from the loop start, 0 <= tick < loop length. */
  tick: number;
  dur: number;
  midi: number;
  velocity: number;
  /** Channel gain the live voice had (0..1), reproduced on playback. */
  gain: number;
  inst: string;
  voice: VoiceId;
  /** Absolute Transport tick before which the event must not play: it was just heard live. */
  notBefore: number;
}

interface Track {
  events: LoopEvent[];
  muted: boolean;
  solo: boolean;
  /** Audio time of the last note this track played (for the UI pulse). */
  pulseAt: number;
  dirty: boolean;
  readonly state: LoopTrackState;
}

interface Sounding {
  track: number;
  player: Player;
  handle: number;
  /** Absolute Transport tick of the note-off. */
  offTick: number;
}

interface Pending {
  track: number;
  voice: VoiceId;
  inst: string;
  midi: number;
  velocity: number;
  gain: number;
  /** Absolute Transport tick of the note-on. */
  tick: number;
}

interface Take {
  track: number;
  /** Absolute tick where recording starts (after the count-in) and where it stops by itself. */
  from: number;
  until: number;
  /** Count-in from silence: metronome clicks before `from`. */
  clicks: boolean;
  /** Nothing else is audible: keep a soft click going while recording. */
  guide: boolean;
  undo: UndoEntry;
  notes: number;
}

interface UndoEntry {
  tracks: Array<{ index: number; events: LoopEvent[] }>;
}

/** What the looper needs from the engine. */
export interface LooperHost {
  readonly ctx: Context;
  /** Where loop players play into (the instrument bus: reverb, compressor, master, recorder). */
  readonly output: InputNode;
  /** Where the count-in clicks go (straight to the speakers). */
  readonly clickOutput: InputNode;
  /** A fresh player for an instrument, or null when its samples are not loaded. */
  makePlayer(instrument: string): Player | null;
  /** Releases a player once its notes have faded. */
  retirePlayer(player: Player): void;
  /** The looper's need for the Transport changed (start / stop it). */
  clockChanged(): void;
  /** The Transport clock is running (the engine's grid callbacks are coming). */
  clockRunning(): boolean;
  grooveRunning(): boolean;
  /** Swing of the beat (fraction of a sixteenth the off-sixteenths are late), 0 when no beat. */
  swing(): number;
}

const mod = (a: number, n: number): number => ((a % n) + n) % n;

function makeTrackState(index: number): LoopTrackState {
  return { index, notes: 0, muted: false, solo: false, audible: false, recording: false, instruments: [], view: [], pulse: 0 };
}

export class Looper {
  private readonly tracks: Track[] = [];
  private bars: LoopBars = 2;
  /** Absolute tick of a loop start (bar aligned), null while there is nothing to play. */
  private origin: number | null = null;
  private take: Take | null = null;
  private readonly pending = new Map<number, Pending>();
  private readonly sounding: Sounding[] = [];
  private readonly players = new Map<string, Player>();
  private readonly undoStack: UndoEntry[] = [];
  private click: Synth | null = null;
  private disposed = false;
  private readonly st: LooperState;

  constructor(private readonly host: LooperHost) {
    for (let i = 0; i < LOOP_TRACKS; i++) {
      const state = makeTrackState(i);
      this.tracks.push({ events: [], muted: false, solo: false, pulseAt: -Infinity, dirty: false, state });
    }
    this.st = {
      bars: this.bars,
      phase: 'idle',
      recordTrack: -1,
      countIn: 0,
      progress: 0,
      takeProgress: 0,
      seconds: 0,
      tracks: this.tracks.map((t) => t.state),
      canUndo: false,
      version: 0,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Timing helpers
  // -------------------------------------------------------------------------------------------

  private get ppq(): number {
    return this.host.ctx.transport.PPQ;
  }
  private get sixteenthTicks(): number {
    return this.ppq / 4;
  }
  private get barTicks(): number {
    return this.ppq * 4;
  }
  private get loopTicks(): number {
    return this.barTicks * this.bars;
  }

  private ticksAt(time: number): number {
    return this.host.ctx.transport.getTicksAtTime(time);
  }

  private nowTicks(): number {
    return this.ticksAt(this.host.ctx.currentTime);
  }

  /** Pulls a loop-relative tick halfway toward the nearest (swung) sixteenth. */
  private quantize(tick: number): number {
    const six = this.sixteenthTicks;
    const swing = this.host.grooveRunning() ? this.host.swing() * six : 0;
    const base = Math.floor(tick / six);
    let best = tick;
    let bestDist = Infinity;
    for (let s = base - 1; s <= base + 1; s++) {
      const g = s * six + (s % 2 !== 0 ? swing : 0);
      const d = Math.abs(g - tick);
      if (d < bestDist) {
        bestDist = d;
        best = g;
      }
    }
    return tick + (best - tick) * QUANTIZE;
  }

  get hasContent(): boolean {
    for (const t of this.tracks) if (t.events.length) return true;
    return false;
  }

  /** The Transport must run: loops to play or a take under way. */
  get needsClock(): boolean {
    return this.take !== null || this.hasContent;
  }

  private soloing(): boolean {
    for (const x of this.tracks) if (x.solo && x.events.length) return true;
    return false;
  }

  private audible(t: Track, soloing = this.soloing()): boolean {
    if (!t.events.length || t.muted) return false;
    return !soloing || t.solo;
  }

  // -------------------------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------------------------

  run(cmd: LoopCommand): string {
    if (this.disposed) return '';
    switch (cmd.type) {
      case 'record':
        return this.toggleRecord(cmd.track);
      case 'stop':
        return this.take ? this.finishTake(this.nowTicks()) : '';
      case 'clear':
        return this.clear(cmd.track);
      case 'clear-all':
        return this.clearAll();
      case 'mute':
        return this.flag(cmd.track, 'muted');
      case 'solo':
        return this.flag(cmd.track, 'solo');
      case 'undo':
        return this.undo();
      case 'reset':
        this.reset();
        return '';
      default:
        return '';
    }
  }

  private validTrack(i: number | undefined): i is number {
    return typeof i === 'number' && Number.isInteger(i) && i >= 0 && i < LOOP_TRACKS;
  }

  private toggleRecord(track?: number): string {
    if (this.take && (track === undefined || track === this.take.track)) return this.finishTake(this.nowTicks());
    let target = track;
    if (target === undefined) {
      target = this.tracks.findIndex((t) => !t.events.length);
      if (target < 0) return 'All 4 loop tracks are full: clear one first';
    }
    if (!this.validTrack(target)) return '';
    if (this.take) this.finishTake(this.nowTicks());
    return this.startTake(target);
  }

  private startTake(track: number): string {
    const L = this.loopTicks;
    const bar = this.barTicks;
    const undo: UndoEntry = { tracks: [{ index: track, events: this.tracks[track]!.events.slice() }] };
    const others = this.tracks.some((t, i) => i !== track && this.audible(t));
    let from: number;
    let clicks = false;
    if (!this.host.clockRunning()) {
      // From silence: the clock starts at tick 0, one bar of clicks, then recording.
      this.origin = bar;
      from = bar;
      clicks = true;
    } else if (this.origin === null) {
      // The beat (or an arpeggio) is running, no loops yet: start on a bar line.
      const now = this.nowTicks();
      const k = Math.floor(now / bar);
      from = (now - k * bar < this.sixteenthTicks * LATE_PRESS_SIXTEENTHS ? k : k + 1) * bar;
      this.origin = from;
      clicks = !this.host.grooveRunning();
    } else {
      // Loops are playing: overdub from right now, for one full pass.
      from = Math.max(0, Math.floor(this.nowTicks()));
    }
    this.take = { track, from, until: from + L, clicks, guide: !others && !this.host.grooveRunning(), undo, notes: 0 };
    this.tracks[track]!.dirty = true;
    this.bump();
    this.host.clockChanged();
    return clicks || from > this.nowTicks() + this.sixteenthTicks ? `Loop ${track + 1}: count-in…` : `Loop ${track + 1}: recording`;
  }

  /** Ends the take at `endTick`, closing notes still held. Returns a label. */
  private finishTake(endTick: number): string {
    const take = this.take;
    if (!take) return '';
    for (const [handle, p] of this.pending) {
      if (p.track === take.track) {
        this.commit(p, Math.min(endTick, take.until));
        this.pending.delete(handle);
      }
    }
    this.take = null;
    const track = this.tracks[take.track]!;
    track.dirty = true;
    if (take.notes > 0) this.pushUndo(take.undo);
    if (!this.hasContent) this.origin = null;
    this.bump();
    this.host.clockChanged();
    return take.notes > 0 ? `Loop ${take.track + 1}: ${take.notes} note${take.notes === 1 ? '' : 's'} saved` : `Loop ${take.track + 1}: nothing recorded`;
  }

  private clear(i: number): string {
    if (!this.validTrack(i)) return '';
    if (this.take?.track === i) this.cancelTake();
    const t = this.tracks[i]!;
    if (!t.events.length) return '';
    this.pushUndo({ tracks: [{ index: i, events: t.events }] });
    t.events = [];
    t.solo = false;
    t.muted = false;
    this.stopTrack(i, 0.08);
    this.afterContentChange();
    return `Loop ${i + 1} cleared`;
  }

  private clearAll(): string {
    if (this.take) this.cancelTake();
    const entry: UndoEntry = { tracks: [] };
    this.tracks.forEach((t, index) => {
      if (t.events.length) entry.tracks.push({ index, events: t.events });
      t.events = [];
      t.solo = false;
      t.muted = false;
    });
    this.stopAllSounding(0.08);
    if (!entry.tracks.length) return '';
    this.pushUndo(entry);
    this.afterContentChange();
    return 'All loops cleared';
  }

  private flag(i: number, which: 'muted' | 'solo'): string {
    if (!this.validTrack(i)) return '';
    const t = this.tracks[i]!;
    t[which] = !t[which];
    // Anything that just went silent lets go of its notes now.
    this.tracks.forEach((x, k) => {
      if (!this.audible(x)) this.stopTrack(k, 0.06);
    });
    this.bump();
    if (which === 'muted') return `Loop ${i + 1} ${t.muted ? 'muted' : 'unmuted'}`;
    return t.solo ? `Loop ${i + 1} solo` : `Loop ${i + 1} solo off`;
  }

  private undo(): string {
    if (this.take) {
      const track = this.take.track;
      this.cancelTake();
      return `Loop ${track + 1}: take discarded`;
    }
    const entry = this.undoStack.pop();
    if (!entry) return 'Nothing to undo';
    for (const { index, events } of entry.tracks) {
      this.tracks[index]!.events = events;
      this.stopTrack(index, 0.06);
    }
    if (this.origin === null && this.hasContent && this.host.clockRunning()) {
      this.origin = Math.floor(this.nowTicks() / this.barTicks) * this.barTicks;
    }
    this.afterContentChange();
    const names = entry.tracks.map((t) => t.index + 1).join(', ');
    return `Undo: loop ${names} restored`;
  }

  /** Drops the current take: the track goes back to what it was before. */
  private cancelTake(): void {
    const take = this.take;
    if (!take) return;
    for (const [handle, p] of this.pending) if (p.track === take.track) this.pending.delete(handle);
    this.take = null;
    for (const { index, events } of take.undo.tracks) this.tracks[index]!.events = events;
    this.stopTrack(take.track, 0.06);
    this.afterContentChange();
  }

  setBars(bars: LoopBars): void {
    if (bars === this.bars) return;
    if (this.take) this.finishTake(this.nowTicks());
    const oldL = this.loopTicks;
    this.bars = bars;
    const L = this.loopTicks;
    for (const t of this.tracks) {
      if (!t.events.length) continue;
      let next: LoopEvent[];
      if (L > oldL) {
        // Longer loop: repeat what is there so the music keeps going.
        next = [];
        for (let k = 0; k < L / oldL; k++) for (const e of t.events) next.push({ ...e, tick: e.tick + k * oldL, notBefore: 0 });
      } else {
        next = t.events.filter((e) => e.tick < L).map((e) => ({ ...e, dur: Math.min(e.dur, L - 12) }));
      }
      t.events = next.slice(0, MAX_EVENTS);
      t.dirty = true;
    }
    // Recorded positions changed meaning; old snapshots cannot come back.
    this.undoStack.length = 0;
    this.stopAllSounding(0.06);
    // The loop start stays put: a longer loop repeats the old one, so playback continues seamlessly.
    this.afterContentChange();
  }

  private afterContentChange(): void {
    for (const t of this.tracks) t.dirty = true;
    if (!this.hasContent && !this.take) this.origin = null;
    this.collectPlayers();
    this.bump();
    this.host.clockChanged();
  }

  private pushUndo(e: UndoEntry): void {
    this.undoStack.push(e);
    if (this.undoStack.length > MAX_UNDO) this.undoStack.shift();
  }

  private bump(): void {
    this.st.version++;
  }

  // -------------------------------------------------------------------------------------------
  // Recording (taps on the live players)
  // -------------------------------------------------------------------------------------------

  /** True while notes are captured (or about to be: the end of a count-in). */
  get capturing(): boolean {
    return this.take !== null;
  }

  noteOn(voice: VoiceId, inst: string, handle: number, midi: number, velocity: number, gain: number, time: number): void {
    const take = this.take;
    if (!take || !this.host.clockRunning()) return;
    const tick = this.ticksAt(time);
    // A note a hair before the downbeat belongs to it; earlier count-in notes are ignored.
    if (tick < take.from - this.sixteenthTicks / 2 || tick >= take.until) return;
    if (!this.ensurePlayer(take.track, inst)) return;
    this.pending.set(handle, { track: take.track, voice, inst, midi: Math.round(midi), velocity, gain, tick });
    if (this.pending.size > 64) {
      const first = this.pending.keys().next().value;
      if (first !== undefined) this.pending.delete(first);
    }
  }

  noteGlide(handle: number, midi: number, time: number): void {
    const p = this.pending.get(handle);
    if (!p || Math.round(midi) === p.midi) return;
    const tick = this.ticksAt(time);
    this.commit(p, tick);
    this.pending.set(handle, { ...p, midi: Math.round(midi), tick });
  }

  noteOff(handle: number, time: number): void {
    const p = this.pending.get(handle);
    if (!p) return;
    this.pending.delete(handle);
    this.commit(p, this.ticksAt(time));
  }

  /** A note scheduled ahead was withdrawn before it sounded: it never happened. */
  noteCancel(handle: number): void {
    this.pending.delete(handle);
  }

  /** The live channel level of a voice this frame: notes being recorded keep their peak. */
  voiceLevel(voice: VoiceId, gain: number): void {
    if (!this.pending.size) return;
    for (const p of this.pending.values()) if (p.voice === voice && gain > p.gain) p.gain = gain;
  }

  private commit(p: Pending, endTick: number): void {
    const take = this.take;
    const origin = this.origin;
    if (!take || origin === null || take.track !== p.track) return;
    const track = this.tracks[p.track]!;
    if (track.events.length >= MAX_EVENTS) return;
    const L = this.loopTicks;
    const tick = mod(Math.round(this.quantize(p.tick - origin)), L);
    const dur = Math.max(this.sixteenthTicks / 2, Math.min(L - 12, Math.round(endTick - p.tick)));
    const e: LoopEvent = {
      tick,
      dur,
      midi: p.midi,
      velocity: p.velocity,
      gain: Math.max(0.05, Math.min(1, p.gain)),
      inst: p.inst,
      voice: p.voice,
      notBefore: p.tick + L / 2,
    };
    // Sorted insert by start tick.
    const ev = track.events;
    let i = ev.length;
    while (i > 0 && ev[i - 1]!.tick > tick) i--;
    ev.splice(i, 0, e);
    take.notes++;
    track.dirty = true;
    this.bump();
  }

  // -------------------------------------------------------------------------------------------
  // Playback
  // -------------------------------------------------------------------------------------------

  private key(track: number, inst: string): string {
    return `${track}:${inst}`;
  }

  private ensurePlayer(track: number, inst: string): boolean {
    const k = this.key(track, inst);
    if (this.players.has(k)) return true;
    let count = 0;
    for (const key of this.players.keys()) if (key.startsWith(`${track}:`)) count++;
    if (count >= MAX_INSTRUMENTS) return false;
    const p = this.host.makePlayer(inst);
    if (!p) return false;
    p.output.connect(this.host.output);
    this.players.set(k, p);
    return true;
  }

  /** Releases players nothing refers to any more (tracks, the take, the undo history). */
  private collectPlayers(): void {
    const used = new Set<string>();
    const add = (index: number, events: readonly LoopEvent[]): void => {
      for (const e of events) used.add(this.key(index, e.inst));
    };
    this.tracks.forEach((t, i) => add(i, t.events));
    for (const u of this.undoStack) for (const t of u.tracks) add(t.index, t.events);
    if (this.take) for (const p of this.pending.values()) used.add(this.key(p.track, p.inst));
    for (const [k, p] of this.players) {
      if (used.has(k) || (this.take && k.startsWith(`${this.take.track}:`))) continue;
      for (let i = this.sounding.length - 1; i >= 0; i--) if (this.sounding[i]!.player === p) this.sounding.splice(i, 1);
      this.players.delete(k);
      this.host.retirePlayer(p);
    }
  }

  /** Instruments the looper still needs (the engine keeps their samples cached). */
  instrumentsInUse(into: Set<string>): void {
    for (const k of this.players.keys()) into.add(k.slice(k.indexOf(':') + 1));
  }

  /** Transport (re)started at tick 0 without a take: loops start from the top. */
  onClockStart(): void {
    // Ticks start over: "just heard live" marks from the old timeline mean nothing now.
    for (const t of this.tracks) for (const e of t.events) e.notBefore = 0;
    for (const u of this.undoStack) for (const t of u.tracks) for (const e of t.events) e.notBefore = 0;
    if (!this.take && this.hasContent) this.origin = 0;
  }

  /** Called one sixteenth ahead of every Transport sixteenth `step`, which sounds at `time`. */
  onGrid(step: number, time: number, sixteenth: number): void {
    if (this.disposed) return;
    const six = this.sixteenthTicks;
    const t0 = step * six;
    const t1 = t0 + six;
    const spt = sixteenth / six;
    const take = this.take;

    // A take ends after one pass (notes still held are cut at the loop point).
    if (take && t0 > take.until) this.finishTake(take.until);
    const tk = this.take;
    if (tk && !this.host.grooveRunning() && t0 % this.ppq === 0) {
      if (tk.clicks && t0 < tk.from && t0 >= tk.from - this.barTicks) this.metronome(time, t0 === tk.from - this.barTicks ? 1 : 0.7);
      else if (tk.guide && t0 >= tk.from) this.metronome(time, t0 % this.barTicks === tk.from % this.barTicks ? 0.45 : 0.28);
    }

    const origin = this.origin;
    if (origin !== null && t0 >= origin) {
      const L = this.loopTicks;
      const rel = mod(t0 - origin, L);
      const relEnd = rel + six;
      const soloing = this.soloing();
      for (let index = 0; index < this.tracks.length; index++) {
        const t = this.tracks[index]!;
        if (!this.audible(t, soloing)) continue;
        const ev = t.events;
        // First event at or after `rel` (events are sorted by tick).
        let lo = 0;
        let hi = ev.length;
        while (lo < hi) {
          const m = (lo + hi) >> 1;
          if (ev[m]!.tick < rel) lo = m + 1;
          else hi = m;
        }
        for (let i = lo; i < ev.length; i++) {
          const e = ev[i]!;
          if (e.tick >= relEnd) break;
          const abs = t0 + (e.tick - rel);
          if (abs < e.notBefore) continue;
          const player = this.players.get(this.key(index, e.inst));
          if (!player) continue;
          const at = time + (e.tick - rel) * spt;
          const handle = player.start(e.midi, e.velocity, at, e.gain);
          if (handle < 0) continue;
          if (this.sounding.length >= MAX_SOUNDING) {
            const old = this.sounding.shift()!;
            old.player.stop(old.handle, at, 0.05);
          }
          this.sounding.push({ track: index, player, handle, offTick: abs + e.dur });
          t.pulseAt = at;
        }
      }
    }

    // Note-offs due in this sixteenth (including notes that just started), at their exact time.
    for (let i = this.sounding.length - 1; i >= 0; i--) {
      const s = this.sounding[i]!;
      if (s.offTick >= t1) continue;
      s.player.stop(s.handle, time + Math.max(0, s.offTick - t0) * spt);
      this.sounding.splice(i, 1);
    }
  }

  private metronome(time: number, level: number): void {
    if (!this.click) {
      this.click = new Synth({
        oscillator: { type: 'sine' },
        envelope: { attack: 0.001, decay: 0.06, sustain: 0, release: 0.02 },
        volume: -10,
      });
      this.click.connect(this.host.clickOutput);
    }
    this.click.triggerAttackRelease(level >= 1 ? 1760 : 1320, 0.03, time, level);
  }

  private stopTrack(index: number, release: number): void {
    const now = this.host.ctx.currentTime;
    for (let i = this.sounding.length - 1; i >= 0; i--) {
      const s = this.sounding[i]!;
      if (s.track !== index) continue;
      s.player.stop(s.handle, now, release);
      this.sounding.splice(i, 1);
    }
  }

  private stopAllSounding(release: number): void {
    const now = this.host.ctx.currentTime;
    for (const s of this.sounding) s.player.stop(s.handle, now, release);
    this.sounding.length = 0;
    // Also anything scheduled ahead that already started inside a player.
    for (const p of this.players.values()) p.stopAll(now, release);
  }

  /** Everything goes: loops, undo history, players. */
  private reset(): void {
    this.take = null;
    this.pending.clear();
    this.stopAllSounding(0.03);
    for (const t of this.tracks) {
      t.events = [];
      t.muted = t.solo = false;
    }
    this.undoStack.length = 0;
    this.origin = null;
    this.afterContentChange();
  }

  /** Silence now and end any take (tab hidden, exit). Recorded loops stay. */
  panic(): void {
    if (this.take) this.finishTake(this.nowTicks());
    this.pending.clear();
    this.stopAllSounding(0.03);
    // The Transport is stopped by the engine; loops restart from the top with it.
    this.origin = null;
    this.bump();
  }

  /** Beats into the loop (0-based) sounding now, -1 when no loop runs. */
  loopBeat(): number {
    const origin = this.origin;
    if (origin === null || !this.host.clockRunning() || this.host.ctx.transport.state !== 'started') return -1;
    const now = this.nowTicks();
    if (now < origin) return -1;
    return Math.floor(mod(now - origin, this.loopTicks) / this.ppq);
  }

  /** Number of notes the looper holds right now (tests: no stuck notes). */
  get soundingCount(): number {
    let n = 0;
    for (const p of this.players.values()) n += p.activeCount;
    return n;
  }

  get playerCount(): number {
    return this.players.size;
  }

  // -------------------------------------------------------------------------------------------
  // State for the UI
  // -------------------------------------------------------------------------------------------

  state(): LooperState {
    const st = this.st;
    const ctx = this.host.ctx;
    const running = this.host.clockRunning() && ctx.transport.state === 'started';
    const now = running ? this.nowTicks() : 0;
    const L = this.loopTicks;
    const take = this.take;
    st.bars = this.bars;
    st.seconds = (L / this.ppq) * (60 / Math.max(1, ctx.transport.bpm.value));
    st.recordTrack = take ? take.track : -1;
    st.countIn = 0;
    st.takeProgress = 0;
    if (take && (!running || now < take.from)) {
      st.phase = 'count-in';
      st.countIn = running ? Math.min(4, Math.max(1, Math.ceil((take.from - now) / this.ppq))) : 4;
    } else if (take) {
      st.phase = 'recording';
      st.takeProgress = Math.min(1, Math.max(0, (now - take.from) / L));
    } else {
      st.phase = this.hasContent ? 'playing' : 'idle';
    }
    st.progress = running && this.origin !== null && now >= this.origin ? mod(now - this.origin, L) / L : 0;
    st.canUndo = !!take || this.undoStack.length > 0;
    const t = ctx.currentTime;
    const soloing = this.soloing();
    for (let i = 0; i < this.tracks.length; i++) {
      const tr = this.tracks[i]!;
      const s = tr.state;
      s.notes = tr.events.length;
      s.muted = tr.muted;
      s.solo = tr.solo;
      s.audible = this.audible(tr, soloing);
      s.recording = take?.track === i;
      s.pulse = s.audible ? Math.max(0, 1 - (t - tr.pulseAt) / 0.3) : 0;
      if (t < tr.pulseAt) s.pulse = 0;
      if (tr.dirty) {
        tr.dirty = false;
        const view: LoopNoteView[] = [];
        const insts: string[] = [];
        for (const e of tr.events) {
          view.push({ start: e.tick / L, length: e.dur / L, midi: e.midi, voice: e.voice, instrument: e.inst });
          if (!insts.includes(e.inst)) insts.push(e.inst);
        }
        s.view = view;
        s.instruments = insts;
      }
    }
    return st;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.take = null;
    this.pending.clear();
    this.sounding.length = 0;
    for (const p of this.players.values()) p.dispose();
    this.players.clear();
    this.click?.dispose();
    this.click = null;
    for (const t of this.tracks) t.events = [];
    this.undoStack.length = 0;
  }
}

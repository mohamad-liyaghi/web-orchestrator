import type { Lane, LearnMode, LearnNote, LearnState, VoiceState } from '../types';
import type { Song } from './songs';

/**
 * Scores a song played on the lead voice. Fed once per tracking frame with the lead VoiceState
 * and the lead lanes; owns one LearnState object that it mutates in place.
 *
 * HIT: a new note onset on the target pitch.
 * MISS: an onset on another pitch that is held (or released) instead of moving on. Sliding
 * through neighbour lanes is free: with the gate closed nothing sounds, and with the gate open a
 * wrong note left within GRACE_MS is forgiven. At most one miss per song note.
 *
 * wait mode: the song waits on each note until it is hit.
 * tempo mode: after a one-bar count-in the notes move on at the song tempo; a note may be played
 * up to EARLY_MS before its time and until the next note starts (or reached early and held into
 * its time); a note never hit is a miss.
 */

const GRACE_MS = 140;
/** Wrong notes right after (re)starting a song are not counted: the hand is still getting there. */
const START_GRACE_MS = 800;
const EARLY_MS = 160;
/** Frames stopping this long (hidden tab, stalled camera) pause the tempo clock. */
const PAUSE_GAP_MS = 400;
/** Target + following notes in the ribbon. */
const RIBBON = 7;
/** Octave shifts tried, in order, to put the song on the lanes it is given. */
const SHIFTS = [0, 12, -12, 24, -24];
const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export const noteName = (m: number): string => `${NAMES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;

export function starsFor(accuracy: number): number {
  return accuracy >= 0.95 ? 3 : accuracy >= 0.8 ? 2 : accuracy >= 0.5 ? 1 : 0;
}

export class LearnController {
  private song: Song | null = null;
  private st: LearnState | null = null;
  /** Per note: 1 once hit / once a miss was counted. */
  private hit = new Uint8Array(0);
  private missed = new Uint8Array(0);
  /** Note start times on the song clock (ms). */
  private starts = new Float64Array(0);
  private songEndMs = 0;
  private clean = 0;
  private shift = 0;
  private laneRef: readonly Lane[] | null = null;
  private laneLen = -1;
  private laneTop = -1;
  private lanes: readonly Lane[] = [];
  /** Wrong note under probation: its pitch and when it started (-1 = none). */
  private pendingMidi = -1;
  private pendingT = 0;
  private prevMidi = -1;
  private clock0 = 0;
  private lastT = 0;
  /** Window index in tempo mode (the note whose time it is). */
  private windowIx = 0;

  get state(): LearnState | null {
    return this.st;
  }

  get current(): Song | null {
    return this.song;
  }

  /** Starts a song; tempo mode counts one bar in first unless `countIn` is off. */
  start(song: Song, mode: LearnMode, t: number, countIn = true): void {
    const n = song.notes.length;
    this.song = song;
    this.hit = new Uint8Array(n);
    this.missed = new Uint8Array(n);
    this.starts = new Float64Array(n);
    const msPerBeat = 60000 / song.bpm;
    let acc = 0;
    for (let i = 0; i < n; i++) {
      this.starts[i] = acc;
      acc += song.notes[i]!.beats * msPerBeat;
    }
    this.songEndMs = acc;
    this.clean = 0;
    this.shift = 0;
    this.laneRef = null;
    this.laneLen = -1;
    this.laneTop = -1;
    this.lanes = [];
    this.pendingMidi = -1;
    this.prevMidi = -1;
    this.windowIx = 0;
    this.lastT = t;
    // Tempo mode: one bar of count-in before the first note (none when the count-in is off).
    const lead = mode === 'tempo' && countIn ? song.beatsPerBar * msPerBeat : 0;
    this.clock0 = t + lead;
    this.st = {
      songId: song.id,
      title: song.title,
      mode,
      index: 0,
      total: n,
      target: null,
      upcoming: [],
      hits: 0,
      misses: 0,
      streak: 0,
      bestStreak: 0,
      accuracy: 1,
      progress: 0,
      done: false,
      stars: 0,
      newBest: false,
      lastHitT: 0,
      lastMissT: 0,
      startedT: t,
      finishedT: 0,
      msPerBeat,
      songMs: -lead,
      targetStartMs: 0,
      onLanes: true,
    };
    this.refreshNotes();
  }

  stop(): void {
    this.song = null;
    this.st = null;
  }

  /**
   * One tracking frame. `lead` is null when the lead voice should not be judged (no lead voice,
   * chords mode). Returns true on the frame the song finishes.
   */
  update(lead: VoiceState | null, lanes: readonly Lane[], t: number): boolean {
    const st = this.st;
    if (!st || st.done) return false;
    this.syncLanes(lanes);

    if (st.mode === 'tempo') {
      // No lead to judge (chords mode): hold the song clock, or every note would pass as a miss.
      if (!lead || t - this.lastT > PAUSE_GAP_MS) this.clock0 += t - this.lastT;
      st.songMs = t - this.clock0;
      this.advanceWindows(t);
      if (st.done) {
        this.lastT = t;
        return true;
      }
    }
    this.lastT = t;

    if (lead && lead.active) {
      const m = lead.midi === null ? -1 : Math.round(lead.midi);
      // Own onset detection on top of VoiceState.onset: a pitch change while the gate stays open is
      // a new note too, whatever the engine reports for legato changes.
      const onset = lead.gate && m >= 0 && (lead.onset || m !== this.prevMidi);
      this.prevMidi = lead.gate ? m : -1;
      if (onset) this.judgeOnset(m, t);
      else if (st.mode === 'tempo' && lead.gate && m >= 0) this.judgeHeld(m, t);
      if (this.pendingMidi >= 0) {
        if (!lead.gate) this.commitMiss(t);
        else if (m !== this.pendingMidi) this.pendingMidi = -1; // moved on; a new onset judges it
        else if (t - this.pendingT >= GRACE_MS) this.commitMiss(t);
      }
    } else {
      this.prevMidi = -1;
      this.pendingMidi = -1;
    }
    if (st.done) return true;
    if (st.mode === 'tempo') this.retarget();
    return false;
  }

  // -------------------------------------------------------------------------------------------

  private judgeOnset(m: number, t: number): void {
    const st = this.st!;
    const j = this.judgeIndex();
    if (j < 0) {
      // Tempo mode between notes (the current one is already hit, the next not due yet) or the
      // count-in: re-articulating or noodling is not judged.
      this.pendingMidi = -1;
      return;
    }
    if (m === this.song!.notes[j]!.midi + this.shift) {
      this.pendingMidi = -1;
      this.hitNote(j, t);
      return;
    }
    // In tempo mode the previous note may still be ringing in its window: a fresh onset on it is fine.
    if (st.mode === 'tempo' && j > 0 && this.hit[j - 1] && m === this.song!.notes[j - 1]!.midi + this.shift) {
      this.pendingMidi = -1;
      return;
    }
    this.pendingMidi = m;
    this.pendingT = t;
  }

  /**
   * Tempo mode legato: a note reached early (gate open, before its window) and held into its window
   * counts as played. A repeated pitch still needs a fresh onset.
   */
  private judgeHeld(m: number, t: number): void {
    const j = this.judgeIndex();
    if (j < 0) return;
    const notes = this.song!.notes;
    if (m !== notes[j]!.midi + this.shift || (j > 0 && notes[j - 1]!.midi === notes[j]!.midi)) return;
    this.pendingMidi = -1;
    this.hitNote(j, t);
  }

  /** Note an onset is judged against, -1 when none is due. */
  private judgeIndex(): number {
    const st = this.st!;
    if (st.mode === 'wait') return st.index < st.total ? st.index : -1;
    for (let k = this.windowIx; k < st.total; k++) {
      if (this.hit[k]) continue;
      return st.songMs >= this.starts[k]! - EARLY_MS ? k : -1;
    }
    return -1;
  }

  private hitNote(j: number, t: number): void {
    const st = this.st!;
    if (this.hit[j]) return;
    this.hit[j] = 1;
    st.hits++;
    if (this.missed[j]) {
      st.streak = 0;
    } else {
      this.clean++;
      st.streak++;
      if (st.streak > st.bestStreak) st.bestStreak = st.streak;
    }
    st.lastHitT = t;
    this.score();
    if (st.mode === 'wait') {
      st.index = j + 1;
      if (st.index >= st.total) this.finish(t);
      else this.refreshNotes();
    } else if (j === st.total - 1) {
      this.finish(t);
    } else {
      this.retarget();
    }
  }

  private commitMiss(t: number): void {
    this.pendingMidi = -1;
    if (t - this.st!.startedT < START_GRACE_MS) return;
    const j = this.judgeIndex();
    if (j < 0) return;
    this.missNote(j, t);
  }

  private missNote(j: number, t: number): void {
    const st = this.st!;
    if (!this.missed[j]) {
      this.missed[j] = 1;
      st.misses++;
    }
    st.streak = 0;
    st.lastMissT = t;
    this.score();
  }

  /** Tempo mode: close every window that has passed; unplayed notes there are misses. */
  private advanceWindows(t: number): void {
    const st = this.st!;
    while (this.windowIx < st.total) {
      const end = this.windowIx + 1 < st.total ? this.starts[this.windowIx + 1]! : this.songEndMs;
      if (st.songMs < end) break;
      if (!this.hit[this.windowIx]) this.missNote(this.windowIx, t);
      this.windowIx++;
    }
    if (this.windowIx >= st.total) this.finish(t);
  }

  /** Tempo mode: the target is the first note not yet hit from the current window on. */
  private retarget(): void {
    const st = this.st!;
    let k = this.windowIx;
    while (k < st.total && this.hit[k]) k++;
    if (k !== st.index) {
      st.index = k;
      this.refreshNotes();
    }
  }

  private score(): void {
    const st = this.st!;
    const judged = this.clean + st.misses;
    st.accuracy = judged ? this.clean / judged : 1;
  }

  private finish(t: number): void {
    const st = this.st!;
    st.done = true;
    st.finishedT = t;
    st.index = st.total;
    st.progress = 1;
    st.target = null;
    st.upcoming = [];
    st.stars = starsFor(st.accuracy);
    this.pendingMidi = -1;
  }

  /** Re-map the song onto new lanes (start, or the user changed key / scale / octave / span). */
  private syncLanes(lanes: readonly Lane[]): void {
    const top = lanes.length ? lanes[0]!.midi : -1;
    if (lanes === this.laneRef && lanes.length === this.laneLen && top === this.laneTop) return;
    this.laneRef = lanes;
    this.laneLen = lanes.length;
    this.laneTop = top;
    this.lanes = lanes;
    const notes = this.song!.notes;
    let best = 0;
    let bestCount = -1;
    for (const s of SHIFTS) {
      let count = 0;
      for (const n of notes) if (laneOf(lanes, n.midi + s) >= 0) count++;
      if (count > bestCount) {
        best = s;
        bestCount = count;
      }
      if (count === notes.length) break;
    }
    this.shift = best;
    this.st!.onLanes = bestCount === notes.length;
    this.pendingMidi = -1;
    this.refreshNotes();
  }

  /** Target + ribbon notes. Runs when the target or the lanes change, not every frame. */
  private refreshNotes(): void {
    const st = this.st!;
    const notes = this.song!.notes;
    const up: LearnNote[] = [];
    for (let k = st.index; k < st.total && up.length < RIBBON; k++) {
      const midi = notes[k]!.midi + this.shift;
      const lane = laneOf(this.lanes, midi);
      // The lane's own name, so the ribbon spells notes like the lanes do (Bb vs A#).
      up.push({ midi, note: lane >= 0 ? this.lanes[lane]!.note : noteName(midi), laneIndex: lane, beats: notes[k]!.beats });
    }
    st.upcoming = up;
    st.target = up[0] ?? null;
    st.targetStartMs = st.index < st.total ? this.starts[st.index]! : this.songEndMs;
    st.progress = st.total ? st.index / st.total : 1;
  }
}

function laneOf(lanes: readonly Lane[], midi: number): number {
  for (let i = 0; i < lanes.length; i++) if (lanes[i]!.midi === midi) return i;
  return -1;
}
